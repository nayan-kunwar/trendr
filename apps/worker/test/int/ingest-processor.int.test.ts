import { setTimeout as sleep } from 'node:timers/promises';

import { QueueEvents, type Job, type Worker } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { QUEUE, UpstreamError, type IngestJob } from '@trendr/core';
import {
  createDb,
  ingestionRuns,
  items,
  snapshots,
  upsertItems,
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
 */

const PREFIX = 'int-ingest/';
const ITEM_PREFIX_PATTERN = `${PREFIX}%`;

const state = { failFetchMetrics: false };

function itemUpsert(externalId: string, name: string) {
  return {
    source: 'github' as const,
    kind: 'repo' as const,
    externalId,
    upstreamId: null,
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
          ref.externalId.startsWith(PREFIX)
            ? { ref, raw: { name: 'fresh-widget' }, fetchedAt }
            : { ref, raw: null, fetchedAt, notModified: true },
        ),
      );
    },
    normalize: (fetched: FetchedItem): NormalizedItem | null => {
      const externalId = fetched.ref.externalId;
      if (!externalId.startsWith(PREFIX)) return null;
      return {
        item: {
          source: 'github',
          kind: 'repo',
          externalId,
          upstreamId: null,
          name: 'fresh-widget',
          displayName: externalId,
          description: null,
          url: `https://github.com/${externalId}`,
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
    deps: { db, redis, logger, scoringQueue: queues.scoring, hfRatePer5Min: 1_000 },
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
    await scoring.remove();

    const stored = await queues.ingest.github.getJob(id);
    await stored?.remove();
  });
});
