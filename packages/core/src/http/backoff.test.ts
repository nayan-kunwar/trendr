import { describe, expect, it } from 'vitest';

import { backoffDelay } from './backoff.js';

describe('backoffDelay (spec §7.5)', () => {
  it('is full jitter: floor(rnd · min(cap, base · 2^attempt))', () => {
    expect(backoffDelay(0, 500, 10_000, () => 0.5)).toBe(250);
    expect(backoffDelay(1, 500, 10_000, () => 0.5)).toBe(500);
    expect(backoffDelay(2, 500, 10_000, () => 0.5)).toBe(1_000);
    expect(backoffDelay(3, 500, 10_000, () => 0.5)).toBe(2_000);
  });

  it('returns 0 when the random source does', () => {
    expect(backoffDelay(4, 500, 10_000, () => 0)).toBe(0);
  });

  it('pins the exponential window at the cap', () => {
    // base · 2^10 = 512_000 > cap, so the window is exactly capMs.
    expect(backoffDelay(10, 500, 10_000, () => 0.999999999)).toBeLessThan(10_000);
    expect(backoffDelay(10, 500, 10_000, () => 0.999999999)).toBeGreaterThan(9_900);
  });

  it('defaults to base 1 s and cap 5 min', () => {
    const value = backoffDelay(20, undefined, undefined, () => 0.999999999);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(5 * 60_000);
    expect(backoffDelay(0, undefined, undefined, () => 0.5)).toBe(500);
  });

  it('stays within [0, window] for the real Math.random', () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const value = backoffDelay(attempt, 500, 10_000);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(Math.min(10_000, 500 * 2 ** attempt));
    }
  });
});
