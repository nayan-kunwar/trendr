import { and, asc, eq, gte, sql } from 'drizzle-orm';

import type { ScoreFlag, Source, Window } from '@trendr/core';

import type { DbExecutor } from '../client.js';
import { scoreRunsCurrent, scores } from '../schema/metrics.js';
import { ingestionRuns } from '../schema/ops.js';

export interface ScoreUpsert {
  itemId: bigint;
  window: Window;
  runId: bigint;
  source: Source;
  computedAt: Date;
  delta: number;
  base: number;
  relGrowth: number;
  rawScore: number;
  ageFactor: number;
  confidence: number;
  anomalyPenalty: number;
  finalScore: number;
  zScore: number;
  percentile: number;
  rankSource?: number | null;
  rankAll?: number | null;
  flags?: ScoreFlag[];
}

/** Values per statement; keeps parameter counts far below the 65535 limit. */
const INSERT_CHUNK = 500;

/**
 * Bulk insert of eligible score rows (spec §8.4: only `final_score > 0` rows
 * are written). Idempotent per `(item_id, window, run_id)` — conflicting rows
 * are ignored, so retries of a scoring run never duplicate. Returns inserted.
 */
export async function insertScores(db: DbExecutor, rows: ScoreUpsert[]): Promise<number> {
  let inserted = 0;

  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
    const chunk = rows
      .slice(offset, offset + INSERT_CHUNK)
      .map((row) => ({ ...row, flags: row.flags ?? [] }));

    const result = await db
      .insert(scores)
      .values(chunk)
      .onConflictDoNothing()
      .returning({ itemId: scores.itemId });

    inserted += result.length;
  }

  return inserted;
}

export interface CurrentRunSwap {
  source: Source;
  window: Window;
  runId: bigint;
  computedAt: Date;
}

/** Atomically point `score_runs_current` at the freshly finished run (spec §8.4). */
export async function swapCurrentRun(db: DbExecutor, swap: CurrentRunSwap): Promise<void> {
  await db
    .insert(scoreRunsCurrent)
    .values(swap)
    .onConflictDoUpdate({
      target: [scoreRunsCurrent.source, scoreRunsCurrent.window],
      set: { runId: swap.runId, computedAt: swap.computedAt },
    });
}

/**
 * `maintenance:retention` for `scores` (spec §6.5): keep every run inside the
 * hourly horizon, then one run per (source, window, UTC day) inside the daily
 * horizon, never deleting a current run. One short `DELETE` per group.
 * Returns the number of deleted rows.
 */
export async function pruneScores(
  db: DbExecutor,
  hourlyHours: number,
  dailyDays: number,
): Promise<number> {
  const groups = await db.execute<{ runId: string; source: Source; window: Window }>(sql`
    WITH runs AS (
      SELECT r.id AS run_id, r.source, w."window", r.started_at,
             (r.started_at AT TIME ZONE 'UTC')::date AS utc_day
      FROM ingestion_runs r
      CROSS JOIN unnest(enum_range(NULL::window_t)) AS w("window")
      WHERE r.job_type = 'score'
        AND r.started_at < now() - make_interval(hours => ${hourlyHours})
        AND EXISTS (SELECT 1 FROM scores s
                    WHERE s.source = r.source AND s."window" = w."window" AND s.run_id = r.id)
    ),
    daily_keep AS (
      SELECT DISTINCT ON (source, "window", utc_day) run_id, source, "window"
      FROM runs
      WHERE started_at >= now() - make_interval(days => ${dailyDays})
      ORDER BY source, "window", utc_day, started_at DESC, run_id DESC
    )
    SELECT run_id AS "runId", source, "window" FROM runs
    EXCEPT SELECT run_id, source, "window" FROM daily_keep
    EXCEPT SELECT run_id, source, "window" FROM score_runs_current`);

  let deleted = 0;

  for (const group of groups.rows) {
    const result = await db.execute(sql`
      DELETE FROM scores
      WHERE source = ${group.source} AND "window" = ${group.window} AND run_id = ${group.runId}`);
    deleted += result.rowCount ?? 0;
  }

  return deleted;
}

/** The current scoring run pointer for one (source, window), if any. */
export async function getCurrentScoreRun(
  db: DbExecutor,
  source: Source,
  window: Window,
): Promise<{ runId: bigint; computedAt: Date } | null> {
  const [row] = await db
    .select({ runId: scoreRunsCurrent.runId, computedAt: scoreRunsCurrent.computedAt })
    .from(scoreRunsCurrent)
    .where(and(eq(scoreRunsCurrent.source, source), eq(scoreRunsCurrent.window, window)));
  return row ?? null;
}

export interface ScoreRunRow {
  delta: number;
  base: number;
  relGrowth: number;
  rawScore: number;
  ageFactor: number;
  confidence: number;
  anomalyPenalty: number;
  finalScore: number;
  zScore: number;
  percentile: number;
  rankSource: number | null;
  rankAll: number | null;
  flags: string[];
}

/** One item's score row for a specific run (spec §10.1 score-explain). */
export async function loadItemScoreForRun(
  db: DbExecutor,
  itemId: bigint,
  window: Window,
  runId: bigint,
): Promise<ScoreRunRow | null> {
  const [row] = await db
    .select({
      delta: scores.delta,
      base: scores.base,
      relGrowth: scores.relGrowth,
      rawScore: scores.rawScore,
      ageFactor: scores.ageFactor,
      confidence: scores.confidence,
      anomalyPenalty: scores.anomalyPenalty,
      finalScore: scores.finalScore,
      zScore: scores.zScore,
      percentile: scores.percentile,
      rankSource: scores.rankSource,
      rankAll: scores.rankAll,
      flags: scores.flags,
    })
    .from(scores)
    .where(and(eq(scores.itemId, itemId), eq(scores.window, window), eq(scores.runId, runId)));
  return row ?? null;
}

export interface ScoreHistoryRow {
  runId: bigint;
  startedAt: Date;
  computedAt: Date;
  finalScore: number;
  zScore: number;
  percentile: number;
  rankSource: number | null;
  delta: number;
}

/**
 * Spec §10.1 `/v1/items/:id/scores`: runs that scored the item since `since`,
 * oldest first. `granularity = 'day'` then keeps the last run of each UTC day —
 * exactly the rows retention preserves beyond the hourly horizon (§6.5), so
 * the same query serves both granularities.
 */
export async function loadItemScoreHistory(
  db: DbExecutor,
  itemId: bigint,
  window: Window,
  granularity: 'hour' | 'day',
  since: Date,
): Promise<ScoreHistoryRow[]> {
  const rows = await db
    .select({
      runId: scores.runId,
      startedAt: ingestionRuns.startedAt,
      computedAt: scores.computedAt,
      finalScore: scores.finalScore,
      zScore: scores.zScore,
      percentile: scores.percentile,
      rankSource: scores.rankSource,
      delta: scores.delta,
    })
    .from(scores)
    .innerJoin(ingestionRuns, eq(ingestionRuns.id, scores.runId))
    .where(
      and(
        eq(scores.itemId, itemId),
        eq(scores.window, window),
        gte(ingestionRuns.startedAt, since),
      ),
    )
    .orderBy(asc(ingestionRuns.startedAt), asc(scores.runId));

  return granularity === 'hour' ? rows : lastRunPerUtcDay(rows);
}

/**
 * The last run of each UTC day (rows must be ordered by `startedAt`, `runId`;
 * later rows overwrite earlier ones), oldest day first. Runs in which the item
 * was ineligible have no row, so their day is simply absent (a gap).
 */
export function lastRunPerUtcDay(rows: readonly ScoreHistoryRow[]): ScoreHistoryRow[] {
  const byDay = new Map<string, ScoreHistoryRow>();
  for (const row of rows) {
    byDay.set(row.startedAt.toISOString().slice(0, 10), row);
  }
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, row]) => row);
}
