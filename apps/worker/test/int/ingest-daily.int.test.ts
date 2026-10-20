import { QueueEvents, type Worker } from 'bullmq';
import { asc, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { QUEUE } from '@trendr/core';
import {
  createDb,
  dailyMetrics,
  ingestionRuns,
  items,
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
  type Queues,
} from '../../src/queues.js';

/**
 * Task 5.1 acceptance — the pipeline half of the npm adapter: a daily run
 * persists the days that landed, preserves the discovery metadata that a
 * downloads-only payload does not carry, mirrors the newest day into
 * `items.latest_metrics`, marks the run `partial` when the newest bucket is
 * late (§7.3.2), and never sweeps archived items (§7.8). The backfill path
 * writes a historical series and refreshes the aggregate too.
 */

const PREFIX = 'int-npm/';
const ITEM_PREFIX_PATTERN = `${PREFIX}%`;
const DAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const TWO_DAYS_AGO = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

/** External ids whose daily payload reports the newest bucket as late. */
const incomplete = new Set<string>();

function itemUpsert(externalId: string, tier: 'warm' | 'archived') {
  return {
    source: 'npm' as const,
    kind: 'package' as const,
    externalId,
    upstreamId: null,
    name: externalId.slice(PREFIX.length),
    displayName: externalId,
    description: tier === 'archived' ? 'archived package' : 'discovery description',
    url: `https://www.npmjs.com/package/${externalId}`,
    homepage: tier === 'archived' ? null : 'https://example.test/home',
    language: tier === 'archived' ? null : 'typescript',
    license: tier === 'archived' ? null : 'MIT',
    owner: tier === 'archived' ? null : '@scope',
    primaryMetric: 'downloads' as const,
    upstreamCreatedAt: null,
    isArchived: false,
    metadata: { publisher: 'publisher' },
    flags: [],
  };
}

function normalizeDaily(fetched: FetchedItem): NormalizedItem | null {
  const externalId = fetched.ref.externalId;
  if (!externalId.startsWith(PREFIX)) return null;
  return {
    item: {
      source: 'npm',
      kind: 'package',
      externalId,
      upstreamId: null,
      name: externalId.slice(PREFIX.length),
      displayName: externalId,
      // A downloads payload carries no metadata: these nulls must not blank
      // the stored discovery columns (`preserveMetadata`).
      description: null,
      url: `https://www.npmjs.com/package/${externalId}`,
      homepage: null,
      language: null,
      license: null,
      owner: null,
      topics: [],
      primaryMetric: 'downloads',
      upstreamCreatedAt: null,
      isArchived: false,
      metadata: {},
    },
    snapshots: [],
    daily: [
      { metric: 'downloads', day: TWO_DAYS_AGO, value: 100 },
      { metric: 'downloads', day: YESTERDAY, value: 200 },
    ],
    aliases: [],
  };
}

function fakeAdapter(): SourceAdapter {
  return {
    source: 'npm',
    kinds: ['package'],
    batchSize: 128,
    async *discover() {
      await Promise.resolve();
      yield [];
    },
    fetchMetrics: (_ctx, refs) => {
      const fetchedAt = new Date();
      return Promise.resolve(
        refs.map((ref) =>
          incomplete.has(ref.externalId)
            ? { ref, raw: null, fetchedAt, dailyIncomplete: true }
            : { ref, raw: null, fetchedAt },
        ),
      );
    },
    normalize: normalizeDaily,
    backfill: () =>
      Promise.resolve([
        { metric: 'downloads', day: TWO_DAYS_AGO, value: 10 },
        { metric: 'downloads', day: YESTERDAY, value: 20 },
        { metric: 'downloads', day: DAY, value: 30 },
      ]),
  };
}

let connection: Connection;
let db: Db;
let redis: Redis;
let bullRedis: Redis;
let queues: Queues;
let worker: Worker;
let events: QueueEvents;
/** Foreign npm items are parked in `archived` for the run, then restored. */
let savedTiers: { id: bigint; tier: string }[] = [];

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL ?? '';
  if (!databaseUrl || !redisUrl) {
    throw new Error('DATABASE_URL/REDIS_URL are missing — run through `pnpm test:int`');
  }
  connection = createDb(databaseUrl);
  db = connection.db;
  redis = new Redis(redisUrl);
  const logger = createLogger({ service: 'worker', level: 'error' });

  // The suite shares one DB and the seed test leaves npm items behind. The
  // daily job sweeps every tracked npm item, so park foreign rows in
  // `archived` (excluded from the sweep, §7.8) and restore them afterwards.
  savedTiers = await db
    .select({ id: items.id, tier: items.tier })
    .from(items)
    .where(eq(items.source, 'npm'));
  await db.execute(
    sql`UPDATE items SET tier = 'archived' WHERE source = 'npm' AND tier <> 'archived'`,
  );

  registerAdapter(fakeAdapter());

  bullRedis = createWorkerConnection(redisUrl);
  queues = createQueues(bullRedis);
  events = new QueueEvents(QUEUE.ingest.npm, { connection: createWorkerConnection(redisUrl) });
  await events.waitUntilReady();
  worker = createIngestWorker('npm', {
    deps: { db, redis, logger },
    connection: bullRedis,
    concurrency: 1,
    settings: { backoffStrategy: () => 10 },
  });
  await worker.waitUntilReady();
});

afterAll(async () => {
  await worker.close();
  await events.close();
  await cleanupRows();
  for (const row of savedTiers) {
    if (row.tier === 'archived') continue;
    await db.execute(sql`UPDATE items SET tier = ${row.tier} WHERE id = ${row.id}`);
  }
  await closeQueues(queues);
  await redis.quit();
  await bullRedis.quit();
  await connection.pool.end();
});

async function cleanupRows(): Promise<void> {
  await db.execute(
    sql`DELETE FROM daily_metrics WHERE item_id IN (SELECT id FROM items WHERE external_id LIKE ${ITEM_PREFIX_PATTERN})`,
  );
  await db.execute(
    sql`DELETE FROM snapshots WHERE item_id IN (SELECT id FROM items WHERE external_id LIKE ${ITEM_PREFIX_PATTERN})`,
  );
  await db.execute(sql`DELETE FROM items WHERE external_id LIKE ${ITEM_PREFIX_PATTERN}`);
  await db.execute(sql`DELETE FROM ingestion_runs WHERE job_id LIKE 'int-npm.%'`);
}

function requireJobId(job: { id?: string | undefined }): string {
  if (job.id === undefined) throw new Error('expected the job to have an id');
  return job.id;
}

describe('ingest daily pipeline (spec §7.3.2/§7.8)', () => {
  it('persists available days, preserves metadata, mirrors latest_metrics and closes partial', async () => {
    const completeId = `${PREFIX}complete`;
    const lateId = `${PREFIX}late`;
    const archivedId = `${PREFIX}archived`;
    const created = await upsertItems(
      db,
      [
        itemUpsert(completeId, 'warm'),
        itemUpsert(lateId, 'warm'),
        { ...itemUpsert(archivedId, 'archived'), flags: [] },
      ],
      { newItemTier: 'warm' },
    );
    // `newItemTier` applies to inserts; force the archived tier on conflict.
    await db.execute(sql`UPDATE items SET tier = 'archived' WHERE external_id = ${archivedId}`);
    expect(created).toHaveLength(3);

    incomplete.add(lateId);
    try {
      const job = await queues.ingest.npm.add(
        'daily',
        { type: 'daily', source: 'npm', trigger: 'schedule' },
        { jobId: `int-npm.daily.${Date.now()}` },
      );
      const id = requireJobId(job);
      const result = (await job.waitUntilFinished(events, 30_000)) as IngestResult;

      expect(result.status).toBe('partial');
      expect(result.itemsSeen).toBe(2); // archived is excluded
      expect(result.itemsIncomplete).toBe(1);
      expect(result.itemsUpserted).toBe(2);
      expect(result.itemsFailed).toBe(0);

      const runs = await db.select().from(ingestionRuns).where(eq(ingestionRuns.jobId, id));
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('partial');
      expect(runs[0]?.itemsFailed).toBe(0);

      const complete = created[0];
      const late = created[1];
      const archived = created[2];
      if (complete === undefined || late === undefined || archived === undefined) {
        throw new Error('seed upsert returned fewer rows than expected');
      }

      const completeRows = await db
        .select()
        .from(dailyMetrics)
        .where(eq(dailyMetrics.itemId, complete.id))
        .orderBy(asc(dailyMetrics.day));
      expect(completeRows.map((row) => [row.day, row.value])).toEqual([
        [TWO_DAYS_AGO, 100],
        [YESTERDAY, 200],
      ]);

      const [completeItem] = await db.select().from(items).where(eq(items.id, complete.id));
      expect(completeItem?.latestMetrics).toMatchObject({ downloads: 200 });
      // Daily payloads are metadata-less; discovery values must survive.
      expect(completeItem).toMatchObject({
        name: 'complete',
        description: 'discovery description',
        homepage: 'https://example.test/home',
        language: 'typescript',
        license: 'MIT',
        owner: '@scope',
      });
      expect(completeItem?.metadata).toMatchObject({ publisher: 'publisher' });

      const lateItem = await db.select().from(items).where(eq(items.id, late.id));
      expect(lateItem[0]?.latestMetrics).toMatchObject({ downloads: 200 });

      const archivedRows = await db
        .select()
        .from(dailyMetrics)
        .where(eq(dailyMetrics.itemId, archived.id));
      expect(archivedRows).toHaveLength(0);
      const archivedItem = await db.select().from(items).where(eq(items.id, archived.id));
      expect(archivedItem[0]?.latestMetrics).toEqual({});

      const stored = await queues.ingest.npm.getJob(id);
      await stored?.remove();
    } finally {
      incomplete.delete(lateId);
    }
  });

  it('writes a 60-day backfill series and refreshes latest_metrics', async () => {
    const externalId = `${PREFIX}backfill`;
    const [created] = await upsertItems(db, [itemUpsert(externalId, 'warm')], {
      newItemTier: 'warm',
    });
    if (created === undefined) throw new Error('item upsert returned no row');

    const job = await queues.ingest.npm.add(
      'backfill',
      {
        type: 'backfill',
        source: 'npm',
        itemId: created.id.toString(),
        days: 60,
        trigger: 'manual',
      },
      { jobId: `int-npm.backfill.${Date.now()}` },
    );
    const id = requireJobId(job);
    const result = (await job.waitUntilFinished(events, 30_000)) as IngestResult;
    expect(result.status).toBe('succeeded');
    expect(result.itemsUpserted).toBe(1);

    const rows = await db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.itemId, created.id))
      .orderBy(asc(dailyMetrics.day));
    expect(rows.map((row) => [row.day, row.value])).toEqual([
      [TWO_DAYS_AGO, 10],
      [YESTERDAY, 20],
      [DAY, 30],
    ]);
    const [stored] = await db.select().from(items).where(eq(items.id, created.id));
    expect(stored?.latestMetrics).toMatchObject({ downloads: 30 });

    const queueJob = await queues.ingest.npm.getJob(id);
    await queueJob?.remove();
  });
});
