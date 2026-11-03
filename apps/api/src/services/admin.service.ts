import type { Redis } from 'ioredis';

import {
  API_RATE_LIMIT_KEY_PREFIX,
  DeadLetterJobSchema,
  NotFoundError,
  SOURCES,
  UnavailableError,
  ValidationError,
  WINDOWS,
  jobId,
  redisKeys,
  scoringSlot,
  type IngestJob,
  type Source,
} from '@trendr/core';
import {
  getRun,
  listRuns as listRunRows,
  patchItemAdmin,
  recordAdminAudit,
  type Db,
  type RunRow,
} from '@trendr/db';
import { BUCKET_NAMES, bucketSpec, githubCoreBucketSpec, type BucketName } from '@trendr/sources';

import type { ApiQueues } from '../queues.js';
import { AdminDlqCursor, AdminRunsCursor, ADMIN_PAGE_SIZE } from '../schemas/admin.js';
import type {
  AdminDlqJobBody,
  AdminDlqResponseBody,
  AdminDlqRetryResponseBody,
  AdminIngestBodyInput,
  AdminIngestResponseBody,
  AdminItemPatchInput,
  AdminItemPatchResponseBody,
  AdminQueuesResponseBody,
  AdminRateLimitsResponseBody,
  AdminRunDetailBody,
  AdminRunSummaryBody,
  AdminRunsQueryInput,
  AdminRunsResponseBody,
  AdminScoreResponseBody,
} from '../schemas/admin.js';
import { decodeCursor, encodeCursor } from '../schemas/common.js';

/**
 * Spec §10.1 `/v1/admin/*` — business logic, framework-free: jobs are enqueued
 * through `ApiQueues`, runs/flags go through the `@trendr/db` repositories and
 * the rate-limit view reads the §7.4/§10.5 Redis keys. Routes own validation
 * and HTTP mapping only.
 */

export interface AdminDeps {
  db: Db;
  redis: Redis;
  queues: ApiQueues;
  /** Best-effort cache invalidation (§9.3); omitted in unit tests. */
  invalidate?: (...keys: string[]) => Promise<void>;
  now?: () => Date;
}

/** UTC calendar day `YYYY-MM-DD` (job ids, §5.2). */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** §5.2 ten-minute slot shared with scoring/ingest idempotency keys. */
export function tenMinuteSlot(at: Date): string {
  return scoringSlot(at);
}

export interface AdminIngestTrigger {
  id: string;
  /** BullMQ job name (§17). */
  name: string;
  job: IngestJob;
}

/** Pure mapping of the §10.1 ingest body to a deterministic job (unit-tested). */
export function buildAdminIngestJob(
  body: AdminIngestBodyInput,
  slot: string,
  day: string,
): AdminIngestTrigger {
  switch (body.type) {
    case 'discover':
      return {
        id: jobId.discover(body.source, body.strategy, slot),
        name: 'discover',
        job: {
          type: 'discover',
          source: body.source,
          strategy: body.strategy,
          maxItems: body.maxItems,
          trigger: 'manual',
        },
      };
    case 'snapshot':
      // The §7.2 snapshot row is a fan-out; a manual "snapshot this tier"
      // must cover every batch, so it enqueues the same fan-out payload.
      return {
        id: jobId.snapshotFanout(body.source, body.tier, slot),
        name: 'snapshot-fanout',
        job: { type: 'snapshot-fanout', source: body.source, tier: body.tier, trigger: 'manual' },
      };
    case 'daily':
      return {
        id: jobId.daily(body.source, day),
        name: 'daily',
        job: { type: 'daily', source: body.source, day, trigger: 'manual' },
      };
    case 'backfill':
      return {
        id: jobId.backfill(body.source, body.itemId, day),
        name: 'backfill',
        job: {
          type: 'backfill',
          source: body.source,
          itemId: body.itemId,
          days: body.days,
          trigger: 'manual',
        },
      };
    case 'refresh-item':
      return {
        id: jobId.refreshItem(body.source, body.itemId, day),
        name: 'refresh-item',
        job: {
          type: 'refresh-item',
          source: body.source,
          itemId: body.itemId,
          trigger: 'manual',
        },
      };
  }
}

export async function triggerIngest(
  deps: AdminDeps,
  body: AdminIngestBodyInput,
  actorUserId: string | null,
): Promise<AdminIngestResponseBody> {
  const at = deps.now?.() ?? new Date();
  const trigger = buildAdminIngestJob(body, tenMinuteSlot(at), utcDay(at));
  const queue = deps.queues.ingest[body.source];
  await queue.add(trigger.name, trigger.job, { jobId: trigger.id });
  // M-6: the enqueue is not transactional with Postgres; the audit row is
  // written immediately after it succeeds.
  await recordAdminAudit(deps.db, {
    actorUserId,
    action: 'ingest.trigger',
    target: trigger.id,
    payload: { ...body, type: trigger.name },
  });
  return { jobId: trigger.id, queue: queue.name };
}

/** Spec §10.1 `POST /v1/admin/score` — `{source}` or `all`, 202 with the jobs. */
export async function triggerScore(
  deps: AdminDeps,
  source: Source | 'all',
  actorUserId: string | null,
): Promise<AdminScoreResponseBody> {
  const slot = tenMinuteSlot(deps.now?.() ?? new Date());
  const sources: Source[] = source === 'all' ? [...SOURCES] : [source];
  const jobs: AdminScoreResponseBody['jobs'] = [];

  for (const each of sources) {
    const id = jobId.scoring(each, slot);
    await deps.queues.scoring.add(
      'compute-scores',
      { source: each, windows: [...WINDOWS], trigger: 'admin' },
      { jobId: id },
    );
    jobs.push({ source: each, jobId: id, queue: deps.queues.scoring.name });
  }
  await recordAdminAudit(deps.db, {
    actorUserId,
    action: 'score.trigger',
    target: source,
    payload: { sources: jobs.map((job) => job.source), windows: [...WINDOWS] },
  });
  return { jobs };
}

function toRunSummary(row: RunRow): AdminRunSummaryBody {
  return {
    id: row.id.toString(),
    source: row.source,
    jobType: row.jobType,
    jobId: row.jobId,
    attempt: row.attempt,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    itemsSeen: row.itemsSeen,
    itemsUpserted: row.itemsUpserted,
    itemsFailed: row.itemsFailed,
    apiCalls: row.apiCalls,
    notModified: row.notModified,
    rateLimitRemaining: row.rateLimitRemaining,
    error: row.error,
  };
}

/** Spec §10.1 `GET /v1/admin/runs` — newest first, keyset by run id. */
export async function listAdminRuns(
  deps: AdminDeps,
  query: AdminRunsQueryInput,
): Promise<AdminRunsResponseBody> {
  const beforeId =
    query.cursor === undefined ? undefined : BigInt(decodeCursor(query.cursor, AdminRunsCursor).k);
  const rows = await listRunRows(deps.db, {
    ...(query.source === undefined ? {} : { source: query.source }),
    ...(query.jobType === undefined ? {} : { jobType: query.jobType }),
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.from === undefined ? {} : { from: new Date(query.from) }),
    ...(beforeId === undefined ? {} : { beforeId }),
    limit: ADMIN_PAGE_SIZE + 1,
  });
  const page = rows.slice(0, ADMIN_PAGE_SIZE);
  const last = page.at(-1);
  return {
    runs: page.map(toRunSummary),
    page: {
      nextCursor:
        rows.length > ADMIN_PAGE_SIZE && last !== undefined
          ? encodeCursor({ k: last.id.toString() })
          : null,
      limit: ADMIN_PAGE_SIZE,
    },
  };
}

/** Spec §10.1 `GET /v1/admin/runs/:runId`. */
export async function getAdminRun(deps: AdminDeps, runId: bigint): Promise<AdminRunDetailBody> {
  const row = await getRun(deps.db, runId);
  if (row === null) {
    throw new NotFoundError('run not found');
  }
  return { ...toRunSummary(row), params: row.params };
}

/** Spec §10.1 `GET /v1/admin/queues` — per-queue counts across every §5.2 queue. */
export async function listQueueCounts(deps: AdminDeps): Promise<AdminQueuesResponseBody> {
  const entries = await Promise.all(
    deps.queues.all().map(async (queue) => {
      const counts = await queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'failed',
        'completed',
      );
      const of = (key: string): number => counts[key] ?? 0;
      return {
        name: queue.name,
        counts: {
          waiting: of('waiting'),
          active: of('active'),
          delayed: of('delayed'),
          failed: of('failed'),
          completed: of('completed'),
        },
      };
    }),
  );
  return { queues: entries };
}

function toDlqJob(
  id: string,
  raw: unknown,
  fallbackName: string,
  fallbackTimestamp: number,
): AdminDlqJobBody {
  const parsed = DeadLetterJobSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      id,
      originalQueue: 'unknown',
      name: fallbackName,
      jobId: null,
      failedReason: 'invalid dead-letter payload',
      attemptsMade: 0,
      failedAt: new Date(fallbackTimestamp).toISOString(),
      data: raw,
    };
  }
  const entry = parsed.data;
  return {
    id,
    originalQueue: entry.originalQueue,
    name: entry.name,
    jobId: entry.jobId ?? null,
    failedReason: entry.failedReason,
    attemptsMade: entry.attemptsMade,
    failedAt: entry.failedAt,
    data: entry.data,
  };
}

/** Spec §10.1 `GET /v1/admin/dlq` — newest first, offset cursor. */
export async function listDlq(deps: AdminDeps, cursor?: string): Promise<AdminDlqResponseBody> {
  const offset = cursor === undefined ? 0 : decodeCursor(cursor, AdminDlqCursor).o;
  const jobs = await deps.queues.deadLetter.getJobs(
    ['waiting'],
    offset,
    offset + ADMIN_PAGE_SIZE, // one extra row detects a next page
    false,
  );
  const page = jobs.slice(0, ADMIN_PAGE_SIZE);
  return {
    jobs: page.map((job) => toDlqJob(job.id ?? '', job.data, job.name, job.timestamp)),
    page: {
      nextCursor:
        jobs.length > ADMIN_PAGE_SIZE ? encodeCursor({ o: offset + ADMIN_PAGE_SIZE }) : null,
      limit: ADMIN_PAGE_SIZE,
    },
  };
}

/**
 * Spec §10.1/§7.7 `POST /v1/admin/dlq/:jobId/retry` — re-add the payload to its
 * original queue with a `.retry{n}` jobId suffix (n counted in Redis) and drop
 * the DLQ entry. The replay keeps the worker's §7.5 retry policy.
 */
export async function retryDlq(
  deps: AdminDeps,
  dlqJobId: string,
  actorUserId: string | null,
): Promise<AdminDlqRetryResponseBody> {
  const job = await deps.queues.deadLetter.getJob(dlqJobId);
  if (job === undefined) {
    throw new NotFoundError('dead-letter job not found');
  }
  const parsed = DeadLetterJobSchema.safeParse(job.data);
  if (!parsed.success) {
    throw new ValidationError('dead-letter payload is not replayable');
  }
  const entry = parsed.data;
  const target = deps.queues.byName(entry.originalQueue);
  if (target === undefined) {
    throw new ValidationError(`unknown queue '${entry.originalQueue}'`);
  }

  const counterKey = redisKeys.dlqRetry(dlqJobId);
  const attempt = await deps.redis.incr(counterKey);
  await deps.redis.expire(counterKey, 30 * 86_400);
  const newJobId = `${entry.jobId ?? `dlq-${dlqJobId}`}.retry${attempt}`;
  await target.add(entry.name, entry.data, { jobId: newJobId });
  await job.remove();
  await recordAdminAudit(deps.db, {
    actorUserId,
    action: 'dlq.retry',
    target: dlqJobId,
    payload: { queue: entry.originalQueue, jobId: newJobId },
  });
  return { queue: entry.originalQueue, jobId: newJobId };
}

/** Spec §10.1 `DELETE /v1/admin/dlq/:jobId` — discard without replay. */
export async function deleteDlq(
  deps: AdminDeps,
  dlqJobId: string,
  actorUserId: string | null,
): Promise<void> {
  const job = await deps.queues.deadLetter.getJob(dlqJobId);
  if (job === undefined) {
    throw new NotFoundError('dead-letter job not found');
  }
  await job.remove();
  await recordAdminAudit(deps.db, {
    actorUserId,
    action: 'dlq.discard',
    target: dlqJobId,
  });
}

/** SCAN in batches; admin views must not KEYS a shared Redis (spec §9.1). */
async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

function bucketLimits(name: string): { capacity: number; refillPerSec: number } | null {
  const tokenBucket = /^github:core:(\d+)$/.exec(name);
  if (tokenBucket !== null) {
    return githubCoreBucketSpec(Number(tokenBucket[1]));
  }
  if ((BUCKET_NAMES as readonly string[]).includes(name)) {
    return bucketSpec(name as BucketName);
  }
  return null;
}

/** Spec §10.1 `GET /v1/admin/rate-limits` — bucket states + last upstream headers. */
export async function getRateLimits(deps: AdminDeps): Promise<AdminRateLimitsResponseBody> {
  const now = deps.now?.() ?? new Date();
  const [apiKeys, rateKeys] = await Promise.all([
    scanKeys(deps.redis, `${API_RATE_LIMIT_KEY_PREFIX}*`),
    scanKeys(deps.redis, 'rl:*'),
  ]);

  interface ApiBucketState {
    key: string;
    count: number;
    ttlMs: number | null;
  }
  const api = (
    await Promise.all(
      apiKeys.sort().map(async (key): Promise<ApiBucketState | null> => {
        const [value, ttl] = await Promise.all([deps.redis.get(key), deps.redis.pttl(key)]);
        if (value === null) {
          return null; // expired between SCAN and GET
        }
        return { key, count: Number(value), ttlMs: ttl < 0 ? null : ttl };
      }),
    )
  ).filter((entry): entry is ApiBucketState => entry !== null);

  interface BucketState {
    name: string;
    tokens: number;
    observedAtMs: number | null;
    pausedUntilMs: number | null;
  }
  const buckets = new Map<string, BucketState>();
  const upstream: AdminRateLimitsResponseBody['upstream'] = [];

  for (const key of rateKeys.sort()) {
    if (key.startsWith('rl:last:')) {
      const rest = key.slice('rl:last:'.length);
      const separator = rest.indexOf(':');
      if (separator <= 0) continue;
      const source = rest.slice(0, separator);
      const resource = rest.slice(separator + 1);
      if (!(SOURCES as readonly string[]).includes(source)) continue;
      const hash = await deps.redis.hgetall(key);
      const remaining = Number(hash.remaining);
      const observedAtMs = hash.observedAt === undefined ? Number.NaN : Date.parse(hash.observedAt);
      if (!Number.isFinite(remaining) || !Number.isFinite(observedAtMs)) continue;
      const resetAtMs = hash.resetAt === undefined ? Number.NaN : Date.parse(hash.resetAt);
      upstream.push({
        source: source as Source,
        resource,
        remaining,
        resetAt: Number.isFinite(resetAtMs) ? new Date(resetAtMs).toISOString() : null,
        observedAt: new Date(observedAtMs).toISOString(),
      });
      continue;
    }

    if (key.endsWith(':pause')) {
      const name = key.slice('rl:'.length, -':pause'.length);
      const value = Number(await deps.redis.get(key));
      if (!Number.isFinite(value) || value <= 0) continue;
      const state = buckets.get(name) ?? {
        name,
        tokens: 0,
        observedAtMs: null,
        pausedUntilMs: null,
      };
      state.pausedUntilMs = value;
      buckets.set(name, state);
      continue;
    }

    const name = key.slice('rl:'.length);
    const hash = await deps.redis.hgetall(key);
    if (hash.tokens === undefined) continue;
    const state = buckets.get(name) ?? { name, tokens: 0, observedAtMs: null, pausedUntilMs: null };
    state.tokens = Number(hash.tokens);
    state.observedAtMs = hash.ts === undefined ? null : Number(hash.ts);
    buckets.set(name, state);
  }

  const bucketDtos = [...buckets.values()]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((state) => {
      const limits = bucketLimits(state.name);
      const elapsedSec =
        state.observedAtMs === null ? 0 : Math.max(0, (now.getTime() - state.observedAtMs) / 1000);
      const tokens =
        limits === null
          ? state.tokens
          : Math.min(limits.capacity, state.tokens + elapsedSec * limits.refillPerSec);
      return {
        name: state.name,
        capacity: limits?.capacity ?? null,
        refillPerSec: limits?.refillPerSec ?? null,
        tokens: Math.round(tokens * 100) / 100,
        observedAt: state.observedAtMs === null ? null : new Date(state.observedAtMs).toISOString(),
        pausedUntil:
          state.pausedUntilMs === null ? null : new Date(state.pausedUntilMs).toISOString(),
      };
    });

  upstream.sort((a, b) =>
    a.source === b.source ? a.resource.localeCompare(b.resource) : a.source.localeCompare(b.source),
  );

  return { api, buckets: bucketDtos, upstream };
}

/** Spec §10.1 `PATCH /v1/admin/items/:id` — tier/flags patch + cache invalidation. */
export async function patchAdminItem(
  deps: AdminDeps,
  itemId: bigint,
  patch: AdminItemPatchInput,
  actorUserId: string | null,
): Promise<AdminItemPatchResponseBody> {
  const row = await patchItemAdmin(
    deps.db,
    itemId,
    {
      ...(patch.tier === undefined ? {} : { tier: patch.tier }),
      ...(patch.addFlags === undefined ? {} : { addFlags: patch.addFlags }),
      ...(patch.removeFlags === undefined ? {} : { removeFlags: patch.removeFlags }),
    },
    {
      actorUserId,
      payload: { requested: patch },
    },
  );
  if (row === null) {
    throw new NotFoundError('item not found');
  }
  // L-8: an item edit must not wait for the next scoring run to be visible.
  // Drop the detail, every card and the board metadata for the item's source
  // (and the combined board), so the next leaderboard read falls back to SQL.
  const invalidated = [redisKeys.item(row.id)];
  for (const window of WINDOWS) {
    invalidated.push(
      redisKeys.card(row.id, window),
      redisKeys.leaderboardMeta(row.source, window),
      redisKeys.leaderboardMeta('all', window),
    );
  }
  await deps.invalidate?.(...invalidated);
  return {
    id: row.id.toString(),
    tier: row.tier,
    flags: row.flags,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Routes call this once per request; a missing dependency is a deployment error. */
export function resolveAdminQueues(
  hasDb: boolean,
  hasRedis: boolean,
  queues: ApiQueues | undefined,
): ApiQueues {
  if (!hasDb || !hasRedis || queues === undefined) {
    throw new UnavailableError('admin endpoints require database, redis and queue connections');
  }
  return queues;
}
