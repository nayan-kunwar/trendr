import { sql, type SQL } from 'drizzle-orm';

import {
  METRIC_KIND,
  WINDOW_DAYS,
  WINDOW_HOURS,
  type CumulativeSeriesRow,
  type DailySeriesRow,
  type Metric,
  type Source,
  type Tier,
  type Window,
} from '@trendr/core';

import type { DbExecutor } from '../client.js';

/** A §8.6 cumulative row plus the identity the scoring run needs. */
export interface LoadedCumulativeSeries extends CumulativeSeriesRow {
  itemId: bigint;
}

/** A §8.6 daily-count row plus the identity the scoring run needs. */
export interface LoadedDailySeries extends DailySeriesRow {
  itemId: bigint;
}

/**
 * `loadSeries` (spec §8.6): the one endpoint query per (source, window) for
 * cumulative metrics, the `daily_metrics` fallback for items whose brackets are
 * both missing, and the single aggregate for daily-count metrics. All bounds
 * are passed as computed timestamps so the query text stays index-friendly.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** §8.6 outer bound: the largest staleness limit (cold tier). */
const OUTER_STALENESS_MS = 36 * HOUR_MS;

/** Spec §8.1 tolerance `τ_W = max(2 h, 0.1·W)`. */
function windowToleranceMs(w: Window): number {
  return Math.max(2 * HOUR_MS, 0.1 * WINDOW_HOURS[w] * HOUR_MS);
}

function windowStartMs(t: Date, w: Window): number {
  return t.getTime() - WINDOW_HOURS[w] * HOUR_MS;
}

/** Primary metrics of one §5 kind, as a `metric_t[]` SQL expression. */
function metricKindList(kind: 'cumulative' | 'daily_count'): SQL {
  const metrics = (Object.keys(METRIC_KIND) as Metric[]).filter(
    (metric) => METRIC_KIND[metric] === kind,
  );
  return sql`ANY(ARRAY[${sql.join(
    metrics.map((metric) => sql`${metric}`),
    sql`, `,
  )}]::metric_t[])`;
}

function toNumber(value: string | number | null): number | null {
  return value === null ? null : typeof value === 'number' ? value : Number(value);
}

/**
 * Raw `db.execute` results bypass drizzle's column mappers, so timestamptz
 * columns arrive as text (see `docs/SPEC_REVIEW.md`); normalize both shapes.
 */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toOptionalDate(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}

/**
 * One row per item with a snapshot inside the 36 h outer bound, carrying both
 * interpolation brackets around `t − W`, the first observation in the window,
 * and the tier for the TypeScript staleness split (spec §8.6). `dailyFallback`
 * is filled by `loadDailyFallback` for rows whose brackets are both null.
 */
export async function loadCumulativeSeries(
  db: DbExecutor,
  source: Source,
  t: Date,
  w: Window,
): Promise<LoadedCumulativeSeries[]> {
  const tW = new Date(windowStartMs(t, w));
  const toleranceMs = windowToleranceMs(w);
  const toleranceFrom = new Date(tW.getTime() - toleranceMs);
  const toleranceTo = new Date(tW.getTime() + toleranceMs);
  const outerFrom = new Date(t.getTime() - OUTER_STALENESS_MS);

  const result = await db.execute<{
    itemId: string;
    metric: Metric;
    upstreamCreatedAt: Date | string | null;
    tier: Tier;
    flagged: boolean;
    vNow: string;
    tNow: Date | string;
    vBefore: string | null;
    tBefore: Date | string | null;
    vAfter: string | null;
    tAfter: Date | string | null;
    vFirst: string | null;
    tFirst: Date | string | null;
  }>(sql`
    WITH tracked AS (
      SELECT id, primary_metric, upstream_created_at, tier,
             ('burst_suspected' = ANY(flags)) AS flagged
      FROM items
      WHERE source = ${source}
        AND NOT is_deleted
        AND tier <> 'archived'
        AND NOT ('manual_hidden' = ANY(flags))
        AND primary_metric = ${metricKindList('cumulative')}
    ),
    now_v AS (
      SELECT DISTINCT ON (s.item_id) s.item_id, s.value, s.captured_at
      FROM snapshots s JOIN tracked t ON t.id = s.item_id AND s.metric = t.primary_metric
      WHERE s.captured_at BETWEEN ${outerFrom} AND ${t}
      ORDER BY s.item_id, s.captured_at DESC
    ),
    before_v AS (
      SELECT DISTINCT ON (s.item_id) s.item_id, s.value, s.captured_at
      FROM snapshots s JOIN tracked t ON t.id = s.item_id AND s.metric = t.primary_metric
      WHERE s.captured_at BETWEEN ${toleranceFrom} AND ${tW}
      ORDER BY s.item_id, s.captured_at DESC
    ),
    after_v AS (
      SELECT DISTINCT ON (s.item_id) s.item_id, s.value, s.captured_at
      FROM snapshots s JOIN tracked t ON t.id = s.item_id AND s.metric = t.primary_metric
      WHERE s.captured_at > ${tW} AND s.captured_at <= ${toleranceTo}
      ORDER BY s.item_id, s.captured_at ASC
    ),
    first_v AS (
      SELECT DISTINCT ON (s.item_id) s.item_id, s.value, s.captured_at
      FROM snapshots s JOIN tracked t ON t.id = s.item_id AND s.metric = t.primary_metric
      WHERE s.captured_at > ${tW} AND s.captured_at <= ${t}
      ORDER BY s.item_id, s.captured_at ASC
    )
    SELECT t.id::text AS "itemId", t.primary_metric AS "metric",
           t.upstream_created_at AS "upstreamCreatedAt", t.tier, t.flagged,
           n.value::text AS "vNow", n.captured_at AS "tNow",
           b.value::text AS "vBefore", b.captured_at AS "tBefore",
           a.value::text AS "vAfter", a.captured_at AS "tAfter",
           f.value::text AS "vFirst", f.captured_at AS "tFirst"
    FROM tracked t
    JOIN now_v n ON n.item_id = t.id
    LEFT JOIN before_v b ON b.item_id = t.id
    LEFT JOIN after_v a ON a.item_id = t.id
    LEFT JOIN first_v f ON f.item_id = t.id`);

  return result.rows.map((row) => ({
    itemId: BigInt(row.itemId),
    metric: row.metric,
    tier: row.tier,
    upstreamCreatedAt: toOptionalDate(row.upstreamCreatedAt),
    flagged: row.flagged,
    vNow: toNumber(row.vNow) ?? 0,
    tNow: toDate(row.tNow),
    vBefore: toNumber(row.vBefore),
    tBefore: toOptionalDate(row.tBefore),
    vAfter: toNumber(row.vAfter),
    tAfter: toOptionalDate(row.tAfter),
    vFirst: toNumber(row.vFirst),
    tFirst: toOptionalDate(row.tFirst),
    dailyFallback: null,
  }));
}

/**
 * §8.6 second pass, run only for items whose `v_before` and `v_after` are both
 * null: the `daily_metrics` end-of-day value of the item's primary metric for
 * the UTC day before `t − W`. Missing rows are simply absent from the map.
 */
export async function loadDailyFallback(
  db: DbExecutor,
  itemIds: readonly bigint[],
  t: Date,
  w: Window,
): Promise<Map<bigint, number>> {
  if (itemIds.length === 0) return new Map();

  const tW = windowStartMs(t, w);
  const fallbackDay = new Date(tW - DAY_MS).toISOString().slice(0, 10);

  const result = await db.execute<{ itemId: string; value: string }>(sql`
    SELECT DISTINCT ON (d.item_id) d.item_id::text AS "itemId", d.value::text AS value
    FROM daily_metrics d
    JOIN items i ON i.id = d.item_id
    WHERE d.item_id IN (${sql.join(
      itemIds.map((itemId) => sql`${itemId}`),
      sql`, `,
    )})
      AND d.metric = i.primary_metric
      AND d.day = ${fallbackDay}::date
    ORDER BY d.item_id`);

  return new Map(result.rows.map((row) => [BigInt(row.itemId), Number(row.value)]));
}

/**
 * §8.6 daily-count aggregate, one query per (source, window): per item
 * `D = max(day)` strictly before the scoring day, then
 * `S_cur = Σ [D−n+1, D]`, coverage = days present over the window, `S_prev`
 * per §8.1 (24h: 7-day mean of [D−7, D−1]; 7d: Σ [D−13, D−7]; 30d: Σ
 * [D−59, D−30]) and the last 15 daily values for spike detection. Freshness
 * (`D ≥ today − 3`) is applied in TypeScript by `toDailyVelocityInput`.
 */
export async function loadDailySeries(
  db: DbExecutor,
  source: Source,
  t: Date,
  w: Window,
): Promise<LoadedDailySeries[]> {
  const n = WINDOW_DAYS[w];
  // Distances from D for the S_prev range (§8.1): 24h [D−7, D−1], 7d [D−13, D−7],
  // 30d [D−59, D−30]; the first is a mean, the others are sums.
  const prevNear = w === '24h' ? 1 : w === '7d' ? 7 : 30;
  const prevFar = w === '24h' ? 7 : w === '7d' ? 13 : 59;
  const prevIsMean = w === '24h';

  const result = await db.execute<{
    itemId: string;
    metric: Metric;
    upstreamCreatedAt: Date | string | null;
    latestDay: string;
    sCur: string | null;
    sPrevSum: string | null;
    sPrevAvg: string | null;
    curDaysPresent: string;
    recentDaily: string[] | null;
    flagged: boolean;
  }>(sql`
    WITH tracked AS (
      SELECT id, primary_metric, upstream_created_at, tier,
             ('burst_suspected' = ANY(flags)) AS flagged
      FROM items
      WHERE source = ${source}
        AND NOT is_deleted
        AND tier <> 'archived'
        AND NOT ('manual_hidden' = ANY(flags))
        AND primary_metric = ${metricKindList('daily_count')}
    ),
    bounds AS (
      SELECT t.id, t.primary_metric, t.upstream_created_at, t.tier, t.flagged,
             max(d.day) AS latest_day
      FROM tracked t
      JOIN daily_metrics d ON d.item_id = t.id AND d.metric = t.primary_metric
      WHERE d.day < ((${t})::timestamptz AT TIME ZONE 'UTC')::date
      GROUP BY t.id, t.primary_metric, t.upstream_created_at, t.tier, t.flagged
    ),
    agg AS (
      SELECT b.id, b.primary_metric, b.upstream_created_at, b.tier, b.flagged, b.latest_day,
             coalesce(sum(d.value)
               FILTER (WHERE d.day BETWEEN b.latest_day - (${n - 1})::int AND b.latest_day), 0) AS s_cur,
             sum(d.value)
               FILTER (WHERE d.day BETWEEN b.latest_day - (${prevFar})::int AND b.latest_day - (${prevNear})::int) AS s_prev_sum,
             avg(d.value)
               FILTER (WHERE d.day BETWEEN b.latest_day - (${prevFar})::int AND b.latest_day - (${prevNear})::int) AS s_prev_avg,
             count(*)
               FILTER (WHERE d.day BETWEEN b.latest_day - (${n - 1})::int AND b.latest_day) AS cur_days,
             array_agg(d.value ORDER BY d.day)
               FILTER (WHERE d.day BETWEEN b.latest_day - 14 AND b.latest_day) AS recent_daily
      FROM bounds b
      JOIN daily_metrics d ON d.item_id = b.id AND d.metric = b.primary_metric
        AND d.day <= b.latest_day AND d.day >= b.latest_day - 59
      GROUP BY b.id, b.primary_metric, b.upstream_created_at, b.tier, b.flagged, b.latest_day
    )
    SELECT id::text AS "itemId", primary_metric AS "metric",
           upstream_created_at AS "upstreamCreatedAt", latest_day::text AS "latestDay",
           s_cur::text AS "sCur", s_prev_sum::text AS "sPrevSum", s_prev_avg::text AS "sPrevAvg",
           cur_days::text AS "curDaysPresent", recent_daily AS "recentDaily", flagged
    FROM agg`);

  return result.rows.map((row) => ({
    itemId: BigInt(row.itemId),
    metric: row.metric,
    upstreamCreatedAt: toOptionalDate(row.upstreamCreatedAt),
    latestDay: row.latestDay,
    sCur: toNumber(row.sCur) ?? 0,
    sPrev: toNumber(prevIsMean ? row.sPrevAvg : row.sPrevSum) ?? 0,
    curDaysPresent: toNumber(row.curDaysPresent) ?? 0,
    recentDaily: (row.recentDaily ?? []).map((value) => Number(value)),
    flagged: row.flagged,
  }));
}

/**
 * §8.6 burst second pass: hourly cumulative values in the window, loaded only
 * for the top candidates by `raw`. Returns oldest → newest per item.
 */
export async function loadHourlySeries(
  db: DbExecutor,
  itemIds: readonly bigint[],
  t: Date,
  w: Window,
): Promise<Map<bigint, number[]>> {
  if (itemIds.length === 0) return new Map();

  const outerFrom = new Date(windowStartMs(t, w));

  const result = await db.execute<{ itemId: string; hourly: string[] }>(sql`
    SELECT s.item_id::text AS "itemId",
           array_agg(s.value::text ORDER BY s.captured_at) AS hourly
    FROM snapshots s
    JOIN items i ON i.id = s.item_id AND i.primary_metric = s.metric
    WHERE s.item_id IN (${sql.join(
      itemIds.map((itemId) => sql`${itemId}`),
      sql`, `,
    )})
      AND s.captured_at > ${outerFrom} AND s.captured_at <= ${t}
    GROUP BY s.item_id`);

  return new Map(result.rows.map((row) => [BigInt(row.itemId), row.hourly.map(Number)]));
}
