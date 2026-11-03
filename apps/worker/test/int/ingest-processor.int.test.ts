import { setTimeout as sleep } from 'node:timers/promises';

import { QueueEvents, type Job, type Worker } from 'bullmq';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { QUEUE, UpstreamError, jobId, type IngestJob } from '@trendr/core';
import {
  countTrackedItems,
  createDb,
  ingestionRuns,
  itemAliases,
  items,
  snapshots,
  upsertItems,
  upsertSnapshots,
  type Connection,
  type Db,
} from '@trendr/db';
import { createLogger } from '@trendr/logger';
import {
  registerAdapter,
  type FetchedItem,
  type NormalizedItem,
  type SourceAdapter,
} from '@trendr/sources';

import { bucketCapturedAt } from '../../src/ingestion/upsert.js';
import { createIngestWorker, type IngestResult } from '../../src/processors/ingest.processor.js';
import {
  closeQueues,
  createQueues,
  createWorkerConnection,
  type DeadLetterJob,
  type Queues,
} from '../../src/queues.js';

/**
 * Task 4.2 acceptance (spec §18): a job failing five times lands in the
 * `dead-letter` queue with its reason; a schema error (and any other
 * unrecoverable failure) goes straight to the DLQ after one attempt. A happy
 * snapshot run records `ingestion_runs`, upserts items + snapshots and
 * enqueues the §7.1-step-7 scoring job.
 *
 * Task 4.3 acceptance: a payload whose `upstream_id` matches a tracked row
 * with a new `external_id` renames it and keeps the old slug as an alias stub
 * (§5.4); a `304 Not Modified` item gets a continuity snapshot from
 * `items.latest_metrics` (§7.3.1) and is counted in `not_modified`.
 */

const PREFIX = 'int-ingest/';
const ITEM_PREFIX_PATTERN = `${PREFIX}%`;

const state = {
  failFetchMetrics: false,
  /** Refs answered `304 Not Modified` regardless of the prefix heuristic. */
  notModifiedRefs: new Set<string>(),
  /** Simulated upstream renames: old `external_id` → new `external_id`. */
  renames: new Map<string, string>(),
};

function itemUpsert(externalId: string, name: string, upstreamId: string | null = null) {
  return {
    source: 'github' as const,
    kind: 'repo' as const,
    externalId,
    upstreamId,
    name,
    displayName: externalId,
    description: null,
    url: `https://github.com/${externalId}`,
    homepage: null,
    language: null,
    license: null,
    owner: 'int-ingest',
    primaryMetric: 'stars' as const,
    upstreamCreatedAt: null,
    isArchived: false,
    metadata: {},
    flags: [],
  };
}

function fakeAdapter(): SourceAdapter {
  return {
    source: 'github',
    kinds: ['repo'],
    batchSize: 2,
    async *discover() {
      await Promise.resolve();
      yield [];
    },
    fetchMetrics: (_ctx, refs) => {
      if (state.failFetchMetrics) {
        return Promise.reject(new UpstreamError('upstream exploded', 'github', null, null, true));
      }
      const fetchedAt = new Date();
      return Promise.resolve(
        refs.map((ref) =>
          state.notModifiedRefs.has(ref.externalId) || !ref.externalId.startsWith(PREFIX)
            ? { ref, raw: null, fetchedAt, notModified: true }
            : { ref, raw: { name: 'fresh-widget' }, fetchedAt },
        ),
      );
    },
    normalize: (fetched: FetchedItem): NormalizedItem | null => {
      const externalId = fetched.ref.externalId;
      if (!externalId.startsWith(PREFIX)) return null;
      const renamed = state.renames.get(externalId) ?? externalId;
      return {
        item: {
          source: 'github',
          kind: 'repo',
          externalId: renamed,
          upstreamId: renamed === externalId ? null : `R_${renamed}`,
          name: 'fresh-widget',
          displayName: renamed,
          description: null,
          url: `https://github.com/${renamed}`,
          homepage: null,
          language: null,
          license: null,
          owner: 'int-ingest',
          topics: [],
          primaryMetric: 'stars',
          upstreamCreatedAt: null,
          isArchived: false,
          metadata: {},
        },
        snapshots: [{ metric: 'stars', value: 7 }],
        ...(externalId === `${PREFIX}widget` ? { latestMetrics: { downloads: 99 } } : {}),
        daily: [],
        aliases: [],
      };
    },
  };
}

let connection: Connection;
let db: Db;
let redis: Redis;
let bullRedis: Redis;
let queues: Queues;
let githubWorker: Worker;
let events: QueueEvents;
let redisUrl: string;
let logger: ReturnType<typeof createLogger>;

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  redisUrl = process.env.REDIS_URL ?? '';
  if (!databaseUrl || !redisUrl) {
    throw new Error('DATABASE_URL/REDIS_URL are missing — run through `pnpm test:int`');
  }
  connection = createDb(databaseUrl);
  db = connection.db;
  redis = new Redis(redisUrl);
  logger = createLogger({ service: 'worker', level: 'error' });

  registerAdapter(fakeAdapter());

  bullRedis = createWorkerConnection(redisUrl);
  queues = createQueues(bullRedis);
  events = new QueueEvents(QUEUE.ingest.github, { connection: createWorkerConnection(redisUrl) });
  await events.waitUntilReady();
  githubWorker = createIngestWorker('github', {
    deps: {
      db,
      redis,
      logger,
      scoringQueue: queues.scoring,
      hfRatePer5Min: 1_000,
      fanoutBatchItems: 2,
      ingestQueue: queues.ingest.github,
    },
    connection: bullRedis,
    concurrency: 1,
    settings: { backoffStrategy: () => 10 },
    deadLetter: queues.deadLetter,
  });
  await githubWorker.waitUntilReady();
});

afterAll(async () => {
  await githubWorker.close();
  await events.close();
  await cleanupRows();
  await closeQueues(queues);
  await redis.quit();
  await bullRedis.quit();
  await connection.pool.end();
});

async function cleanupRows(): Promise<void> {
  await db.execute(
    sql`DELETE FROM snapshots WHERE item_id IN (SELECT id FROM items WHERE external_id LIKE ${ITEM_PREFIX_PATTERN})`,
  );
  await db.execute(
    sql`DELETE FROM daily_metrics WHERE item_id IN (SELECT id FROM items WHERE external_id LIKE ${ITEM_PREFIX_PATTERN})`,
  );
  await db.execute(sql`DELETE FROM items WHERE external_id LIKE ${ITEM_PREFIX_PATTERN}`);
  await db.execute(sql`DELETE FROM ingestion_runs WHERE job_id LIKE 'int-ingest.%'`);
}

function requireJobId(job: { id?: string | undefined }): string {
  if (job.id === undefined) throw new Error('expected the job to have an id');
  return job.id;
}

async function poll<T>(
  check: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

function waitForDeadLetter(queueName: string, jobId: string): Promise<Job<DeadLetterJob>> {
  return poll(
    async () => (await queues.deadLetter.getJob(`dlq.${queueName}.${jobId}`)) ?? undefined,
    `dead-letter entry for ${jobId}`,
  );
}

function runsFor(jobId: string) {
  return db.select().from(ingestionRuns).where(eq(ingestionRuns.jobId, jobId));
}

describe('ingest processor (spec §7.1/§7.7)', () => {
  it('moves a schema-invalid payload straight to the dead-letter queue', async () => {
    const job = await queues.ingest.github.add('snapshot', {
      type: 'snapshot',
      source: 'github',
    } as unknown as IngestJob);
    const id = requireJobId(job);

    const entry = await waitForDeadLetter(QUEUE.ingest.github, id);
    expect(entry.data.failedReason).toContain('invalid ingest job payload');
    expect(entry.data.attemptsMade).toBe(1);

    const stored = await queues.ingest.github.getJob(id);
    expect(stored?.attemptsMade).toBe(1);
    // the payload was rejected before the run recorder opened anything
    expect(await runsFor(id)).toHaveLength(0);

    await entry.remove();
    await stored?.remove();
  });

  it('retries a failing job five times, then parks it with its reason', async () => {
    await upsertItems(db, [itemUpsert(`${PREFIX}fail-target`, 'fail-target')], {
      newItemTier: 'cold',
    });
    state.failFetchMetrics = true;
    try {
      const job = await queues.ingest.github.add(
        'snapshot',
        { type: 'snapshot', source: 'github', tier: 'cold', batch: 0, batchCount: 1 },
        { jobId: `int-ingest.fail.${Date.now()}` },
      );
      const id = requireJobId(job);

      const entry = await waitForDeadLetter(QUEUE.ingest.github, id);
      expect(entry.data.failedReason).toBe('upstream exploded');
      expect(entry.data.attemptsMade).toBe(5);

      const runs = await runsFor(id);
      expect(runs.map((row) => row.attempt).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
      for (const row of runs) {
        expect(row.status).toBe('failed');
        expect(row.error).toContain('upstream exploded');
      }

      const stored = await queues.ingest.github.getJob(id);
      expect(stored?.attemptsMade).toBe(5);

      await entry.remove();
      await stored?.remove();
    } finally {
      state.failFetchMetrics = false;
    }
  });

  it('treats a source without an adapter as unrecoverable', async () => {
    const npmWorker = createIngestWorker('npm', {
      deps: { db, redis, logger },
      connection: bullRedis,
      settings: { backoffStrategy: () => 10 },
      deadLetter: queues.deadLetter,
    });
    try {
      await npmWorker.waitUntilReady();
      const job = await queues.ingest.npm.add(
        'snapshot',
        { type: 'snapshot', source: 'npm', tier: 'cold', batch: 0, batchCount: 1 },
        { jobId: `int-ingest.no-adapter.${Date.now()}` },
      );
      const id = requireJobId(job);

      const entry = await waitForDeadLetter(QUEUE.ingest.npm, id);
      expect(entry.data.failedReason).toContain('no adapter registered for source "npm"');
      expect(entry.data.attemptsMade).toBe(1);

      const runs = await runsFor(id);
      expect(runs.map((row) => row.status)).toEqual(['failed']);

      await entry.remove();
      const stored = await queues.ingest.npm.getJob(id);
      await stored?.remove();
    } finally {
      await npmWorker.close();
    }
  });

  it('skips a scheduled job without an adapter instead of parking it (§18-4.4)', async () => {
    const npmWorker = createIngestWorker('npm', {
      deps: { db, redis, logger },
      connection: bullRedis,
      settings: { backoffStrategy: () => 10 },
      deadLetter: queues.deadLetter,
    });
    try {
      await npmWorker.waitUntilReady();
      const job = await queues.ingest.npm.add(
        'snapshot',
        {
          type: 'snapshot',
          source: 'npm',
          tier: 'cold',
          batch: 0,
          batchCount: 1,
          trigger: 'schedule',
        },
        { jobId: `int-ingest.skip.${Date.now()}` },
      );
      const id = requireJobId(job);

      const runs = await poll(async () => {
        const rows = await runsFor(id);
        return rows[0]?.status === 'skipped' ? rows : undefined;
      }, 'skipped run row');
      expect(runs[0]?.error).toContain('no adapter registered for source "npm"');

      await poll(async () => {
        const stored = await queues.ingest.npm.getJob(id);
        const state = await stored?.getState();
        return state === 'completed' ? state : undefined;
      }, 'skipped job to complete');

      // no retries, no DLQ: the job is a clean no-op until credentials exist
      expect(await queues.deadLetter.getJob(`dlq.${QUEUE.ingest.npm}.${id}`)).toBeUndefined();
      const stored = await queues.ingest.npm.getJob(id);
      await stored?.remove();
    } finally {
      await npmWorker.close();
    }
  });

  it('fans a tier out into deterministic snapshot batches (§7.2)', async () => {
    // warm is unused by the other cases, so the tier size is stable apart from
    // leftovers of earlier test files (counted consistently either way).
    const seeds = [`${PREFIX}fanout-a`, `${PREFIX}fanout-b`, `${PREFIX}fanout-c`];
    const stubId = `${PREFIX}fanout-stub`;
    await db.execute(
      sql`DELETE FROM snapshots WHERE item_id IN (SELECT id FROM items WHERE external_id LIKE ${ITEM_PREFIX_PATTERN} AND tier = 'warm')`,
    );
    await db.execute(
      sql`DELETE FROM items WHERE external_id IN (${seeds[0]}, ${seeds[1]}, ${seeds[2]}, ${stubId})`,
    );
    const created = await upsertItems(
      db,
      [
        ...seeds.map((externalId) => itemUpsert(externalId, externalId)),
        { ...itemUpsert(stubId, stubId), flags: ['stub'] },
      ],
      { newItemTier: 'warm' },
    );
    expect(created).toHaveLength(4);

    const expectedCount = await countTrackedItems(db, { source: 'github', tier: 'warm' });
    const expectedBatches = Math.ceil(expectedCount / 2);

    // retries within the same hour reuse job ids, so clear stale children from
    // an earlier failed attempt of this test before the fan-out runs.
    const slot = new Date().toISOString().slice(0, 13);
    for (let batch = 0; batch < expectedBatches; batch += 1) {
      const stale = await queues.ingest.github.getJob(
        jobId.snapshot('github', 'warm', slot, batch),
      );
      await stale?.remove();
    }

    const job = await queues.ingest.github.add(
      'snapshot-fanout',
      { type: 'snapshot-fanout', source: 'github', tier: 'warm', trigger: 'schedule' },
      { jobId: `int-ingest.fanout.${Date.now()}` },
    );
    const id = requireJobId(job);
    const result = (await job.waitUntilFinished(events, 30_000)) as IngestResult;
    expect(result.status).toBe('succeeded');
    expect(result.itemsSeen).toBe(0);

    const tickSlot = new Date(job.timestamp).toISOString().slice(0, 13);
    const children: (Job<IngestJob> | undefined)[] = [];
    for (let batch = 0; batch < expectedBatches; batch += 1) {
      const child = await queues.ingest.github.getJob(
        jobId.snapshot('github', 'warm', tickSlot, batch),
      );
      expect(child).toBeDefined();
      children.push(child);
    }
    for (const [batch, child] of children.entries()) {
      expect(child?.data).toMatchObject({
        type: 'snapshot',
        source: 'github',
        tier: 'warm',
        batch,
        batchCount: expectedBatches,
        trigger: 'schedule',
      });
      expect(child?.opts.delay ?? 0).toBe(0);
    }

    await poll(
      async () => {
        const states = await Promise.all(
          children.map(async (child) => (child === undefined ? 'missing' : child.getState())),
        );
        return states.every((value) => value === 'completed') ? states : undefined;
      },
      'fan-out children to complete',
      30_000,
    );

    // every tracked warm item got a snapshot; the alias stub did not
    for (const item of created.slice(0, 3)) {
      const points = await db.select().from(snapshots).where(eq(snapshots.itemId, item.id));
      expect(points.length).toBeGreaterThanOrEqual(1);
      expect(points.every((point) => point.value === 7)).toBe(true);
    }
    const stub = created[3];
    if (stub === undefined) throw new Error('stub upsert returned no row');
    const stubPoints = await db.select().from(snapshots).where(eq(snapshots.itemId, stub.id));
    expect(stubPoints).toHaveLength(0);

    const runs = await runsFor(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('succeeded');
    expect(runs[0]?.itemsSeen).toBe(0);

    for (const child of children) {
      await child?.remove();
    }
    const stored = await queues.ingest.github.getJob(id);
    await stored?.remove();
  });

  it('snapshots a tracked item, records the run and enqueues scoring', async () => {
    const externalId = `${PREFIX}widget`;
    const [created] = await upsertItems(db, [itemUpsert(externalId, 'stale-widget')], {
      newItemTier: 'hot',
    });
    if (created === undefined) throw new Error('item upsert returned no row');

    const job = await queues.ingest.github.add(
      'snapshot',
      { type: 'snapshot', source: 'github', tier: 'hot', batch: 0, batchCount: 1 },
      { jobId: `int-ingest.ok.${Date.now()}` },
    );
    const id = requireJobId(job);
    const result = (await job.waitUntilFinished(events, 30_000)) as IngestResult;

    expect(result.status).toBe('succeeded');
    expect(result.itemsFailed).toBe(0);
    expect(result.itemsUpserted).toBeGreaterThanOrEqual(1);

    // upstream metadata replaced the stale name…
    const [updated] = await db.select().from(items).where(eq(items.id, created.id));
    expect(updated?.name).toBe('fresh-widget');
    expect(updated?.latestMetrics.downloads).toBe(99);

    // …and the snapshot landed in the hourly bucket
    const points = await db.select().from(snapshots).where(eq(snapshots.itemId, created.id));
    expect(points).toHaveLength(1);
    expect(points[0]?.metric).toBe('stars');
    expect(points[0]?.value).toBe(7);

    const runs = await runsFor(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('succeeded');
    expect(runs[0]?.itemsSeen).toBeGreaterThanOrEqual(1);

    // spec §7.1 step 7: snapshot success → scoring with the deterministic slot id
    const scoring = await poll(async () => {
      const jobs = await queues.scoring.getJobs(['waiting', 'delayed', 'active'], 0, 100);
      return jobs.find((candidate) => (candidate.id ?? '').startsWith('score.github.'));
    }, 'scoring enqueue');
    // L-8: the request waits for the end of the ten-minute slot, so a
    // multi-batch fan-out finishes before the board rebuild.
    expect(scoring.opts.delay).toBeGreaterThan(0);
    expect(scoring.opts.delay).toBeLessThanOrEqual(600_000);
    await scoring.remove();

    const stored = await queues.ingest.github.getJob(id);
    await stored?.remove();
  });

  it('renames an item via upstream_id and keeps the old slug as an alias stub (§5.4)', async () => {
    const oldId = `${PREFIX}rename-old`;
    const newId = `${PREFIX}rename-new`;
    const upstreamId = `R_${newId}`;
    await db.execute(sql`DELETE FROM items WHERE external_id IN (${oldId}, ${newId})`);
    state.renames.set(oldId, newId);

    try {
      const [created] = await upsertItems(db, [itemUpsert(oldId, 'old-name', upstreamId)], {
        newItemTier: 'hot',
      });
      if (created === undefined) throw new Error('item upsert returned no row');

      const job = await queues.ingest.github.add(
        'snapshot',
        { type: 'snapshot', source: 'github', tier: 'hot', batch: 0, batchCount: 1 },
        { jobId: `int-ingest.rename.${Date.now()}` },
      );
      const id = requireJobId(job);
      const result = (await job.waitUntilFinished(events, 30_000)) as IngestResult;
      expect(result.status).toBe('succeeded');

      const [renamed] = await db.select().from(items).where(eq(items.id, created.id));
      expect(renamed?.externalId).toBe(newId);
      expect(renamed?.upstreamId).toBe(upstreamId);

      const [stub] = await db
        .select()
        .from(items)
        .where(and(eq(items.source, 'github'), eq(items.externalId, oldId)));
      expect(stub?.tier).toBe('cold');
      expect(stub?.flags).toContain('stub');
      expect(stub?.upstreamId).toBeNull();
      expect(stub?.isDeleted).toBe(false);

      const aliases = await db.select().from(itemAliases).where(eq(itemAliases.itemId, created.id));
      expect(aliases).toHaveLength(1);
      expect(aliases[0]?.aliasItemId).toBe(stub?.id);
      expect(aliases[0]?.relation).toBe('same_project');
      expect(aliases[0]?.confidence).toBe(1);
      expect(aliases[0]?.evidence).toBe('github_rename');

      const stored = await queues.ingest.github.getJob(id);
      await stored?.remove();
    } finally {
      state.renames.delete(oldId);
    }
  });

  it('writes a 304 continuity snapshot from latest_metrics and counts not_modified (§7.3.1)', async () => {
    const externalId = `${PREFIX}continuity`;
    await db.execute(sql`DELETE FROM items WHERE external_id = ${externalId}`);

    const [created] = await upsertItems(db, [itemUpsert(externalId, 'continuity')], {
      newItemTier: 'cold',
    });
    if (created === undefined) throw new Error('item upsert returned no row');

    const seededAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    seededAt.setUTCHours(0, 0, 0, 0);
    await upsertSnapshots(
      db,
      [
        {
          itemId: created.id,
          metric: 'stars',
          capturedAt: seededAt,
          observedAt: seededAt,
          value: 42,
          runId: null,
        },
      ],
      { refreshAggregates: true },
    );
    const [seeded] = await db.select().from(items).where(eq(items.id, created.id));
    expect(seeded?.latestMetrics).toEqual({ stars: 42 });

    state.notModifiedRefs.add(externalId);
    try {
      const bucket = bucketCapturedAt('cold', new Date());
      const job = await queues.ingest.github.add(
        'snapshot',
        { type: 'snapshot', source: 'github', tier: 'cold', batch: 0, batchCount: 1 },
        { jobId: `int-ingest.continuity.${Date.now()}` },
      );
      const id = requireJobId(job);
      const result = (await job.waitUntilFinished(events, 30_000)) as IngestResult;
      expect(result.status).toBe('succeeded');

      const runs = await runsFor(id);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.notModified).toBeGreaterThanOrEqual(1);

      const points = await db
        .select()
        .from(snapshots)
        .where(eq(snapshots.itemId, created.id))
        .orderBy(asc(snapshots.capturedAt));
      expect(points).toHaveLength(2);
      const continuity = points[1];
      expect(continuity?.capturedAt.getTime()).toBe(bucket.getTime());
      expect(continuity?.value).toBe(42);
      expect(continuity?.runId).toEqual(runs[0]?.id);

      const stored = await queues.ingest.github.getJob(id);
      await stored?.remove();
    } finally {
      state.notModifiedRefs.delete(externalId);
    }
  });
});
