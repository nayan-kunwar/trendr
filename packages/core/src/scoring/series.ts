import { WINDOW_DAYS, WINDOW_HOURS, type Metric, type Tier, type Window } from '../types.js';
import { detectDailySpike } from './anomaly.js';
import type { ScoringParams } from './params.js';
import type { VelocityInput } from './velocity.js';

/**
 * Spec §8.1/§8.6 — pure conversions from loaded series rows to `VelocityInput`.
 * The spec sketches `toVelocityInput` inside the worker; §16 requires unit
 * tests for it (`tier staleness 3 h/12 h/36 h`), so the pure logic lives here
 * and the worker calls it (placement note in docs/SPEC_REVIEW.md).
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Tier-specific staleness limits in hours (spec §8.6); confidence halves when exceeded. */
export const STALENESS_LIMIT_HOURS: Record<Tier, number> = {
  hot: 3,
  warm: 12,
  cold: 36,
  archived: 36, // archived items are excluded by the series query; this limit is inert
};

export interface Bracket {
  value: number;
  at: Date;
}

/** Linear interpolation at `tW`; null unless both brackets exist (spec §8.1). */
export function interpolateValue(
  before: Bracket | null,
  after: Bracket | null,
  tW: Date,
): number | null {
  if (before === null || after === null) return null;
  const span = after.at.getTime() - before.at.getTime();
  if (span <= 0) return before.value;
  const fraction = (tW.getTime() - before.at.getTime()) / span;
  return before.value + (after.value - before.value) * Math.min(1, Math.max(0, fraction));
}

/** How `V_then` was established — asserted by unit tests, logged by the worker (spec §8.1). */
export type ThenSource = 'new_item' | 'interpolated' | 'daily_fallback' | 'tracked_late' | 'none';

/** One row of the §8.6 endpoint query for a cumulative-primary item. */
export interface CumulativeSeriesRow {
  metric: Metric;
  tier: Tier;
  upstreamCreatedAt: Date | null;
  vNow: number;
  tNow: Date;
  vBefore: number | null;
  tBefore: Date | null;
  vAfter: number | null;
  tAfter: Date | null;
  vFirst: number | null;
  tFirst: Date | null;
  /** `daily_metrics` end-of-day value for the UTC day before `t − W` (fallback pass). */
  dailyFallback: number | null;
  /** `items.flags` contains `burst_suspected` (spec §8.5 star-drop penalty). */
  flagged: boolean;
}

export interface CumulativeConversion {
  velocity: VelocityInput;
  thenSource: ThenSource;
  /** Counter reset detected (spec §8.8): excluded with insufficient_data, logged by the worker. */
  reset: boolean;
}

export function toVelocityInput(
  row: CumulativeSeriesRow,
  w: Window,
  t: Date,
  options: { isPaper?: boolean } = {},
): CumulativeConversion {
  const windowMs = WINDOW_HOURS[w] * HOUR_MS;
  const tMs = t.getTime();
  const tW = new Date(tMs - windowMs);
  const createdMs = row.upstreamCreatedAt?.getTime() ?? null;

  let base = 0;
  let coverage = 0;
  let thenSource: ThenSource = 'none';

  if (createdMs !== null && createdMs >= tMs - windowMs) {
    // Truly new item: we know it started from zero (spec §8.1).
    base = 0;
    coverage = 1;
    thenSource = 'new_item';
  } else {
    const interpolated = interpolateValue(
      row.vBefore === null || row.tBefore === null ? null : { value: row.vBefore, at: row.tBefore },
      row.vAfter === null || row.tAfter === null ? null : { value: row.vAfter, at: row.tAfter },
      tW,
    );
    const tFirstMs = row.tFirst?.getTime() ?? null;
    const lateCoverage =
      tFirstMs === null ? 0 : Math.min(1, Math.max(0, (tMs - tFirstMs) / windowMs));

    if (interpolated !== null) {
      base = interpolated;
      coverage = 1;
      thenSource = 'interpolated';
    } else if (row.dailyFallback !== null) {
      base = row.dailyFallback;
      coverage = lateCoverage;
      thenSource = 'daily_fallback';
    } else if (row.vFirst !== null) {
      // Tracked late: V_first with c = (t − t_first)/W, no extrapolation.
      base = row.vFirst;
      coverage = lateCoverage;
      thenSource = 'tracked_late';
    }
  }

  const reset = base > 0 && row.vNow < 0.5 * base;
  const ageDays = createdMs === null ? null : (tMs - createdMs) / DAY_MS;
  const stale = tMs - row.tNow.getTime() > STALENESS_LIMIT_HOURS[row.tier] * HOUR_MS;

  return {
    thenSource,
    reset,
    velocity: {
      delta: row.vNow - base,
      base,
      coverage: reset ? 0 : coverage, // spec §8.8: reset is a data error → insufficient_data
      stale,
      ageDays,
      isPaper: options.isPaper ?? false,
      anomalyPenalty: row.flagged ? 0.5 : 1,
    },
  };
}

/** One row of the §8.6 daily-count aggregate (npm/PyPI/MCP-via-alias downloads). */
export interface DailySeriesRow {
  metric: Metric;
  upstreamCreatedAt: Date | null;
  /** Latest complete day with data, `'YYYY-MM-DD'` UTC. */
  latestDay: string;
  sCur: number;
  sPrev: number;
  curDaysPresent: number;
  /** Oldest → newest, up to the 15 days ending at `latestDay` (spike detection). */
  recentDaily: number[];
  /** `items.flags` contains `burst_suspected`. */
  flagged: boolean;
}

export interface DailyConversion {
  velocity: VelocityInput;
  /** `D < today − 3` (spec §8.1): excluded with insufficient_data. */
  expired: boolean;
}

export function toDailyVelocityInput(
  row: DailySeriesRow,
  w: Window,
  t: Date,
  p: ScoringParams,
): DailyConversion {
  const todayMs = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  const latestMs = Date.parse(`${row.latestDay}T00:00:00Z`);
  const expired = Number.isNaN(latestMs) || (todayMs - latestMs) / DAY_MS > 3;
  const coverage = expired ? 0 : Math.min(1, row.curDaysPresent / WINDOW_DAYS[w]);
  const spike = detectDailySpike(row.recentDaily, p.burstMinAbs);
  const createdMs = row.upstreamCreatedAt?.getTime() ?? null;

  return {
    expired,
    velocity: {
      delta: row.sCur - row.sPrev,
      base: row.sPrev,
      coverage,
      stale: false, // daily rows carry an explicit D ≥ today − 3 freshness rule instead
      ageDays: createdMs === null ? null : (t.getTime() - createdMs) / DAY_MS,
      isPaper: false, // papers always score on cumulative upvotes (spec §7.3.5)
      anomalyPenalty: row.flagged ? 0.5 : spike.penalty,
    },
  };
}
