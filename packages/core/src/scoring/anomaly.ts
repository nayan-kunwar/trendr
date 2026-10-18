import { median } from './normalize.js';

/**
 * Spec §8.5 — bursts are penalized and flagged, not removed: a Hacker News
 * front-page spike is legitimate, but it must not dominate the board.
 */

/** `hourly`: cumulative values at consecutive hour buckets within the window (≥ 12 points). */
export function detectBurst(
  hourly: readonly number[],
  delta: number,
  burstMinAbs: number,
): { penalty: number; reason?: string } {
  if (hourly.length < 12 || delta <= 0) return { penalty: 1 };
  const inc = hourly.slice(1).map((v, i) => Math.max(0, v - (hourly[i] ?? v)));
  const maxInc = Math.max(...inc);
  const med = median(inc);
  const mad = median(inc.map((x) => Math.abs(x - med))) || 1;
  const isBurst =
    maxInc >= burstMinAbs && maxInc / delta >= 0.5 && (maxInc - med) / (1.4826 * mad) > 10;
  return isBurst
    ? {
        penalty: 0.5,
        reason: `single-hour +${maxInc} (${Math.round((100 * maxInc) / delta)}% of window)`,
      }
    : { penalty: 1 };
}

/** `daily`: download counts; flags a single day > 20× median of prior 14 days and above absolute floor. */
export function detectDailySpike(
  daily: readonly number[],
  burstMinAbs: number,
): { penalty: number } {
  if (daily.length < 15) return { penalty: 1 };
  const last = daily.at(-1) ?? 0;
  const prior = median(daily.slice(-15, -1));
  return last >= burstMinAbs && last > 20 * Math.max(prior, 1) ? { penalty: 0.7 } : { penalty: 1 };
}
