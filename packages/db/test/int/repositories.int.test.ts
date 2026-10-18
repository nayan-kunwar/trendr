import { and, count, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type Connection, type Db } from '../../src/client.js';
import { type ItemUpsert, upsertItems } from '../../src/repositories/items.repo.js';
import { finishRun, getRun, startRun } from '../../src/repositories/runs.repo.js';
import { insertScores, pruneScores, swapCurrentRun } from '../../src/repositories/scores.repo.js';
import {
  rollupDailyMetrics,
  upsertDailyMetrics,
  upsertSnapshots,
} from '../../src/repositories/snapshots.repo.js';
import { items } from '../../src/schema/items.js';
import { dailyMetrics, scoreRunsCurrent, scores } from '../../src/schema/metrics.js';
import { ingestionRuns } from '../../src/schema/ops.js';
import { snapshots } from '../../src/schema/snapshots.js';

/**
 * Task 1.5 acceptance: bulk upserts are idempotent (running them twice yields
 * identical row counts), `snapshots.observed_at` wins last, item aggregates
 * follow the newest snapshot, the run recorder keys on (job_id, attempt), and
 * `pruneScores` implements the §6.5 policy (hourly horizon, last-of-day,
 * current runs never deleted).
 */

let connection: Connection;
let db: Db;

beforeAll(() => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is missing — run through `pnpm test:int`');
  connection = createDb(databaseUrl);
  db = connection.db;
});

afterAll(async () => {
  await connection.pool.end();
});

function single<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('expected exactly one row');
  return row;
}

function itemInput(externalId: string, overrides: Partial<ItemUpsert> = {}): ItemUpsert {
  const [owner = 'acme', name = externalId] = externalId.split('/');
  return {
    source: 'github',
    kind: 'repo',
    externalId,
    upstreamId: `node_${externalId}`,
    name,
    displayName: externalId,
    description: 'first description',
    url: `https://github.com/${externalId}`,
    homepage: null,
    language: 'typescript',
    license: 'MIT',
    owner,
    primaryMetric: 'stars',
    upstreamCreatedAt: new Date('2024-01-01T00:00:00Z'),
    isArchived: false,
    metadata: { stars: 1 },
    ...overrides,
  };
}

/** A deterministic instant `daysAgo` days back at `hour:00` UTC. */
function utcDayAt(daysAgo: number, hour: number): Date {
  const anchor = new Date(Date.now() - daysAgo * 86_400_000);
  return new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate(), hour),
  );
}

function scoreRow(
  itemId: bigint,
  runId: bigint,
  overrides: Partial<{ window: '24h' | '7d' }> = {},
) {
  return {
    itemId,
    window: '24h' as const,
    runId,
    source: 'github' as const,
    computedAt: new Date(),
    delta: 1,
    base: 10,
    relGrowth: 0.1,
    rawScore: 1,
    ageFactor: 1,
    confidence: 1,
    anomalyPenalty: 1,
    finalScore: 5,
    zScore: 0.5,
    percentile: 90,
    ...overrides,
  };
}

describe('items.repo (spec §6.2)', () => {
  it('upserts twice into one row and updates adapter-owned columns', async () => {
    const first = single(await upsertItems(db, [itemInput('acme/one')]));

    // Owned elsewhere: tiering + admin/system flags must survive upserts.
    await db
      .update(items)
      .set({ tier: 'hot', flags: ['manual_hidden'] })
      .where(eq(items.id, first.id));

    const second = single(
      await upsertItems(db, [
        itemInput('acme/one', {
          upstreamId: null, // coalesce keeps the stored value
          displayName: 'acme/one-v2',
          description: 'updated description',
          isArchived: true,
          upstreamCreatedAt: null,
          metadata: { stars: 7 },
          flags: ['fork'],
        }),
      ]),
    );

    expect(second.id).toBe(first.id);

    const rows = await db
      .select()
      .from(items)
      .where(and(eq(items.source, 'github'), eq(items.externalId, 'acme/one')));
    expect(rows).toHaveLength(1);

    const row = single(rows);
    expect(row.displayName).toBe('acme/one-v2');
    expect(row.description).toBe('updated description');
    expect(row.isArchived).toBe(true);
    expect(row.upstreamId).toBe('node_acme/one'); // kept via coalesce
    expect(row.upstreamCreatedAt).toEqual(new Date('2024-01-01T00:00:00Z'));
    expect(row.tier).toBe('hot'); // not reset by the upsert
    expect(new Set(row.flags)).toEqual(new Set(['manual_hidden', 'fork'])); // union
    expect(row.metadata).toEqual({ stars: 7 }); // jsonb merge, key replaced
  });
});

describe('snapshots.repo (spec §6.3)', () => {
  it('is idempotent and keeps observed_at last-writer-wins', async () => {
    const item = single(await upsertItems(db, [itemInput('acme/two')]));
    const capturedAt = utcDayAt(0, 10);

    const base = {
      itemId: item.id,
      metric: 'stars' as const,
      capturedAt,
      value: 100,
    };

    await upsertSnapshots(db, [{ ...base, observedAt: utcDayAt(0, 11) }]);
    await upsertSnapshots(db, [{ ...base, observedAt: utcDayAt(0, 11) }]);

    const countRows = () =>
      db
        .select({ n: count() })
        .from(snapshots)
        .where(
          and(
            eq(snapshots.itemId, item.id),
            eq(snapshots.metric, 'stars'),
            eq(snapshots.capturedAt, capturedAt),
          ),
        );

    expect(single(await countRows()).n).toBe(1); // second upsert changed no row count

    // An older observation must not overwrite the value…
    await upsertSnapshots(db, [{ ...base, observedAt: utcDayAt(0, 9), value: 999 }]);
    const afterOlder = single(
      await db
        .select()
        .from(snapshots)
        .where(and(eq(snapshots.itemId, item.id), eq(snapshots.metric, 'stars'))),
    );
    expect(afterOlder.value).toBe(100);

    // …a newer one must.
    await upsertSnapshots(db, [{ ...base, observedAt: utcDayAt(0, 12), value: 150 }]);
    const afterNewer = single(
      await db
        .select()
        .from(snapshots)
        .where(
          and(
            eq(snapshots.itemId, item.id),
            eq(snapshots.metric, 'stars'),
            eq(snapshots.capturedAt, capturedAt),
          ),
        ),
    );
    expect(afterNewer.value).toBe(150);
    expect(single(await countRows()).n).toBe(1);

    // The same transaction refreshes the item aggregates (spec §6.3).
    const itemRow = single(await db.select().from(items).where(eq(items.id, item.id)));
    expect(itemRow.latestMetrics).toMatchObject({ stars: 150 });
    expect(itemRow.lastSnapshotAt).toEqual(capturedAt);
  });

  it('upserts daily_metrics idempotently and rolls up end-of-day levels', async () => {
    const item = single(await upsertItems(db, [itemInput('acme/three')]));
    const day = utcDayAt(10, 0).toISOString().slice(0, 10);

    await upsertDailyMetrics(db, [{ itemId: item.id, metric: 'downloads', day, value: 10 }]);
    await upsertDailyMetrics(db, [{ itemId: item.id, metric: 'downloads', day, value: 20 }]);

    const daily = single(
      await db
        .select()
        .from(dailyMetrics)
        .where(and(eq(dailyMetrics.itemId, item.id), eq(dailyMetrics.metric, 'downloads'))),
    );
    expect(daily.value).toBe(20); // second upsert updated in place

    // Rollup reads the last snapshot of the day for cumulative metrics.
    await upsertSnapshots(
      db,
      [
        {
          itemId: item.id,
          metric: 'stars',
          capturedAt: utcDayAt(10, 9),
          observedAt: utcDayAt(10, 9),
          value: 250,
        },
        {
          itemId: item.id,
          metric: 'stars',
          capturedAt: utcDayAt(10, 21),
          observedAt: utcDayAt(10, 21),
          value: 300,
        },
      ],
      { refreshAggregates: false },
    );

    const rolled = await rollupDailyMetrics(db, day);
    expect(rolled).toBeGreaterThanOrEqual(1);

    const stars = single(
      await db
        .select()
        .from(dailyMetrics)
        .where(and(eq(dailyMetrics.itemId, item.id), eq(dailyMetrics.metric, 'stars'))),
    );
    expect(stars.day).toBe(day);
    expect(stars.value).toBe(300); // end-of-day level, not the 09:00 sample
  });
});

describe('runs.repo (spec §6.2, §7.1)', () => {
  it('keys runs on (job_id, attempt) and records the outcome', async () => {
    const input = { source: 'github' as const, jobType: 'snapshot' as const, jobId: 'test.run.1' };

    const first = await startRun(db, input);
    const replayed = await startRun(db, input); // same attempt: reset, not duplicated
    expect(replayed).toBe(first);

    const rowsForJob = await db
      .select({ n: count() })
      .from(ingestionRuns)
      .where(eq(ingestionRuns.jobId, 'test.run.1'));
    expect(single(rowsForJob).n).toBe(1);

    await finishRun(db, first, {
      status: 'succeeded',
      itemsSeen: 5,
      itemsUpserted: 2,
    });
    const run = await getRun(db, first);
    expect(run?.status).toBe('succeeded');
    expect(run?.itemsSeen).toBe(5);
    expect(run?.itemsUpserted).toBe(2);
    expect(run?.finishedAt).not.toBeNull();

    const retry = await startRun(db, { ...input, attempt: 2 });
    expect(retry).not.toBe(first);
    const afterRetry = await db
      .select({ n: count() })
      .from(ingestionRuns)
      .where(eq(ingestionRuns.jobId, 'test.run.1'));
    expect(single(afterRetry).n).toBe(2);
  });
});

describe('scores.repo (spec §8.4, §6.5)', () => {
  it('bulk insert is idempotent per (item, window, run) and swaps the current pointer', async () => {
    const item = single(await upsertItems(db, [itemInput('acme/four')]));
    const runA = await startRun(db, {
      source: 'github',
      jobType: 'score',
      jobId: 'test.score.a',
    });
    const runB = await startRun(db, {
      source: 'github',
      jobType: 'score',
      jobId: 'test.score.b',
    });

    const rows = [scoreRow(item.id, runA), scoreRow(item.id, runA, { window: '7d' })];

    expect(await insertScores(db, rows)).toBe(2);
    expect(await insertScores(db, rows)).toBe(0); // replay inserts nothing

    const total = await db.select({ n: count() }).from(scores).where(eq(scores.itemId, item.id));
    expect(single(total).n).toBe(2);

    await swapCurrentRun(db, {
      source: 'github',
      window: '24h',
      runId: runA,
      computedAt: new Date(),
    });
    let pointer = single(
      await db
        .select()
        .from(scoreRunsCurrent)
        .where(and(eq(scoreRunsCurrent.source, 'github'), eq(scoreRunsCurrent.window, '24h'))),
    );
    expect(pointer.runId).toBe(runA);

    await swapCurrentRun(db, {
      source: 'github',
      window: '24h',
      runId: runB,
      computedAt: new Date(),
    });
    pointer = single(
      await db
        .select()
        .from(scoreRunsCurrent)
        .where(and(eq(scoreRunsCurrent.source, 'github'), eq(scoreRunsCurrent.window, '24h'))),
    );
    expect(pointer.runId).toBe(runB);
  });

  it('pruneScores keeps hourly, last-of-day and current runs and deletes the rest', async () => {
    const item = single(await upsertItems(db, [itemInput('acme/five')]));

    const startedAt = (daysAgo: number, hour: number) => utcDayAt(daysAgo, hour);
    const makeRun = async (jobId: string, at: Date): Promise<bigint> => {
      const rows = await db
        .insert(ingestionRuns)
        .values({
          source: 'github',
          jobType: 'score',
          jobId,
          status: 'succeeded',
          startedAt: at,
          finishedAt: at,
        })
        .returning({ id: ingestionRuns.id });
      return single(rows).id;
    };

    const earlier = await makeRun('test.prune.earlier', startedAt(10, 1));
    const lastOfDay = await makeRun('test.prune.last-of-day', startedAt(10, 2));
    const ancient = await makeRun('test.prune.ancient', startedAt(400, 3));
    const fresh = await makeRun('test.prune.fresh', startedAt(0, 0));
    const current = await makeRun('test.prune.current', startedAt(10, 0));

    await insertScores(
      db,
      [earlier, lastOfDay, ancient, fresh, current].map((r) => scoreRow(item.id, r)),
    );
    await swapCurrentRun(db, {
      source: 'github',
      window: '24h',
      runId: current,
      computedAt: new Date(),
    });

    // earlier: superseded by the last run of its UTC day. ancient: outside the
    // daily horizon. current: never deleted (pointer). fresh: inside 48 h.
    expect(await pruneScores(db, 48, 365)).toBe(2);

    const survivors = await db
      .select({ n: count() })
      .from(scores)
      .where(inArray(scores.runId, [lastOfDay, ancient, fresh, current, earlier]));
    expect(single(survivors).n).toBe(3);

    const point = single(
      await db
        .select()
        .from(scoreRunsCurrent)
        .where(and(eq(scoreRunsCurrent.source, 'github'), eq(scoreRunsCurrent.window, '24h'))),
    );
    expect(point.runId).toBe(current);

    // Idempotent: a second run has nothing left to delete.
    expect(await pruneScores(db, 48, 365)).toBe(0);
  });
});
