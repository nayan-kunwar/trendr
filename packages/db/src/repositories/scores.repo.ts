import { sql } from 'drizzle-orm';

import type { ScoreFlag, Source, Window } from '@trendr/core';

import type { DbExecutor } from '../client.js';
import { scoreRunsCurrent, scores } from '../schema/metrics.js';

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
