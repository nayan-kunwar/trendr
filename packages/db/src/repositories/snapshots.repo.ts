import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';

import type { Metric } from '@trendr/core';

import type { DbExecutor } from '../client.js';
import { items } from '../schema/items.js';
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

export interface UpsertDailyMetricsOptions {
  /**
   * Mirror the newest stored day of each touched `(item, metric)` into
   * `items.latest_metrics`. Daily-count sources keep only `daily_metrics`
   * rows, so the item row would otherwise never show a current download
   * count (the seed models this too). Disable for historical-only writes.
   */
  refreshAggregates?: boolean;
}

/** Idempotent per-day aggregate upsert (spec §6.3). */
export async function upsertDailyMetrics(
  db: DbExecutor,
  rows: DailyMetricUpsert[],
  options: UpsertDailyMetricsOptions = {},
): Promise<void> {
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
  if (options.refreshAggregates === true && rows.length > 0) {
    await refreshLatestMetricsFromDaily(db, rows);
  }
}

/**
 * `items.latest_metrics[metric] = value of the newest day` for every touched
 * pair. One statement per 500 pairs keeps the parameter count bounded; the
 * `DISTINCT ON` mirrors the per-pair "latest row wins" semantics.
 */
async function refreshLatestMetricsFromDaily(
  db: DbExecutor,
  rows: readonly DailyMetricUpsert[],
): Promise<void> {
  const seen = new Set<string>();
  const pairs: { itemId: bigint; metric: Metric }[] = [];
  for (const row of rows) {
    const key = `${row.itemId.toString()}:${row.metric}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ itemId: row.itemId, metric: row.metric });
  }

  for (let offset = 0; offset < pairs.length; offset += REFRESH_PAIRS_CHUNK) {
    const chunk = pairs.slice(offset, offset + REFRESH_PAIRS_CHUNK);
    const tuple = sql.join(
      chunk.map((pair) => sql`(${pair.itemId}, ${pair.metric})`),
      sql`, `,
    );
    await db.execute(sql`
      UPDATE ${items}
      SET latest_metrics = ${items.latestMetrics} || newest.value,
          updated_at = now()
      FROM (
        SELECT item_id, jsonb_object_agg(metric::text, value) AS value
        FROM (
          SELECT DISTINCT ON (item_id, metric) item_id, metric, value
          FROM ${dailyMetrics}
          WHERE (item_id, metric) IN (${tuple})
          ORDER BY item_id, metric, day DESC
        ) AS newest_day
        GROUP BY item_id
      ) AS newest
      WHERE ${items.id} = newest.item_id
    `);
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

export interface SnapshotHistoryPoint {
  /** Snapshot bucket start (hour for hot/warm items, day for cold ones). */
  t: Date;
  v: number;
}

export interface DailyHistoryPoint {
  /** 'YYYY-MM-DD' UTC. */
  day: string;
  v: number;
}

/**
 * Spec §10.1 `/v1/items/:id/history`, hour granularity: the raw snapshot
 * buckets of one (item, metric) in `[from, to]`, oldest first. Cold items
 * only have day-bucketed snapshots, so their hour series is sparse by design.
 */
export async function loadSnapshotHourlyHistory(
  db: DbExecutor,
  itemId: bigint,
  metric: Metric,
  from: Date,
  to: Date,
): Promise<SnapshotHistoryPoint[]> {
  return db
    .select({ t: snapshots.capturedAt, v: snapshots.value })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.itemId, itemId),
        eq(snapshots.metric, metric),
        gte(snapshots.capturedAt, from),
        lte(snapshots.capturedAt, to),
      ),
    )
    .orderBy(asc(snapshots.capturedAt));
}

/**
 * Spec §10.1 history, day granularity for cumulative/gauge metrics: the
 * end-of-day value (last capture) per UTC day in `[fromDay, toDay]`.
 */
export async function loadSnapshotDailyHistory(
  db: DbExecutor,
  itemId: bigint,
  metric: Metric,
  fromDay: string,
  toDay: string,
): Promise<DailyHistoryPoint[]> {
  const result = await db.execute<{ day: string; v: string }>(sql`
    SELECT DISTINCT ON (day) day::text AS day, value::text AS v FROM (
      SELECT (s.captured_at AT TIME ZONE 'UTC')::date AS day, s.value, s.captured_at
      FROM snapshots s
      WHERE s.item_id = ${itemId} AND s.metric = ${metric}
        AND s.captured_at >= (${fromDay}::date::timestamp AT TIME ZONE 'UTC')
        AND s.captured_at < ((${toDay}::date + 1)::timestamp AT TIME ZONE 'UTC')
    ) days
    ORDER BY day, captured_at DESC`);

  return result.rows.map((row) => ({ day: row.day, v: Number(row.v) }));
}

/**
 * Spec §10.1 history, day granularity for daily-count metrics: the per-day
 * aggregates in `[fromDay, toDay]`. These have no hourly resolution, so the
 * hour-granularity endpoint serves an empty series for them.
 */
export async function loadDailyMetricHistory(
  db: DbExecutor,
  itemId: bigint,
  metric: Metric,
  fromDay: string,
  toDay: string,
): Promise<DailyHistoryPoint[]> {
  return db
    .select({ day: dailyMetrics.day, v: dailyMetrics.value })
    .from(dailyMetrics)
    .where(
      and(
        eq(dailyMetrics.itemId, itemId),
        eq(dailyMetrics.metric, metric),
        gte(dailyMetrics.day, fromDay),
        lte(dailyMetrics.day, toDay),
      ),
    )
    .orderBy(asc(dailyMetrics.day));
}
