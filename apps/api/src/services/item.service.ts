import { METRIC_KIND, type Metric } from '@trendr/core';
import {
  loadDailyMetricHistory,
  loadSnapshotDailyHistory,
  loadSnapshotHourlyHistory,
  type DbExecutor,
} from '@trendr/db';

/**
 * Item-series logic shared by `GET /v1/items/:id/history` (spec §10.4) and
 * `GET /v1/compare` (spec §10.1). Framework-free so both routes stay thin and
 * the branching is unit-testable.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Floor a timestamp to the granularity's bucket (the cache key and query grid). */
export function truncateToGranularity(t: Date, granularity: 'hour' | 'day'): Date {
  const unit = granularity === 'hour' ? HOUR_MS : DAY_MS;
  return new Date(Math.floor(t.getTime() / unit) * unit);
}

function dayString(t: Date): string {
  return t.toISOString().slice(0, 10);
}

export interface SeriesPoint {
  /** ISO datetime for `hour`, `YYYY-MM-DD` for `day` points. */
  t: string;
  v: number;
}

/**
 * One (item, metric) series over `[fromT, toT]` at the requested granularity:
 * snapshots for cumulative/gauge metrics, `daily_metrics` for daily counts.
 * Daily-count metrics have no hourly resolution, so their hour series is empty
 * (documented in docs/SPEC_REVIEW.md).
 */
export async function loadMetricSeries(
  db: DbExecutor,
  itemId: bigint,
  metric: Metric,
  granularity: 'hour' | 'day',
  fromT: Date,
  toT: Date,
): Promise<SeriesPoint[]> {
  if (METRIC_KIND[metric] === 'daily_count') {
    if (granularity === 'hour') {
      return [];
    }
    const points = await loadDailyMetricHistory(
      db,
      itemId,
      metric,
      dayString(fromT),
      dayString(toT),
    );
    return points.map((point) => ({ t: point.day, v: point.v }));
  }

  if (granularity === 'hour') {
    const points = await loadSnapshotHourlyHistory(db, itemId, metric, fromT, toT);
    return points.map((point) => ({ t: point.t.toISOString(), v: point.v }));
  }

  const points = await loadSnapshotDailyHistory(
    db,
    itemId,
    metric,
    dayString(fromT),
    dayString(toT),
  );
  return points.map((point) => ({ t: point.day, v: point.v }));
}
