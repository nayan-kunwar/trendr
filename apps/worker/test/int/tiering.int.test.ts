import { QueueEvents, type Worker } from 'bullmq';
import { eq, inArray, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { QUEUE, jobId, type ItemFlag, type Tier } from '@trendr/core';
import {
  createDb,
  insertScores,
  itemAliases,
  items,
  scoreRunsCurrent,
  startRun,
  swapCurrentRun,
  upsertItems,
  users,
  watchlistItems,
  watchlists,
  type Connection,
  type Db,
} from '@trendr/db';
import { createLogger } from '@trendr/logger';

import { promoteItemToHot, runRetierItems } from '../../src/ingestion/tiering.js';
import {
  createMaintenanceWorker,
  type MaintenanceResult,
} from '../../src/processors/maintenance.processor.js';
import {
  closeQueues,
  createQueues,
  createWorkerConnection,
  type Queues,
} from '../../src/queues.js';

/**
 * Task 4.5 acceptance (spec §7.8/§18): a watched item is instantly promoted to
 * `hot` (and gets its `refresh-item`), the `maintenance:retier-items` job
 * evaluates the ordered rules (rank, freshness, watchlist, growth/seen) and an
 * item with no growth for 60+ days becomes `archived`. The shared Testcontainers
 * database is mutated by a full retier run, so every tier and the
 * `score_runs_current` pointer are saved before and restored after the file.
 */

const PREFIX = 'int-tier/';
const ITEM_PREFIX_PATTERN = `${PREFIX}%`;
const DAY_MS = 86_400_000;

function itemUpsert(
  externalId: string,
  options: { flags?: ItemFlag[]; upstreamCreatedAt?: Date } = {},
) {
  return {
    source: 'github' as const,
    kind: 'repo' as const,
    externalId,
    upstreamId: null,
    name: externalId.slice(PREFIX.length),
    displayName: externalId,
    description: null,
    url: `https://github.com/${externalId}`,
    homepage: null,
    language: null,
    license: null,
    owner: 'int-tier',
    primaryMetric: 'stars' as const,
    upstreamCreatedAt: options.upstreamCreatedAt ?? new Date(Date.now() - 1000 * DAY_MS),
    isArchived: false,
    metadata: {},
    flags: options.flags ?? [],
  };
}

let connection: Connection;
let db: Db;
let redis: Redis;
let bullRedis: Redis;
let queues: Queues;
let worker: Worker;
let events: QueueEvents;
let logger: ReturnType<typeof createLogger>;

let savedTiers: Map<Tier, bigint[]> | undefined;
let savedCurrentRuns: (typeof scoreRunsCurrent.$inferSelect)[] | undefined;

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL ?? '';
  if (!databaseUrl || !redisUrl) {
    throw new Error('DATABASE_URL/REDIS_URL are missing — run through `pnpm test:int`');
  }
  connection = createDb(databaseUrl);
  db = connection.db;
  redis = new Redis(redisUrl);
  logger = createLogger({ service: 'worker', level: 'error' });

  savedTiers = new Map();
  const rows = await db.select({ id: items.id, tier: items.tier }).from(items);
  for (const row of rows) {
    const list = savedTiers.get(row.tier) ?? [];
    list.push(row.id);
    savedTiers.set(row.tier, list);
  }
  savedCurrentRuns = await db.select().from(scoreRunsCurrent);

  bullRedis = createWorkerConnection(redisUrl);
  queues = createQueues(bullRedis);
  events = new QueueEvents(QUEUE.maintenance, { connection: createWorkerConnection(redisUrl) });
  await events.waitUntilReady();
  worker = createMaintenanceWorker({
    db,
    connection: bullRedis,
    logger,
    hotMaxBySource: { github: 2000, huggingface: 1000 },
    settings: { backoffStrategy: () => 10 },
  });
  await worker.waitUntilReady();
});

afterAll(async () => {
  await worker.close();
  await events.close();
  await restoreState();
  await cleanupRows();
  await closeQueues(queues);
  await redis.quit();
  await bullRedis.quit();
  await connection.pool.end();
});

/** Put every row the retier run may have touched back where it was. */
async function restoreState(): Promise<void> {
  if (savedTiers !== undefined) {
    for (const [tier, ids] of savedTiers) {
      if (ids.length === 0) continue;
      await db.update(items).set({ tier }).where(inArray(items.id, ids));
    }
  }
  if (savedCurrentRuns !== undefined) {
    await db.delete(scoreRunsCurrent);
    if (savedCurrentRuns.length > 0) {
      await db.insert(scoreRunsCurrent).values(savedCurrentRuns);
    }
  }
}

async function cleanupRows(): Promise<void> {
  await db.execute(
    sql`DELETE FROM scores WHERE item_id IN (SELECT id FROM items WHERE external_id LIKE ${ITEM_PREFIX_PATTERN})`,
  );
  await db.execute(
    sql`DELETE FROM scores WHERE run_id IN (SELECT id FROM ingestion_runs WHERE job_id LIKE 'int-tier.%')`,
  );
  await db.execute(
    sql`DELETE FROM score_runs_current WHERE run_id IN (SELECT id FROM ingestion_runs WHERE job_id LIKE 'int-tier.%')`,
  );
  await db.execute(sql`DELETE FROM ingestion_runs WHERE job_id LIKE 'int-tier.%'`);
  await db.execute(
    sql`DELETE FROM watchlists WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'int-tier-%')`,
  );
  await db.execute(sql`DELETE FROM users WHERE email LIKE 'int-tier-%'`);
  await db.execute(sql`DELETE FROM items WHERE external_id LIKE ${ITEM_PREFIX_PATTERN}`);
}

function tierOf(itemId: bigint) {
  return db
    .select({ tier: items.tier })
    .from(items)
    .where(eq(items.id, itemId))
    .then((rows) => rows[0]?.tier);
}

describe('tiering (spec §7.8, task 4.5)', () => {
  it('instantly promotes a watched item to hot and enqueues a refresh (§7.8)', async () => {
    const [watched] = await upsertItems(db, [itemUpsert(`${PREFIX}watched`)], {
      newItemTier: 'cold',
    });
    const [stub] = await upsertItems(db, [itemUpsert(`${PREFIX}stub`, { flags: ['stub'] })], {
      newItemTier: 'cold',
    });
    if (watched === undefined || stub === undefined) throw new Error('upsert returned no row');

    const [user] = await db
      .insert(users)
      .values({ email: `int-tier-${Date.now()}@trendr.test` })
      .returning({ id: users.id });
    if (user === undefined) throw new Error('user insert returned no row');
    const [list] = await db
      .insert(watchlists)
      .values({ userId: user.id, name: 'Main' })
      .returning({ id: watchlists.id });
    if (list === undefined) throw new Error('watchlist insert returned no row');
    await db.insert(watchlistItems).values({ watchlistId: list.id, itemId: watched.id });

    const day = new Date().toISOString().slice(0, 10);
    const twiceAt = new Date();
    const outcome = await promoteItemToHot(
      { db, ingestQueue: queues.ingest.github, now: () => twiceAt },
      watched.id,
    );
    expect(outcome).toBe('promoted');
    expect(await tierOf(watched.id)).toBe('hot');

    const refresh = await queues.ingest.github.getJob(
      jobId.refreshItem('github', watched.id.toString(), day),
    );
    expect(refresh).toBeDefined();
    expect(refresh?.data).toMatchObject({
      type: 'refresh-item',
      source: 'github',
      itemId: watched.id.toString(),
      trigger: 'manual',
    });

    // idempotent PUT of the same watchlist entry: already hot, refresh dedupes
    const again = await promoteItemToHot(
      { db, ingestQueue: queues.ingest.github, now: () => twiceAt },
      watched.id,
    );
    expect(again).toBe('already-hot');
    expect(
      await queues.ingest.github.getJob(jobId.refreshItem('github', watched.id.toString(), day)),
    ).toBeDefined();

    // alias stubs are not promotable: their slug 301s upstream
    expect(await promoteItemToHot({ db, ingestQueue: queues.ingest.github }, stub.id)).toBe(
      'not-promotable',
    );
    expect(
      await queues.ingest.github.getJob(jobId.refreshItem('github', stub.id.toString(), day)),
    ).toBeUndefined();

    await refresh?.remove();
    expect(await promoteItemToHot({ db, ingestQueue: queues.ingest.github }, 999_999_999n)).toBe(
      'item-missing',
    );
  });

  it('retiers: ranks and freshness go hot, a stale item goes archived (§7.8)', async () => {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - 100 * DAY_MS);

    const created = await upsertItems(
      db,
      [
        itemUpsert(`${PREFIX}stale`),
        itemUpsert(`${PREFIX}ranked`),
        itemUpsert(`${PREFIX}alias`),
        itemUpsert(`${PREFIX}fresh`, { upstreamCreatedAt: new Date(now.getTime() - 2 * DAY_MS) }),
        itemUpsert(`${PREFIX}steady`),
      ],
      { newItemTier: 'cold' },
    );
    const byName = new Map(created.map((row) => [row.externalId, row]));
    const stale = byName.get(`${PREFIX}stale`);
    const ranked = byName.get(`${PREFIX}ranked`);
    const alias = byName.get(`${PREFIX}alias`);
    const fresh = byName.get(`${PREFIX}fresh`);
    const steady = byName.get(`${PREFIX}steady`);
    if (
      stale === undefined ||
      ranked === undefined ||
      alias === undefined ||
      fresh === undefined ||
      steady === undefined
    ) {
      throw new Error('tiering seed upsert returned no row');
    }

    // no growth and unseen for 100 days → archived
    await db
      .update(items)
      .set({ lastSeenAt: staleBefore, lastSnapshotAt: staleBefore })
      .where(eq(items.id, stale.id));
    // fresh item above the GitHub admission minimum (20 stars)
    await db
      .update(items)
      .set({ latestMetrics: { stars: 120 } })
      .where(eq(items.id, fresh.id));
    // alias target of the ranked item → at least warm
    await db.insert(itemAliases).values({
      itemId: ranked.id,
      aliasItemId: alias.id,
      relation: 'same_project',
      confidence: 0.9,
      evidence: 'int-tier',
    });
    // current-run rank 42 in the 7d window → hot
    const runId = await startRun(db, {
      source: 'github',
      jobType: 'score',
      jobId: `int-tier.score.${Date.now()}`,
    });
    const computedAt = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    await insertScores(db, [
      {
        itemId: ranked.id,
        window: '7d',
        runId,
        source: 'github',
        computedAt,
        delta: 10,
        base: 100,
        relGrowth: 0.1,
        rawScore: 5,
        ageFactor: 1,
        confidence: 1,
        anomalyPenalty: 1,
        finalScore: 5,
        zScore: 1,
        percentile: 0.98,
        rankSource: 42,
      },
    ]);
    await swapCurrentRun(db, { source: 'github', window: '7d', runId, computedAt });

    const job = await queues.maintenance.add(
      'retier-items',
      { type: 'retier-items' },
      { jobId: `int-tier.retier.${Date.now()}` },
    );
    const result = (await job.waitUntilFinished(events, 60_000)) as MaintenanceResult;
    expect(result.type).toBe('retier-items');
    expect(result.retier?.changed).toBeGreaterThanOrEqual(4);

    expect(await tierOf(stale.id)).toBe('archived');
    expect(await tierOf(ranked.id)).toBe('hot');
    expect(await tierOf(alias.id)).toBe('warm');
    expect(await tierOf(fresh.id)).toBe('hot');
    expect(await tierOf(steady.id)).toBe('cold');
    // the watched item from the promotion test is exempt from the hot cap
    const [watched] = await db
      .select({ id: items.id, tier: items.tier })
      .from(items)
      .where(eq(items.externalId, `${PREFIX}watched`));
    expect(watched?.tier).toBe('hot');

    await job.remove();
  });

  it('runs the same evaluation directly (maintenance worker path is thin)', async () => {
    const summary = await runRetierItems({
      db,
      logger,
      hotMaxBySource: { github: 2000, huggingface: 1000 },
    });
    expect(summary.evaluated).toBeGreaterThan(0);
  });
});
