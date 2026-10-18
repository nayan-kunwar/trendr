import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import {
  ALL_BOARD_MAX_SHARE,
  ALL_BOARD_TOP_N,
  buildAllBoard,
  computeRawScore,
  detectBurst,
  jobId,
  paramsFor,
  percentileRanks,
  redisKeys,
  robustZ,
  toDailyVelocityInput,
  toVelocityInput,
  type NotifyJob,
  type ScoreComponents,
  type ScoreFlag,
  type Source,
  type Window,
} from '@trendr/core';
import {
  finishRun,
  insertScores,
  loadCumulativeSeries,
  loadDailyFallback,
  loadDailySeries,
  loadHourlySeries,
  startRun,
  swapCurrentRun,
  type Db,
  type DbExecutor,
  type ScoreUpsert,
} from '@trendr/db';
import type { Logger } from '@trendr/logger';

import { scoringAnomalies, scoringDuration, scoringItems } from '../metrics.js';
import { publishLeaderboards } from './publish-leaderboards.js';

/**
 * Spec §8.4 — the scoring run: one Redis lock per source, series → scores for
 * each window (cumulative path via `toVelocityInput`, daily-count path via
 * `toDailyVelocityInput`), robust normalization within (source, window),
 * eligible-only inserts + `score_runs_current` swap in one transaction, the
 * combined-board rebuild (§8.2 step 9) and the `evaluate-alerts` fan-out.
 */

/** §8.4: `lock:score:{source}` is held for at most the length of a run. */
const LOCK_TTL_MS = 120_000;
/** §8.6 burst second pass: hourly increments are loaded for the top raw candidates only. */
const BURST_CANDIDATES = 500;
const HOUR_MS = 3_600_000;

/** Released only when the value still matches, so a lost lock is never stolen (spec §8.4). */
const RELEASE_LOCK_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * Structural slice of the BullMQ `notify` queue. Keeping it structural means
 * the scoring module (and its tests) need no `bullmq` dependency; the real
 * queue satisfies it in `main.ts`.
 */
export interface NotifyQueue {
  add(name: string, data: NotifyJob, options?: { jobId?: string }): Promise<unknown>;
}

export interface ScoringDeps {
  db: Db;
  redis: Redis;
  /** Lock holder identity — the BullMQ jobId (spec §8.4). */
  jobId: string;
  /** Clock; scoring instants are floored to the last complete hour (spec §8.1). */
  now: () => Date;
  /** When present, `evaluate-alerts` is enqueued after a successful run (spec §8.4). */
  notifyQueue?: NotifyQueue;
  /** `ALL_BOARD_MAX_SHARE` override; defaults to the spec constant. */
  maxShare?: number;
  logger?: Logger;
}

/** One evaluated item with its score components (before normalization). */
interface ScoredItem {
  itemId: bigint;
  score: ScoreComponents & { flags: ScoreFlag[] };
}

/** An eligible item after normalization and source-board ranking. */
interface ReadyScore extends ScoredItem {
  zScore: number;
  percentile: number;
  rankSource: number;
}

function floorToHour(date: Date): Date {
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runScoring(
  source: Source,
  windows: readonly Window[],
  deps: ScoringDeps,
): Promise<void> {
  const lockKey = redisKeys.scoreLock(source);
  const acquired = await deps.redis.set(lockKey, deps.jobId, 'PX', LOCK_TTL_MS, 'NX');
  if (acquired !== 'OK') {
    deps.logger?.info(
      { source, jobId: deps.jobId },
      'scoring run skipped: lock held by another job',
    );
    return;
  }

  let runId: bigint | null = null;
  let itemsSeen = 0;
  let itemsUpserted = 0;

  try {
    runId = await startRun(deps.db, { source, jobType: 'score', jobId: deps.jobId });
    const t = floorToHour(deps.now());

    for (const window of windows) {
      const result = await scoreWindow(deps, source, window, runId, t);
      itemsSeen += result.seen;
      itemsUpserted += result.inserted;
    }

    // The combined board spans all sources, so it is rebuilt after every run
    // from whichever runs are current (spec §8.4 pseudocode).
    for (const window of windows) {
      await rebuildAllBoard(
        deps.db,
        window,
        deps.maxShare === undefined ? {} : { maxShare: deps.maxShare },
      );
    }

    // Spec §8.4/§9.2: the source and combined boards are published only after
    // every rank_all placement is persisted; diff events follow the last swap.
    await publishLeaderboards(deps, source, windows, runId, { computedAt: t });

    if (deps.notifyQueue !== undefined) {
      await deps.notifyQueue.add(
        'evaluate-alerts',
        { type: 'evaluate-alerts', scoreRunId: String(runId), source },
        { jobId: jobId.evaluateAlerts(String(runId)) },
      );
    }

    await finishRun(deps.db, runId, { status: 'succeeded', itemsSeen, itemsUpserted });
  } catch (error: unknown) {
    if (runId !== null) {
      await finishRun(deps.db, runId, { status: 'failed', error: errorMessage(error) });
    }
    throw error;
  } finally {
    await deps.redis.eval(RELEASE_LOCK_LUA, 1, lockKey, deps.jobId);
  }
}

interface WindowResult {
  /** Items that entered the pipeline (cumulative + daily series rows). */
  seen: number;
  /** Eligible rows actually written. */
  inserted: number;
}

async function scoreWindow(
  deps: ScoringDeps,
  source: Source,
  window: Window,
  runId: bigint,
  t: Date,
): Promise<WindowResult> {
  const startedAt = Date.now();
  const cumulative = await loadCumulativeSeries(deps.db, source, t, window);
  const missingBrackets = cumulative.filter((row) => row.vBefore === null && row.vAfter === null);
  const fallback =
    missingBrackets.length > 0
      ? await loadDailyFallback(
          deps.db,
          missingBrackets.map((row) => row.itemId),
          t,
          window,
        )
      : new Map<bigint, number>();

  const conversions = cumulative.map((row) => ({
    itemId: row.itemId,
    conversion: toVelocityInput(
      { ...row, dailyFallback: fallback.get(row.itemId) ?? null },
      window,
      t,
    ),
    params: paramsFor(source, row.metric, window),
  }));

  const resetEntries = conversions.filter((entry) => entry.conversion.reset);
  if (resetEntries.length > 0) {
    scoringAnomalies.inc({ source, type: 'reset' }, resetEntries.length);
    for (const entry of resetEntries) {
      // Spec §8.8: counter resets are excluded with insufficient_data and logged.
      deps.logger?.warn(
        { source, window, itemId: String(entry.itemId) },
        'counter reset detected; item excluded',
      );
    }
  }

  const firstPass = conversions.map((entry) => ({
    ...entry,
    score: computeRawScore(entry.conversion.velocity, entry.params),
  }));

  // §8.6 burst second pass: hourly increments for the top raw candidates.
  const candidateIds = firstPass
    .filter((entry) => entry.score.rawScore > 0)
    .sort((a, b) => b.score.rawScore - a.score.rawScore)
    .slice(0, BURST_CANDIDATES)
    .map((entry) => entry.itemId);
  const hourly = await loadHourlySeries(deps.db, candidateIds, t, window);

  const scored: ScoredItem[] = [];
  for (const entry of firstPass) {
    const values = hourly.get(entry.itemId);
    const burst =
      values === undefined
        ? { penalty: 1 }
        : detectBurst(values, entry.conversion.velocity.delta, entry.params.burstMinAbs);
    if (burst.penalty < 1) {
      scoringAnomalies.inc({ source, type: 'burst' });
      deps.logger?.debug(
        { source, window, itemId: String(entry.itemId), reason: burst.reason },
        'burst detected; velocity penalized',
      );
      scored.push({
        itemId: entry.itemId,
        score: computeRawScore(
          { ...entry.conversion.velocity, anomalyPenalty: burst.penalty },
          entry.params,
        ),
      });
    } else {
      scored.push({ itemId: entry.itemId, score: entry.score });
    }
  }

  // Daily-count path (npm/PyPI downloads, MCP fallback aliases).
  const daily = await loadDailySeries(deps.db, source, t, window);
  for (const row of daily) {
    const params = paramsFor(source, row.metric, window);
    const conversion = toDailyVelocityInput(row, window, t, params);
    if (!row.flagged && conversion.velocity.anomalyPenalty < 1) {
      scoringAnomalies.inc({ source, type: 'spike' });
    }
    scored.push({
      itemId: row.itemId,
      score: computeRawScore(conversion.velocity, params),
    });
  }

  // §8.2 step 8: z and percentile are computed over the eligible set only.
  const eligible = scored.filter((entry) => entry.score.finalScore > 0);
  const zScores = robustZ(eligible.map((entry) => entry.score.finalScore));
  const percentiles = percentileRanks(eligible.map((entry) => entry.score.finalScore));

  // Source-board order: final desc, tie-broken by z desc then itemId for determinism.
  const ranked: ReadyScore[] = eligible
    .map((entry, index) => ({
      ...entry,
      zScore: zScores[index] ?? 0,
      percentile: percentiles[index] ?? 0,
    }))
    .sort(
      (a, b) =>
        b.score.finalScore - a.score.finalScore ||
        b.zScore - a.zScore ||
        (a.itemId === b.itemId ? 0 : a.itemId < b.itemId ? -1 : 1),
    )
    .map((entry, index) => ({ ...entry, rankSource: index + 1 }));

  scoringItems.set({ source, window, eligibility: 'eligible' }, eligible.length);
  scoringItems.set({ source, window, eligibility: 'ineligible' }, scored.length - eligible.length);

  const rows: ScoreUpsert[] = ranked.map((entry) => ({
    itemId: entry.itemId,
    window,
    runId,
    source,
    computedAt: t,
    delta: entry.score.delta,
    base: entry.score.base,
    relGrowth: entry.score.relGrowth,
    rawScore: entry.score.rawScore,
    ageFactor: entry.score.ageFactor,
    confidence: entry.score.confidence,
    anomalyPenalty: entry.score.anomalyPenalty,
    finalScore: entry.score.finalScore,
    zScore: entry.zScore,
    percentile: entry.percentile,
    rankSource: entry.rankSource,
    flags: entry.score.flags,
  }));

  let inserted = 0;
  await deps.db.transaction(async (tx) => {
    inserted = await insertScores(tx, rows);
    await swapCurrentRun(tx, { source, window, runId, computedAt: t });
  });

  scoringDuration.observe({ source, window }, (Date.now() - startedAt) / 1000);
  return { seen: cumulative.length + daily.length, inserted };
}

/**
 * Spec §8.2 step 9 — rank the combined board across the current runs of every
 * source for one window and persist the placements as `scores.rank_all`.
 * Rows that fall outside the share cap keep (or get) NULL; the reset first
 * clears ranks of a previous rebuild so a shrinking board cannot leave stale
 * positions behind. Returns how many rows were ranked.
 */
export async function rebuildAllBoard(
  db: DbExecutor,
  window: Window,
  options: { topN?: number; maxShare?: number } = {},
): Promise<number> {
  const result = await db.execute<{
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

  const placements = buildAllBoard(
    result.rows.map((row) => ({
      itemId: BigInt(row.itemId),
      source: row.source,
      zScore: row.zScore,
      percentile: row.percentile,
      finalScore: row.finalScore,
    })),
    { topN: options.topN ?? ALL_BOARD_TOP_N, maxShare: options.maxShare ?? ALL_BOARD_MAX_SHARE },
  );

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE scores s
      SET rank_all = NULL
      WHERE s.window = ${window}
        AND s.rank_all IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM score_runs_current c
          WHERE c.source = s.source AND c.window = s.window AND c.run_id = s.run_id
        )`);

    if (placements.length === 0) return;

    const values = sql.join(
      placements.map((placement) => sql`(${placement.itemId}::bigint, ${placement.rank}::int)`),
      sql`, `,
    );
    await tx.execute(sql`
      UPDATE scores s
      SET rank_all = v.rank
      FROM (VALUES ${values}) AS v(item_id, rank)
      WHERE s.item_id = v.item_id AND s.window = ${window}
        AND EXISTS (
          SELECT 1 FROM score_runs_current c
          WHERE c.source = s.source AND c.window = s.window AND c.run_id = s.run_id
        )`);
  });

  return placements.length;
}
