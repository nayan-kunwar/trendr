import { randomUUID } from 'node:crypto';

import type { Queue } from 'bullmq';
import { eq, like, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  QUEUE,
  SOURCES,
  hashApiKey,
  redisKeys,
  type DeadLetterJob,
  type IngestJob,
  type Source,
} from '@trendr/core';
import {
  apiKeys,
  createDb,
  finishRun,
  ingestionRuns,
  items,
  startRun,
  upsertItems,
  users,
  type Connection,
} from '@trendr/db';

import { buildApp } from '../../src/app.js';
import { createApiQueues, type ApiQueues } from '../../src/queues.js';

/**
 * Task 4.6 acceptance over real Postgres + Redis + BullMQ: the §10.1 admin
 * endpoints reject anonymous (401) and non-admin (403) callers, while an admin
 * JWT and an admin-scope API key can trigger ingest/score jobs, browse runs and
 * queues, inspect rate-limit state, patch items (invalidating `item:{id}`) and
 * replay/discard dead-letter entries with the §7.7 `.retry{n}` suffix.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const REDIS_URL = process.env.REDIS_URL ?? '';

const PEPPER = 'int-admin-pepper-0123456789abcdef';
const JWT_SECRET = 'int-admin-jwt-secret-0123456789abcdef';
const EMAIL_PREFIX = 'int-admin-';
const ITEM_PREFIX = 'int-admin/';
const RUN_JOB_PREFIX = 'int-admin.run.';
const SECRET_SUFFIX = 'abcdef0123456789abcdef0123456789';
const DEPS = {
  corsOrigins: ['http://localhost:3000'],
  metricsToken: 'int-admin-metrics-token',
  // Generous anonymous budget so this file cannot inherit the 3.5 exhaustion.
  rateLimit: { max: 1_000 },
  jwtSecret: JWT_SECRET,
  apiKeyPepper: PEPPER,
};

function keyMaterial(n: number): { raw: string; prefix: string } {
  const prefix = `dt_live_intadm${String(n).padStart(2, '0')}`;
  return { raw: `${prefix}_${SECRET_SUFFIX}`, prefix };
}

const adminKey = keyMaterial(1);
const readKey = keyMaterial(2);
const TEST_BUCKET = 'int-admin:custom';
const TEST_API_KEY = 'apirl:ip:int-admin-test';

let connection: Connection;
let redis: Redis;
let queueRedis: Redis;
let queues: ApiQueues;
let app: FastifyInstance;
let adminUserId = '';
let userId = '';
let runId = 0n;
let itemId = 0n;
const createdJobs: { queue: Queue; id: string }[] = [];

beforeAll(async () => {
  connection = createDb(DATABASE_URL, { max: 2 });
  redis = new Redis(REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  queueRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await cleanupDb();
  await cleanupRedis();

  const db = connection.db;
  const insertedUsers = await db
    .insert(users)
    .values([
      { email: `${EMAIL_PREFIX}${randomUUID()}@example.test`, displayName: 'Int admin' },
      { email: `${EMAIL_PREFIX}${randomUUID()}@example.test`, displayName: 'Int user' },
    ])
    .returning({ id: users.id });
  adminUserId = insertedUsers[0]?.id ?? '';
  userId = insertedUsers[1]?.id ?? '';
  if (adminUserId === '' || userId === '') {
    throw new Error('failed to insert int admin users');
  }

  await db.insert(apiKeys).values([
    {
      userId: adminUserId,
      name: 'int admin key',
      prefix: adminKey.prefix,
      keyHash: hashApiKey(PEPPER, adminKey.raw),
      scopes: ['read', 'admin'],
    },
    {
      userId,
      name: 'int read key',
      prefix: readKey.prefix,
      keyHash: hashApiKey(PEPPER, readKey.raw),
      scopes: ['read'],
    },
  ]);

  runId = await startRun(db, {
    source: 'github',
    jobType: 'snapshot',
    jobId: `${RUN_JOB_PREFIX}${randomUUID()}`,
    params: { tier: 'hot', batch: 0 },
  });
  await finishRun(db, runId, { status: 'succeeded', itemsSeen: 5, itemsUpserted: 4, apiCalls: 2 });

  const [item] = await upsertItems(
    db,
    [
      {
        source: 'github',
        kind: 'repo',
        externalId: `${ITEM_PREFIX}patch-me`,
        upstreamId: null,
        name: 'int-admin-patch-me',
        displayName: 'Int admin patch me',
        description: null,
        url: 'https://github.com/int-admin/patch-me',
        homepage: null,
        language: 'TypeScript',
        license: 'MIT',
        owner: 'int-admin',
        primaryMetric: 'stars',
        upstreamCreatedAt: new Date('2024-01-01T00:00:00.000Z'),
        isArchived: false,
        metadata: {},
        flags: ['fork'],
      },
    ],
    { newItemTier: 'cold' },
  );
  if (item === undefined) {
    throw new Error('failed to insert int admin item');
  }
  itemId = item.id;

  queues = createApiQueues(queueRedis);
  app = await buildApp({ ...DEPS, db: connection, redis, queueConnection: queueRedis });
  await app.ready();
});

afterAll(async () => {
  for (const { queue, id } of createdJobs) {
    await queue.remove(id).catch(() => undefined);
  }
  const leftoverJobs = await queues.deadLetter.getJobs(['waiting'], 0, 1_000, true);
  for (const job of leftoverJobs) {
    if (job.id?.startsWith('int-admin') === true) {
      await job.remove();
    }
  }
  await app.close();
  await queues.close();
  await cleanupDb();
  await cleanupRedis();
  await connection.pool.end();
  redis.disconnect();
  queueRedis.disconnect();
});

async function cleanupDb(): Promise<void> {
  const db = connection.db;
  await db.delete(apiKeys).where(like(apiKeys.prefix, 'dt_live_intadm%'));
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
  await db.delete(items).where(like(items.externalId, `${ITEM_PREFIX}%`));
  await db.execute(
    sql`DELETE FROM scores WHERE run_id IN (SELECT id FROM ingestion_runs WHERE job_id LIKE ${`${RUN_JOB_PREFIX}%`})`,
  );
  await db.delete(ingestionRuns).where(like(ingestionRuns.jobId, `${RUN_JOB_PREFIX}%`));
}

async function cleanupRedis(): Promise<void> {
  await redis.del(TEST_API_KEY, `rl:${TEST_BUCKET}`, `rl:${TEST_BUCKET}:pause`);
  await redis.del(redisKeys.rateLimitLast('github', 'search'));
  await redis.del(redisKeys.item(itemId));
}

function signToken(payload: { sub: string; role: 'user' | 'admin' }): string {
  // Signed with the app's registered defaults (iss/aud/exp, §10.5).
  return app.jwt.sign(payload);
}

function asAdminJwt(): string {
  // Signed by the app's own @fastify/jwt instance: same secret, iss/aud/exp.
  return signToken({ sub: adminUserId, role: 'admin' });
}

function asUserJwt(): string {
  return signToken({ sub: userId, role: 'user' });
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('admin endpoints (task 4.6, spec §10.1/§10.5)', () => {
  it('rejects anonymous and non-admin callers with 401/403', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/v1/admin/queues' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['content-type']).toContain('application/problem+json');

    const invalidToken = await app.inject({
      method: 'GET',
      url: '/v1/admin/queues',
      headers: bearer('not-a-jwt'),
    });
    expect(invalidToken.statusCode).toBe(401);

    const userJwt = await app.inject({
      method: 'GET',
      url: '/v1/admin/queues',
      headers: bearer(asUserJwt()),
    });
    expect(userJwt.statusCode).toBe(403);
    expect(userJwt.json<{ type: string }>().type).toBe('https://trendr.dev/problems/forbidden');

    const readScope = await app.inject({
      method: 'GET',
      url: '/v1/admin/queues',
      headers: { 'x-api-key': readKey.raw },
    });
    expect(readScope.statusCode).toBe(403);

    const adminKeyResponse = await app.inject({
      method: 'GET',
      url: '/v1/admin/queues',
      headers: { 'x-api-key': adminKey.raw },
    });
    expect(adminKeyResponse.statusCode).toBe(200);
  });

  it('serves runs newest-first with filters, detail and 404 problem+json', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/v1/admin/runs?source=github&jobType=snapshot',
      headers: bearer(asAdminJwt()),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{
      runs: { id: string; jobType: string }[];
      page: { nextCursor: string | null; limit: number };
    }>();
    expect(body.page.limit).toBe(50);
    const seeded = body.runs.find((run) => run.id === runId.toString());
    expect(seeded).toBeDefined();
    expect(seeded?.jobType).toBe('snapshot');

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/v1/admin/runs/${runId.toString()}`,
      headers: bearer(asAdminJwt()),
    });
    expect(detailResponse.statusCode).toBe(200);
    expect(
      detailResponse.json<{ params: Record<string, unknown>; itemsSeen: number }>(),
    ).toMatchObject({ params: { tier: 'hot', batch: 0 }, itemsSeen: 5 });

    const missing = await app.inject({
      method: 'GET',
      url: '/v1/admin/runs/9223372036854775807',
      headers: bearer(asAdminJwt()),
    });
    expect(missing.statusCode).toBe(404);

    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/admin/runs?status=bogus',
      headers: bearer(asAdminJwt()),
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('enqueues manual ingest and score jobs with deterministic ids', async () => {
    const discover = await app.inject({
      method: 'POST',
      url: '/v1/admin/ingest',
      headers: bearer(asAdminJwt()),
      payload: { type: 'discover', source: 'github', strategy: 'manual-check', maxItems: 10 },
    });
    expect(discover.statusCode).toBe(202);
    const discoverBody = discover.json<{ jobId: string; queue: string }>();
    expect(discoverBody.queue).toBe(QUEUE.ingest.github);
    expect(discoverBody.jobId).toMatch(/^github\.discover\.manual-check\./);
    const discoverJob = await queues.ingest.github.getJob(discoverBody.jobId);
    expect(discoverJob?.data).toMatchObject({ trigger: 'manual', maxItems: 10 });
    createdJobs.push({ queue: queues.ingest.github, id: discoverBody.jobId });

    const snapshot = await app.inject({
      method: 'POST',
      url: '/v1/admin/ingest',
      headers: bearer(asAdminJwt()),
      payload: { type: 'snapshot', source: 'github', tier: 'warm' },
    });
    expect(snapshot.statusCode).toBe(202);
    const snapshotBody = snapshot.json<{ jobId: string; queue: string }>();
    expect(snapshotBody.jobId).toContain('.snapshot-fanout.warm.');
    const snapshotJob = await queues.ingest.github.getJob(snapshotBody.jobId);
    expect(snapshotJob?.name).toBe('snapshot-fanout');
    expect(snapshotJob?.data).toMatchObject({ type: 'snapshot-fanout', tier: 'warm' });
    createdJobs.push({ queue: queues.ingest.github, id: snapshotBody.jobId });

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/admin/ingest',
      headers: bearer(asAdminJwt()),
      payload: { type: 'snapshot', source: 'github' },
    });
    expect(invalid.statusCode).toBe(400);

    const score = await app.inject({
      method: 'POST',
      url: '/v1/admin/score',
      headers: bearer(asAdminJwt()),
      payload: { source: 'all' },
    });
    expect(score.statusCode).toBe(202);
    const scoreBody = score.json<{ jobs: { source: Source; jobId: string; queue: string }[] }>();
    expect(scoreBody.jobs).toHaveLength(SOURCES.length);
    for (const job of scoreBody.jobs) {
      expect(job.queue).toBe(QUEUE.scoring);
      expect(job.jobId).toMatch(
        new RegExp(`^score\\.${job.source}\\.\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}$`),
      );
      const queued = await queues.scoring.getJob(job.jobId);
      expect(queued).toBeDefined();
      expect(queued?.data.source).toBe(job.source);
      // §5.2 dedupe: an ingest/scheduled run inside the same 10-minute slot may
      // already own the id, in which case the add is a no-op and the earlier
      // payload (and its owner) must be left untouched by the cleanup.
      if (queued?.data.trigger === 'admin') {
        createdJobs.push({ queue: queues.scoring, id: job.jobId });
      }
    }
  });

  it('reports queue counts and the §7.4/§10.5 rate-limit state', async () => {
    const queuesResponse = await app.inject({
      method: 'GET',
      url: '/v1/admin/queues',
      headers: bearer(asAdminJwt()),
    });
    expect(queuesResponse.statusCode).toBe(200);
    const names = queuesResponse
      .json<{ queues: { name: string }[] }>()
      .queues.map((queue) => queue.name);
    expect(names).toEqual(
      expect.arrayContaining([
        ...Object.values(QUEUE.ingest),
        QUEUE.scoring,
        QUEUE.notify,
        QUEUE.digest,
        QUEUE.maintenance,
        QUEUE.deadLetter,
      ]),
    );

    const observedAt = new Date('2026-10-19T10:00:00.000Z');
    const resetAt = new Date('2026-10-19T11:00:00.000Z');
    const pausedUntil = new Date(Date.now() + 60_000);
    await redis.set(TEST_API_KEY, '3', 'EX', 60);
    await redis.hset(`rl:${TEST_BUCKET}`, { tokens: '7', ts: String(Date.now()) });
    await redis.set(`rl:${TEST_BUCKET}:pause`, String(pausedUntil.getTime()));
    await redis.hset(redisKeys.rateLimitLast('github', 'search'), {
      remaining: '42',
      resetAt: resetAt.toISOString(),
      observedAt: observedAt.toISOString(),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/rate-limits',
      headers: bearer(asAdminJwt()),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      api: { key: string; count: number; ttlMs: number | null }[];
      buckets: {
        name: string;
        capacity: number | null;
        refillPerSec: number | null;
        tokens: number;
        pausedUntil: string | null;
      }[];
      upstream: { source: string; resource: string; remaining: number; resetAt: string | null }[];
    }>();

    expect(body.api.find((bucket) => bucket.key === TEST_API_KEY)).toMatchObject({ count: 3 });
    const bucket = body.buckets.find((entry) => entry.name === TEST_BUCKET);
    expect(bucket).toMatchObject({ capacity: null, refillPerSec: null, tokens: 7 });
    expect(bucket?.pausedUntil).toBe(pausedUntil.toISOString());
    expect(body.upstream.find((entry) => entry.resource === 'search')).toMatchObject({
      source: 'github',
      remaining: 42,
      resetAt: resetAt.toISOString(),
    });
  });

  it('patches item tier/flags and invalidates the cached detail', async () => {
    await redis.set(redisKeys.item(itemId), JSON.stringify({ stale: true }), 'EX', 300);
    // L-8: an edit must also drop the cards and board metadata so the next
    // leaderboard read is served from SQL instead of a stale cache.
    const staleKeys = [
      redisKeys.card(itemId, '24h'),
      redisKeys.leaderboardMeta('github', '24h'),
      redisKeys.leaderboardMeta('all', '7d'),
    ];
    for (const key of staleKeys) {
      await redis.set(key, JSON.stringify({ stale: true }), 'EX', 300);
    }

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/items/${itemId.toString()}`,
      headers: bearer(asAdminJwt()),
      payload: { tier: 'hot', addFlags: ['manual_hidden'], removeFlags: ['fork'] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ tier: string; flags: string[] }>()).toMatchObject({
      tier: 'hot',
      flags: ['manual_hidden'],
    });

    const [row] = await connection.db
      .select({ tier: items.tier, flags: items.flags })
      .from(items)
      .where(eq(items.id, itemId));
    expect(row).toMatchObject({ tier: 'hot', flags: ['manual_hidden'] });
    expect(await redis.get(redisKeys.item(itemId))).toBeNull();
    for (const key of staleKeys) {
      expect(await redis.get(key), `${key} was invalidated`).toBeNull();
    }

    const invalidFlag = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/items/${itemId.toString()}`,
      headers: bearer(asAdminJwt()),
      payload: { addFlags: ['not-a-flag'] },
    });
    expect(invalidFlag.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'PATCH',
      url: '/v1/admin/items/9223372036854775807',
      headers: bearer(asAdminJwt()),
      payload: { tier: 'cold' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('lists, replays and discards dead-letter jobs (admin-scope key)', async () => {
    const baseId = `int-admin-dlq-${randomUUID()}`;
    const payload: IngestJob = {
      type: 'discover',
      source: 'github',
      strategy: 'dlq-retry',
      maxItems: 5,
      trigger: 'manual',
    };
    const entry: DeadLetterJob = {
      originalQueue: QUEUE.ingest.github,
      name: 'discover',
      data: payload,
      jobId: `${baseId}.original`,
      failedReason: 'upstream exploded',
      attemptsMade: 5,
      failedAt: new Date().toISOString(),
    };
    await queues.deadLetter.add('dlq.ingest-github.int-admin', entry, { jobId: baseId });

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/admin/dlq',
      headers: { 'x-api-key': adminKey.raw },
    });
    expect(listed.statusCode).toBe(200);
    const listedBody = listed.json<{
      jobs: { id: string; originalQueue: string; failedReason: string }[];
      page: { limit: number };
    }>();
    expect(listedBody.page.limit).toBe(50);
    expect(listedBody.jobs.find((job) => job.id === baseId)).toMatchObject({
      originalQueue: QUEUE.ingest.github,
      failedReason: 'upstream exploded',
    });

    const retried = await app.inject({
      method: 'POST',
      url: `/v1/admin/dlq/${baseId}/retry`,
      headers: { 'x-api-key': adminKey.raw },
    });
    expect(retried.statusCode).toBe(202);
    const retriedBody = retried.json<{ queue: string; jobId: string }>();
    expect(retriedBody.queue).toBe(QUEUE.ingest.github);
    expect(retriedBody.jobId).toBe(`${baseId}.original.retry1`);
    createdJobs.push({ queue: queues.ingest.github, id: retriedBody.jobId });

    const replay = await queues.ingest.github.getJob(retriedBody.jobId);
    expect(replay?.data).toEqual(payload);
    expect(await queues.deadLetter.getJob(baseId)).toBeUndefined();

    const retryAgain = await app.inject({
      method: 'POST',
      url: `/v1/admin/dlq/${baseId}/retry`,
      headers: { 'x-api-key': adminKey.raw },
    });
    expect(retryAgain.statusCode).toBe(404);

    const discardId = `int-admin-dlq-${randomUUID()}`;
    await queues.deadLetter.add('dlq.ingest-github.int-admin', entry, { jobId: discardId });
    const discarded = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/dlq/${discardId}`,
      headers: { 'x-api-key': adminKey.raw },
    });
    expect(discarded.statusCode).toBe(204);
    expect(await queues.deadLetter.getJob(discardId)).toBeUndefined();

    const discardAgain = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/dlq/${discardId}`,
      headers: { 'x-api-key': adminKey.raw },
    });
    expect(discardAgain.statusCode).toBe(404);
  });
});
