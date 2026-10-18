import { describe, expect, it } from 'vitest';

import {
  STALENESS_LIMIT_HOURS,
  computeRawScore,
  detectBurst,
  detectDailySpike,
  interpolateValue,
  paramsFor,
  toDailyVelocityInput,
  toVelocityInput,
  type CumulativeSeriesRow,
  type DailySeriesRow,
} from '../src/scoring/index.js';

/**
 * Spec §8.1 V_then sourcing rules, §8.6 staleness split (SQL outer bound vs
 * tier-specific TypeScript check), §8.8 counter-reset handling and the §8.5
 * anomaly detectors.
 */

const T0 = new Date('2026-10-18T12:00:00.000Z');
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const GITHUB_7D = paramsFor('github', 'stars', '7d');
const NPM_7D = paramsFor('npm', 'downloads', '7d');

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

function cumRow(overrides: Partial<CumulativeSeriesRow> = {}): CumulativeSeriesRow {
  return Object.assign(
    {
      metric: 'stars',
      tier: 'warm',
      upstreamCreatedAt: null,
      vNow: 1000,
      tNow: T0,
      vBefore: null,
      tBefore: null,
      vAfter: null,
      tAfter: null,
      vFirst: null,
      tFirst: null,
      dailyFallback: null,
      flagged: false,
    } satisfies CumulativeSeriesRow,
    overrides,
  );
}

function dailyRow(overrides: Partial<DailySeriesRow> = {}): DailySeriesRow {
  return Object.assign(
    {
      metric: 'downloads',
      upstreamCreatedAt: null,
      latestDay: '2026-10-18',
      sCur: 25_000,
      sPrev: 10_000,
      curDaysPresent: 7,
      recentDaily: [],
      flagged: false,
    } satisfies DailySeriesRow,
    overrides,
  );
}

function repeat(value: number, times: number): number[] {
  return Array.from({ length: times }, () => value);
}

describe('interpolateValue (spec §8.1)', () => {
  it('interpolates linearly between the bracketing snapshots', () => {
    const value = interpolateValue(
      { value: 800, at: new Date(T0.getTime() - 30 * MINUTE_MS) },
      { value: 900, at: new Date(T0.getTime() + 30 * MINUTE_MS) },
      T0,
    );
    expect(value).toBe(850);
  });

  it('weights by the actual position between the brackets', () => {
    const value = interpolateValue(
      { value: 800, at: new Date(T0.getTime() - 40 * MINUTE_MS) },
      { value: 900, at: new Date(T0.getTime() + 120 * MINUTE_MS) },
      T0,
    );
    expect(value).toBe(825);
  });

  it('clamps outside the bracket span', () => {
    const before = { value: 800, at: new Date(T0.getTime() - 30 * MINUTE_MS) };
    const after = { value: 900, at: new Date(T0.getTime() + 30 * MINUTE_MS) };
    expect(interpolateValue(before, after, at(-5 * HOUR_MS))).toBe(800);
    expect(interpolateValue(before, after, at(5 * HOUR_MS))).toBe(900);
  });

  it('returns null when either bracket is missing', () => {
    const before = { value: 800, at: new Date(T0.getTime() - 30 * MINUTE_MS) };
    expect(interpolateValue(null, before, T0)).toBeNull();
    expect(interpolateValue(before, null, T0)).toBeNull();
  });

  it('guards against a reversed span', () => {
    const reversed = interpolateValue(
      { value: 800, at: new Date(T0.getTime() + HOUR_MS) },
      { value: 900, at: new Date(T0.getTime() - HOUR_MS) },
      T0,
    );
    expect(reversed).toBe(800);
  });
});

describe('toVelocityInput — V_then sourcing (spec §8.1)', () => {
  it('treats an item created inside the window as truly new (B = 0, c = 1)', () => {
    const row = cumRow({ upstreamCreatedAt: at(-5 * DAY_MS), vNow: 1000 });
    const conversion = toVelocityInput(row, '7d', T0);
    expect(conversion.thenSource).toBe('new_item');
    expect(conversion.reset).toBe(false);
    expect(conversion.velocity).toMatchObject({ base: 0, delta: 1000, coverage: 1 });
  });

  it('uses the window boundary itself as "created in window" (>= t − W)', () => {
    const row = cumRow({ upstreamCreatedAt: at(-7 * DAY_MS), vNow: 1000 });
    expect(toVelocityInput(row, '7d', T0).thenSource).toBe('new_item');
  });

  it('interpolates when both brackets around t − W exist', () => {
    const row = cumRow({
      vBefore: 800,
      tBefore: at(-7 * DAY_MS - 30 * MINUTE_MS),
      vAfter: 900,
      tAfter: at(-7 * DAY_MS + 30 * MINUTE_MS),
      vNow: 1000,
    });
    const conversion = toVelocityInput(row, '7d', T0);
    expect(conversion.thenSource).toBe('interpolated');
    expect(conversion.velocity).toMatchObject({ base: 850, delta: 150, coverage: 1 });
  });

  it('prefers interpolation over the daily fallback and first observation', () => {
    const row = cumRow({
      vBefore: 800,
      tBefore: at(-7 * DAY_MS - 30 * MINUTE_MS),
      vAfter: 900,
      tAfter: at(-7 * DAY_MS + 30 * MINUTE_MS),
      dailyFallback: 999,
      vFirst: 990,
      tFirst: at(-3 * DAY_MS),
    });
    expect(toVelocityInput(row, '7d', T0).thenSource).toBe('interpolated');
  });

  it('falls back to the daily end-of-day value when interpolation is impossible', () => {
    const row = cumRow({
      vBefore: 800,
      tBefore: at(-7 * DAY_MS - 30 * MINUTE_MS),
      dailyFallback: 700,
      vFirst: 400,
      tFirst: at(-3 * DAY_MS),
    });
    const conversion = toVelocityInput(row, '7d', T0);
    expect(conversion.thenSource).toBe('daily_fallback');
    expect(conversion.velocity).toMatchObject({ base: 700, delta: 300, coverage: 3 / 7 });
  });

  it('tracks late with V_first and c = (t − t_first)/W when nothing else exists', () => {
    const row = cumRow({ vFirst: 400, tFirst: at(-3 * DAY_MS) });
    const conversion = toVelocityInput(row, '7d', T0);
    expect(conversion.thenSource).toBe('tracked_late');
    expect(conversion.velocity).toMatchObject({ base: 400, delta: 600, coverage: 3 / 7 });
  });

  it('clamps coverage to 1 when the first observation predates the window', () => {
    const row = cumRow({ vFirst: 400, tFirst: at(-10 * DAY_MS) });
    expect(toVelocityInput(row, '7d', T0).velocity.coverage).toBe(1);
  });

  it('reports "none" and zero coverage when no observation exists in the window', () => {
    const conversion = toVelocityInput(cumRow(), '7d', T0);
    expect(conversion.thenSource).toBe('none');
    expect(conversion.velocity.coverage).toBe(0);

    const scored = computeRawScore(conversion.velocity, GITHUB_7D);
    expect(scored.finalScore).toBe(0);
    expect(scored.flags).toContain('insufficient_data');
  });

  it('carries ageDays from upstream_created_at and isPaper from the caller', () => {
    const old = cumRow({ upstreamCreatedAt: at(-40 * DAY_MS), dailyFallback: 700 });
    expect(toVelocityInput(old, '7d', T0).velocity.ageDays).toBe(40);
    expect(toVelocityInput(old, '7d', T0).velocity.isPaper).toBe(false);
    expect(toVelocityInput(old, '7d', T0, { isPaper: true }).velocity.isPaper).toBe(true);

    const unknown = cumRow({ dailyFallback: 700 });
    expect(toVelocityInput(unknown, '7d', T0).velocity.ageDays).toBeNull();
  });
});

describe('counter reset (spec §8.8)', () => {
  it('flags a drop below half of V_then and forces insufficient_data', () => {
    const row = cumRow({
      vBefore: 1000,
      tBefore: at(-7 * DAY_MS - 30 * MINUTE_MS),
      vAfter: 1000,
      tAfter: at(-7 * DAY_MS + 30 * MINUTE_MS),
      vNow: 400,
    });
    const conversion = toVelocityInput(row, '7d', T0);
    expect(conversion.reset).toBe(true);
    expect(conversion.velocity.coverage).toBe(0);

    const scored = computeRawScore(conversion.velocity, GITHUB_7D);
    expect(scored.flags).toContain('insufficient_data');
    expect(scored.finalScore).toBe(0);
  });

  it('does not flag exactly half (strict <)', () => {
    const row = cumRow({
      vBefore: 1000,
      tBefore: at(-7 * DAY_MS - 30 * MINUTE_MS),
      vAfter: 1000,
      tAfter: at(-7 * DAY_MS + 30 * MINUTE_MS),
      vNow: 500,
    });
    const conversion = toVelocityInput(row, '7d', T0);
    expect(conversion.reset).toBe(false);
    expect(conversion.velocity.coverage).toBe(1);
  });
});

describe('staleness limits (spec §8.6)', () => {
  it('uses 3 h / 12 h / 36 h for hot / warm / cold', () => {
    expect(STALENESS_LIMIT_HOURS.hot).toBe(3);
    expect(STALENESS_LIMIT_HOURS.warm).toBe(12);
    expect(STALENESS_LIMIT_HOURS.cold).toBe(36);
  });

  it('marks snapshots older than the tier limit stale, one minute earlier not', () => {
    const tiers = [
      ['hot', 3],
      ['warm', 12],
      ['cold', 36],
    ] as const;

    for (const [tier, hours] of tiers) {
      const fresh = cumRow({ tier, tNow: at(-hours * HOUR_MS + MINUTE_MS) });
      expect(toVelocityInput(fresh, '7d', T0).velocity.stale).toBe(false);

      const stale = cumRow({ tier, tNow: at(-hours * HOUR_MS - MINUTE_MS) });
      expect(toVelocityInput(stale, '7d', T0).velocity.stale).toBe(true);
    }
  });

  it('halves confidence for stale data without touching the raw score', () => {
    const freshRow = cumRow({
      tier: 'hot',
      tNow: at(-HOUR_MS),
      vBefore: 800,
      tBefore: at(-7 * DAY_MS - 30 * MINUTE_MS),
      vAfter: 900,
      tAfter: at(-7 * DAY_MS + 30 * MINUTE_MS),
    });
    const staleRow = cumRow({
      tier: 'hot',
      tNow: at(-5 * HOUR_MS),
      vBefore: 800,
      tBefore: at(-7 * DAY_MS - 30 * MINUTE_MS),
      vAfter: 900,
      tAfter: at(-7 * DAY_MS + 30 * MINUTE_MS),
    });

    const fresh = computeRawScore(toVelocityInput(freshRow, '7d', T0).velocity, GITHUB_7D);
    const stale = computeRawScore(toVelocityInput(staleRow, '7d', T0).velocity, GITHUB_7D);
    expect(stale.rawScore).toBeCloseTo(fresh.rawScore, 12);
    expect(stale.confidence).toBeCloseTo(fresh.confidence / 2, 12);
  });
});

describe('cumulative anomalies and flags', () => {
  it('applies p = 0.5 while the item carries the burst_suspected flag (spec §8.5)', () => {
    const row = cumRow({ flagged: true, dailyFallback: 700, vFirst: 400, tFirst: at(-3 * DAY_MS) });
    const conversion = toVelocityInput(row, '7d', T0);
    expect(conversion.velocity.anomalyPenalty).toBe(0.5);
    const scored = computeRawScore(conversion.velocity, GITHUB_7D);
    expect(scored.flags).toContain('burst_suspected');
  });

  it('uses r_max as the cap for very high relative growth', () => {
    const conversion = toVelocityInput(cumRow({ vNow: 7000 }), '7d', T0); // B = 0 → new? no: not created in window
    // No observation source → coverage 0; use a truly new item instead.
    expect(conversion.velocity.coverage).toBe(0);

    const fresh = toVelocityInput(cumRow({ upstreamCreatedAt: at(-DAY_MS), vNow: 6000 }), '7d', T0);
    const scored = computeRawScore(fresh.velocity, GITHUB_7D);
    expect(scored.relGrowth).toBe(50);
  });
});

describe('daily counts (spec §8.1)', () => {
  it('computes Δ = S_cur − S_prev with full coverage for a 7d window', () => {
    const conversion = toDailyVelocityInput(dailyRow(), '7d', T0, NPM_7D);
    expect(conversion.expired).toBe(false);
    expect(conversion.velocity).toMatchObject({
      delta: 15_000,
      base: 10_000,
      coverage: 1,
      stale: false,
      isPaper: false,
    });

    const scored = computeRawScore(conversion.velocity, NPM_7D);
    expect(scored.finalScore).toBeCloseTo(4.7002, 3);
  });

  it('clamps coverage to 1 when more days than required are present', () => {
    const conversion = toDailyVelocityInput(dailyRow({ curDaysPresent: 9 }), '7d', T0, NPM_7D);
    expect(conversion.velocity.coverage).toBe(1);
  });

  it('reports gaps as coverage < 1 (missing days are not zero)', () => {
    const conversion = toDailyVelocityInput(dailyRow({ curDaysPresent: 5 }), '7d', T0, NPM_7D);
    expect(conversion.velocity.coverage).toBeCloseTo(5 / 7, 12);

    const scored = computeRawScore(conversion.velocity, NPM_7D);
    expect(scored.confidence).toBeCloseTo(Math.sqrt(5 / 7), 12);
  });

  it('treats 24h as a single required day against the weekly mean', () => {
    const conversion = toDailyVelocityInput(
      dailyRow({ sCur: 3000, sPrev: 2000, curDaysPresent: 1 }),
      '24h',
      T0,
      paramsFor('npm', 'downloads', '24h'),
    );
    expect(conversion.velocity).toMatchObject({ delta: 1000, base: 2000, coverage: 1 });
  });

  it('excludes stale daily data (D < today − 3) with insufficient_data', () => {
    const fresh = toDailyVelocityInput(dailyRow({ latestDay: '2026-10-15' }), '7d', T0, NPM_7D);
    expect(fresh.expired).toBe(false);

    const expired = toDailyVelocityInput(dailyRow({ latestDay: '2026-10-14' }), '7d', T0, NPM_7D);
    expect(expired.expired).toBe(true);
    expect(expired.velocity.coverage).toBe(0);
    const scored = computeRawScore(expired.velocity, NPM_7D);
    expect(scored.flags).toContain('insufficient_data');
    expect(scored.finalScore).toBe(0);
  });

  it('drops below the coverage floor for sparse 30d windows', () => {
    const conversion = toDailyVelocityInput(
      dailyRow({ curDaysPresent: 3 }),
      '30d',
      T0,
      paramsFor('npm', 'downloads', '30d'),
    );
    expect(conversion.velocity.coverage).toBeCloseTo(0.1, 12);
    const scored = computeRawScore(conversion.velocity, paramsFor('npm', 'downloads', '30d'));
    expect(scored.flags).toContain('insufficient_data');
  });

  it('applies the daily-spike penalty when the last day explodes past the prior median', () => {
    const spike = toDailyVelocityInput(
      dailyRow({ recentDaily: [...repeat(100, 14), 25_000] }),
      '7d',
      T0,
      NPM_7D,
    );
    expect(spike.velocity.anomalyPenalty).toBe(0.7);
    const scored = computeRawScore(spike.velocity, NPM_7D);
    expect(scored.flags).toContain('burst_suspected');

    const calm = toDailyVelocityInput(
      dailyRow({ recentDaily: [...repeat(100, 14), 1500] }),
      '7d',
      T0,
      NPM_7D,
    );
    expect(calm.velocity.anomalyPenalty).toBe(1);
  });

  it('lets the burst_suspected item flag win over the daily spike (p = 0.5)', () => {
    const conversion = toDailyVelocityInput(
      dailyRow({ recentDaily: [...repeat(100, 14), 25_000], flagged: true }),
      '7d',
      T0,
      NPM_7D,
    );
    expect(conversion.velocity.anomalyPenalty).toBe(0.5);
  });

  it('carries ageDays from upstream_created_at for daily rows', () => {
    const conversion = toDailyVelocityInput(
      dailyRow({ upstreamCreatedAt: at(-40 * DAY_MS) }),
      '7d',
      T0,
      NPM_7D,
    );
    expect(conversion.velocity.ageDays).toBe(40);
    expect(conversion.velocity.isPaper).toBe(false);
  });
});

describe('anomaly helpers (spec §8.5)', () => {
  it('detectBurst needs at least 12 hourly points and a positive delta', () => {
    expect(detectBurst(repeat(1000, 11), 500, 300)).toEqual({ penalty: 1 });
    expect(detectBurst(repeat(1000, 24), 0, 300)).toEqual({ penalty: 1 });
  });

  it('detectBurst penalizes a single hour carrying most of the window gain', () => {
    const hourly = [1000];
    for (let i = 0; i < 23; i += 1) hourly.push((hourly.at(-1) ?? 0) + 2);
    hourly.push((hourly.at(-1) ?? 0) + 6000);
    const delta = (hourly.at(-1) ?? 0) - 1000;

    const result = detectBurst(hourly, delta, 300);
    expect(result.penalty).toBe(0.5);
    expect(result.reason).toContain('single-hour +6000');
  });

  it('detectBurst leaves uniform growth alone', () => {
    const hourly = [1000];
    for (let i = 0; i < 24; i += 1) hourly.push((hourly.at(-1) ?? 0) + 2);
    const delta = (hourly.at(-1) ?? 0) - 1000;
    expect(detectBurst(hourly, delta, 300)).toEqual({ penalty: 1 });
  });

  it('detectDailySpike needs 15 days and a day above the absolute floor', () => {
    expect(detectDailySpike(repeat(100, 14), 10_000)).toEqual({ penalty: 1 });
    expect(detectDailySpike([...repeat(100, 14), 5000], 10_000)).toEqual({ penalty: 1 });
  });

  it('detectDailySpike penalizes > 20× the prior median above the floor', () => {
    expect(detectDailySpike([...repeat(100, 14), 25_000], 10_000)).toEqual({ penalty: 0.7 });
  });

  it('detectDailySpike treats a zero prior as 1 (not a divide by zero)', () => {
    expect(detectDailySpike([...repeat(0, 14), 5000], 5000)).toEqual({ penalty: 0.7 });
  });
});
