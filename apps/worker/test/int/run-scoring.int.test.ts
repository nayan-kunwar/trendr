import { and, count, countDistinct, eq, isNotNull, max, min, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ALL_BOARD_MAX_SHARE,
  ALL_BOARD_TOP_N,
  SOURCES,
  WINDOWS,
  buildAllBoard,
  jobId,
  redisKeys,
  type NotifyJob,
  type Source,
  type Window,
} from '@trendr/core';
import {
  createDb,
  ingestionRuns,
  items,
  scoreRunsCurrent,
  scores,
  startRun,
  swapCurrentRun,
  type Connection,
  type Db,
} from '@trendr/db';
import { seed } from '@trendr/db/seed';

import { scoringItems, scoringRunsTotal } from '../../src/metrics.js';
import {
  loadAllBoardCandidates,
  runScoring,
  type NotifyQueue,
} from '../../src/scoring/run-scoring.js';

/**
 * Task 2.4 acceptance (spec §18): a scoring run over the seeded database
 * produces scores for every source × window in under five seconds; per
 * (source, window) the `scores` row count equals
 * `trendr_scoring_items{eligibility="eligible"}` and no row carries an
 * ineligibility flag or a zero final score. Also covers the per-source lock
 * (skip while held, release only when owned), idempotent re-runs, the
 * combined-board share cap and the `evaluate-alerts` fan-out.
 */

const ANCHOR = new Date('2026-10-18T12:00:00Z');
const PEPPER = 'seed-int-test-pepper-0123456789abcdef';
const ADMIN_EMAIL = 'seed-admin@trendr.test';
const SEED_MARKER = sql`${items.metadata} ->> 'seed' = 'true'`;
const INELIGIBLE_FLAGS = ['below_threshold', 'insufficient_data', 'negative_growth'];

let connection: Connection;
let db: Db;
let redis: Redis;

const enqueued: { name: string; data: NotifyJob; options: { jobId?: string } | undefined }[] = [];
const notifyQueue: NotifyQueue = {
  add: (name, data, options) => {
    enqueued.push({ name, data, options });
    return Promise.resolve(undefined);
  },
};

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) {
    throw new Error('DATABASE_URL/REDIS_URL are missing — run through `pnpm test:int`');
  }
  connection = createDb(databaseUrl);
  db = connection.db;
  redis = new Redis(redisUrl);
  await seed(db, { pepper: PEPPER, adminEmail: ADMIN_EMAIL, now: ANCHOR });
}, 180_000);

afterAll(async () => {
  await redis.quit();
  await connection.pool.end();
});

function single<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('expected exactly one row');
  return row;
}

async function gaugeValue(
  source: Source,
  window: Window,
  eligibility: 'eligible' | 'ineligible',
): Promise<number> {
  const metric = await scoringItems.get();
  const found = metric.values.find(
    (value) =>
      value.labels.source === source &&
      value.labels.window === window &&
      value.labels.eligibility === eligibility,
  );
  return found?.value ?? 0;
}

const currentRunJoin = and(
  eq(scoreRunsCurrent.source, scores.source),
  eq(scoreRunsCurrent.window, scores.window),
  eq(scoreRunsCurrent.runId, scores.runId),
);

describe('runScoring (§8.4, task 2.4)', () => {
  it('produces scores for every source × window on seed data in under 5 s', async () => {
    const startedAt = Date.now();
    for (const source of SOURCES) {
      await runScoring(source, WINDOWS, {
        db,
        redis,
        jobId: `int-scoring-${source}`,
        now: () => ANCHOR,
        notifyQueue,
      });
    }
    expect(Date.now() - startedAt, 'all sources × windows').toBeLessThan(5_000);

    for (const source of SOURCES) {
      for (const window of WINDOWS) {
        const current = single(
          await db
            .select()
            .from(scoreRunsCurrent)
            .where(and(eq(scoreRunsCurrent.source, source), eq(scoreRunsCurrent.window, window))),
        );
        const scoped = and(
          eq(scores.source, source),
          eq(scores.window, window),
          eq(scores.runId, current.runId),
        );

        const rowCount = single(await db.select({ n: count() }).from(scores).where(scoped)).n;
        expect(rowCount, `${source} ${window} has scores`).toBeGreaterThan(0);
        expect(rowCount, `${source} ${window} row count = eligible gauge`).toBe(
          await gaugeValue(source, window, 'eligible'),
        );

        // rank_source is a dense 1..n ranking of the eligible set (tiering reads it).
        const ranks = single(
          await db
            .select({
              min: min(scores.rankSource),
              maxRank: max(scores.rankSource),
              distinct: countDistinct(scores.rankSource),
            })
            .from(scores)
            .where(scoped),
        );
        expect(ranks.min).toBe(1);
        expect(ranks.maxRank).toBe(rowCount);
        expect(ranks.distinct).toBe(rowCount);
      }
    }

    // Only eligible items land in `scores` (spec §8.4): no zero final scores and
    // none of the three ineligibility flags, among seeded items.
    const badRows = single(
      await db
        .select({ n: count() })
        .from(scores)
        .innerJoin(items, eq(items.id, scores.itemId))
        .where(
          and(
            SEED_MARKER,
            // eslint-disable-next-line no-restricted-syntax -- compile-time flag literal in a test
            sql`((${scores.flags} && ${sql.raw(`ARRAY['${INELIGIBLE_FLAGS.join("', '")}']`)}) OR (${scores.finalScore} = 0))`,
          ),
        ),
    );
    expect(badRows.n).toBe(0);

    // Combined board: capped at topN overall and floor(maxShare·topN) per source.
    const perSourceCap = Math.max(1, Math.floor(ALL_BOARD_MAX_SHARE * ALL_BOARD_TOP_N));
    for (const window of WINDOWS) {
      const boardRows = await db
        .select({ source: scores.source, n: count(), maxRank: max(scores.rankAll) })
        .from(scores)
        .innerJoin(scoreRunsCurrent, currentRunJoin)
        .where(and(eq(scores.window, window), sql`${scores.rankAll} IS NOT NULL`))
        .groupBy(scores.source);

      let total = 0;
      for (const row of boardRows) {
        total += row.n;
        expect(row.maxRank ?? 0).toBeLessThanOrEqual(ALL_BOARD_TOP_N);
        expect(row.n).toBeLessThanOrEqual(perSourceCap);
      }
      expect(total, `${window} combined board is populated`).toBeGreaterThan(0);
      expect(total).toBeLessThanOrEqual(ALL_BOARD_TOP_N);
    }
  });

  it('re-runs idempotently for the same jobId and releases the lock', async () => {
    expect(await redis.get(redisKeys.scoreLock('github'))).toBeNull();

    const boardCount = async (): Promise<number> =>
      single(
        await db
          .select({ n: count() })
          .from(scores)
          .innerJoin(scoreRunsCurrent, currentRunJoin)
          .where(eq(scores.window, '7d')),
      ).n;
    const runCount = async (): Promise<number> =>
      single(
        await db
          .select({ n: count() })
          .from(ingestionRuns)
          .where(sql`${ingestionRuns.jobId} LIKE 'int-scoring-%'`),
      ).n;

    const before = await boardCount();
    const runsBefore = await runCount();

    await runScoring('github', ['7d'], {
      db,
      redis,
      jobId: 'int-scoring-github',
      now: () => ANCHOR,
      notifyQueue,
    });

    // Same (job_id, attempt) re-opens the same run; conflicting score rows are
    // ignored, so nothing duplicates (spec §6.4 / §8.4).
    expect(await boardCount()).toBe(before);
    expect(await runCount()).toBe(runsBefore);
  });

  it('skips while the per-source lock is held and never steals it', async () => {
    const lockKey = redisKeys.scoreLock('npm');
    await redis.set(lockKey, 'another-worker', 'PX', 30_000);

    const outcome = await runScoring('npm', ['24h'], {
      db,
      redis,
      jobId: 'int-scoring-locked',
      now: () => ANCHOR,
      notifyQueue,
    });
    // M-3: a lock-held job reports `skipped`, not a silent success.
    expect(outcome).toEqual({ status: 'skipped', reason: 'lock-held' });
    const skipped = (await scoringRunsTotal.get()).values.find(
      (value) => value.labels.source === 'npm' && value.labels.outcome === 'skipped',
    );
    expect(skipped?.value).toBeGreaterThanOrEqual(1);

    const runs = single(
      await db
        .select({ n: count() })
        .from(ingestionRuns)
        .where(eq(ingestionRuns.jobId, 'int-scoring-locked')),
    ).n;
    expect(runs).toBe(0);
    expect(await redis.get(lockKey)).toBe('another-worker');

    await redis.del(lockKey);
  });

  it('loads only the rows that can place on the combined board (L-9)', async () => {
    const window = '7d';

    // The bound: never more than the per-source cap per source.
    const bounded = await loadAllBoardCandidates(db, window, { topN: 4, maxShare: 0.5 });
    expect(bounded.length).toBeLessThanOrEqual(SOURCES.length * 2);

    // Equivalence: the persisted board matches a full in-memory rebuild.
    const full = await db.execute<{
      itemId: string;
      source: Source;
      zScore: number;
      percentile: number;
      finalScore: number;
    }>(sql`
      SELECT s.item_id::text AS "itemId", s.source AS source, s.z_score AS "zScore",
             s.percentile AS percentile, s.final_score AS "finalScore"
      FROM scores s
      JOIN score_runs_current c
        ON c.source = s.source AND c.window = s.window AND c.run_id = s.run_id
      WHERE s.window = ${window}`);
    const expected = buildAllBoard(
      full.rows.map((row) => ({
        itemId: BigInt(row.itemId),
        source: row.source,
        zScore: row.zScore,
        percentile: row.percentile,
        finalScore: row.finalScore,
      })),
    );
    const candidates = await loadAllBoardCandidates(db, window);
    expect(candidates.length).toBeGreaterThanOrEqual(expected.length);

    const persisted = await db
      .select({ itemId: scores.itemId, rank: scores.rankAll })
      .from(scores)
      .where(and(eq(scores.window, window), isNotNull(scores.rankAll)));
    expect(persisted).toHaveLength(expected.length);
    const byId = new Map(persisted.map((row) => [row.itemId.toString(), row.rank]));
    for (const placement of expected) {
      expect(byId.get(placement.itemId.toString()), `rank for ${placement.itemId}`).toBe(
        placement.rank,
      );
    }
  });

  it('never moves the current-run pointer backwards (M-3)', async () => {
    const before = single(
      await db
        .select()
        .from(scoreRunsCurrent)
        .where(and(eq(scoreRunsCurrent.source, 'github'), eq(scoreRunsCurrent.window, '7d'))),
    );

    const newerRunId = await startRun(db, {
      source: 'github',
      jobType: 'score',
      jobId: 'int-scoring-newer-run',
    });
    const newer = new Date(before.computedAt.getTime() + 3_600_000);
    expect(
      await swapCurrentRun(db, {
        source: 'github',
        window: '7d',
        runId: newerRunId,
        computedAt: newer,
      }),
    ).toBe(true);

    // A late-finishing older run must not clobber the newer pointer.
    expect(
      await swapCurrentRun(db, {
        source: 'github',
        window: '7d',
        runId: before.runId,
        computedAt: before.computedAt,
      }),
    ).toBe(false);
    const stillNewer = single(
      await db
        .select()
        .from(scoreRunsCurrent)
        .where(and(eq(scoreRunsCurrent.source, 'github'), eq(scoreRunsCurrent.window, '7d'))),
    );
    expect(stillNewer.runId).toBe(newerRunId);

    // An equal timestamp with a lower run id is also stale.
    expect(
      await swapCurrentRun(db, {
        source: 'github',
        window: '7d',
        runId: before.runId,
        computedAt: newer,
      }),
    ).toBe(false);

    // Restore the pointer directly; the swap API is monotonic by design.
    await db
      .update(scoreRunsCurrent)
      .set({ runId: before.runId, computedAt: before.computedAt })
      .where(and(eq(scoreRunsCurrent.source, 'github'), eq(scoreRunsCurrent.window, '7d')));
  });

  it('fans out evaluate-alerts with the deterministic jobId', async () => {
    const current = single(
      await db
        .select()
        .from(scoreRunsCurrent)
        .where(and(eq(scoreRunsCurrent.source, 'github'), eq(scoreRunsCurrent.window, '7d'))),
    );
    const entry = enqueued.find(
      (candidate) =>
        candidate.name === 'evaluate-alerts' &&
        candidate.data.type === 'evaluate-alerts' &&
        candidate.data.scoreRunId === String(current.runId),
    );
    if (entry === undefined) throw new Error('evaluate-alerts was not enqueued');
    if (entry.data.type !== 'evaluate-alerts') throw new Error('unreachable');

    expect(entry.options?.jobId).toBe(jobId.evaluateAlerts(String(current.runId)));
    expect(entry.data.source).toBe('github');
  });
});
