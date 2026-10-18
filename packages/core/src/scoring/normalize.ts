/**
 * Spec §8.2 step 8 / §8.4 — robust normalization within `(source, window)`.
 * `median` and the MAD resist the heavy-tailed outliers that `mean`/`sd` would
 * let dominate the board; `x = ln(1 + final)` makes the "top 2%" of npm
 * comparable to the "top 2%" of GitHub.
 */

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  if (s.length % 2 === 1) return s[mid] ?? 0;
  return ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

export function robustZ(values: readonly number[]): number[] {
  const x = values.map((v) => Math.log1p(v));
  const med = median(x);
  const mad = median(x.map((v) => Math.abs(v - med)));
  if (mad === 0) return x.map(() => 0);
  return x.map((v) => Math.min(8, Math.max(-3, (v - med) / (1.4826 * mad))));
}

export function percentileRanks(values: readonly number[]): number[] {
  const idx = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = values.map(() => 0);
  idx.forEach(([, i], r) => {
    out[i] = (100 * (r + 0.5)) / values.length;
  });
  return out;
}
