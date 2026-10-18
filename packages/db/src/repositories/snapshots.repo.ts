import { sql } from 'drizzle-orm';

import type { Metric } from '@trendr/core';

import type { DbExecutor } from '../client.js';
import { dailyMetrics } from '../schema/metrics.js';
import { snapshots } from '../schema/snapshots.js';

export interface SnapshotUpsert {
  itemId: bigint;
  metric: Metric;
  /** Bucket start: `date_trunc('hour')` for hot/warm, `date_trunc('day')` for cold. */
  capturedAt: Date;
  /** Actual fetch time — the last-writer-wins key. */
  observedAt: Date;
  value: number;
  runId?: bigint | null;
}

export interface ItemMetricPair {
  itemId: bigint;
  metric: Metric;
}

export interface UpsertSnapshotsOptions {
  /**
   * Refresh `items.latest_metrics` / `last_snapshot_at` / `last_seen_at` from
   * the current table contents (spec §6.3). Disable for historical writes
   * (backfill) that must not mark items as freshly seen.
   */
  refreshAggregates?: boolean;
}

/** Rows per statement — keeps parameter counts far below the 65535 limit. */
const UPSERT_CHUNK = 500;
const REFRESH_PAIRS_CHUNK = 500;

/**
 * Bulk upsert into `snapshots` (spec §6.3; the spec lists the `unnest`
 * formulation — the insert builder emits an equivalent multi-row
 * `INSERT ... ON CONFLICT`). Conflicts only update when the incoming
 * observation is newer (`observed_at` last-writer-wins). Callers that must be
 * atomic with item/aggregate writes should run this inside `db.transaction(...)`.
 */
export async function upsertSnapshots(
  db: DbExecutor,
  rows: SnapshotUpsert[],
  options: UpsertSnapshotsOptions = {},
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += UPSERT_CHUNK) {
    const chunk = rows.slice(offset, offset + UPSERT_CHUNK);

    await db
      .insert(snapshots)
      .values(chunk.map((row) => ({ ...row, runId: row.runId ?? null })))
      .onConflictDoUpdate({
        target: [snapshots.itemId, snapshots.metric, snapshots.capturedAt],
        set: {
          value: sql`excluded.value`,
          observedAt: sql`excluded.observed_at`,
          runId: sql`excluded.run_id`,
        },
        setWhere: sql`${snapshots.observedAt} < excluded.observed_at`,
      });
  }

  if ((options.refreshAggregates ?? true) && rows.length > 0) {
    await refreshItemAggregates(
      db,
      rows.map((row) => ({ itemId: row.itemId, metric: row.metric })),
    );
  }
}

/**
 * Recompute `items.latest_metrics` for the touched (item, metric) pairs from
 * the newest snapshot per pair, and bump `last_snapshot_at` / `last_seen_at`.
 */
export async function refreshItemAggregates(
  db: DbExecutor,
  pairs: ItemMetricPair[],
): Promise<void> {
  for (let offset = 0; offset < pairs.length; offset += REFRESH_PAIRS_CHUNK) {
    const chunk = pairs.slice(offset, offset + REFRESH_PAIRS_CHUNK);
    const touchedValues = sql.join(
      chunk.map((pair) => sql`(${pair.itemId}::bigint, ${pair.metric}::metric_t)`),
      sql`, `,
    );

    await db.execute(sql`
      WITH touched(item_id, metric) AS (VALUES ${touchedValues}),
      latest AS (
        SELECT DISTINCT ON (s.item_id, s.metric) s.item_id, s.metric, s.value, s.captured_at
        FROM snapshots s
        JOIN touched t ON t.item_id = s.item_id AND t.metric = s.metric
        ORDER BY s.item_id, s.metric, s.captured_at DESC
      ),
      agg AS (
        SELECT item_id, jsonb_object_agg(metric::text, value) AS metrics, max(captured_at) AS last_captured
        FROM latest
        GROUP BY item_id
      )
      UPDATE items i
      SET latest_metrics = i.latest_metrics || agg.metrics,
          last_snapshot_at = GREATEST(i.last_snapshot_at, agg.last_captured),
          last_seen_at = now()
      FROM agg
      WHERE i.id = agg.item_id`);
  }
}

export interface DailyMetricUpsert {
  itemId: bigint;
  metric: Metric;
  /** 'YYYY-MM-DD' (UTC). */
  day: string;
  value: number;
}

/** Idempotent per-day aggregate upsert (spec §6.3). */
export async function upsertDailyMetrics(db: DbExecutor, rows: DailyMetricUpsert[]): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += UPSERT_CHUNK) {
    const chunk = rows.slice(offset, offset + UPSERT_CHUNK);

    await db
      .insert(dailyMetrics)
      .values(chunk)
      .onConflictDoUpdate({
        target: [dailyMetrics.itemId, dailyMetrics.metric, dailyMetrics.day],
        set: { value: sql`excluded.value` },
      });
  }
}

/**
 * `maintenance:rollup-daily` (spec §6.3): end-of-day level for the cumulative
 * metrics of one UTC day, taken from `snapshots`. Returns rows written.
 */
export async function rollupDailyMetrics(db: DbExecutor, day: string): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO daily_metrics (item_id, metric, day, value)
    SELECT DISTINCT ON (item_id, metric) item_id, metric, ${day}::date, value
    FROM snapshots
    WHERE captured_at >= ${day}::date AND captured_at < ${day}::date + 1
      AND metric IN ('stars','forks','likes','upvotes','downloads_total','comments','watchers')
    ORDER BY item_id, metric, captured_at DESC
    ON CONFLICT (item_id, metric, day) DO UPDATE SET value = EXCLUDED.value`);

  return result.rowCount ?? 0;
}
