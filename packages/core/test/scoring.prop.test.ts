import * as fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  computeRawScore,
  paramsFor,
  percentileRanks,
  robustZ,
  type ScoringParams,
  type VelocityInput,
} from '../src/scoring/index.js';

/**
 * Spec §16 property-based tests: `computeRawScore` monotonicity, percentile
 * bounds, robust-z permutation invariance — plus the eligibility-order and
 * age-factor invariants of §8.2. Sixteen properties; fixed seeds keep CI runs
 * reproducible while the arbitraries still explore broadly.
 */

const NO_MIN: ScoringParams = { k: 100, minDelta: 0, beta: 0.35, rMax: 50, burstMinAbs: 1e9 };
const GITHUB_7D = paramsFor('github', 'stars', '7d');

function velocity(overrides: Partial<VelocityInput> = {}): VelocityInput {
  return Object.assign(
    {
      delta: 0,
      base: 0,
      coverage: 1,
      stale: false,
      ageDays: null,
      isPaper: false,
      anomalyPenalty: 1,
    } satisfies VelocityInput,
    overrides,
  );
}

function shuffle(values: readonly number[], seed: number): number[] {
  const out = [...values];
  let state = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const j = state % (i + 1);
    const a = out[i] ?? 0;
    const b = out[j] ?? 0;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

const finiteDouble = (max: number) => fc.double({ min: 0, max, noNaN: true });

describe('computeRawScore properties (spec §16)', () => {
  it('is monotonic non-decreasing in Δ for fixed B', () => {
    fc.assert(
      fc.property(
        finiteDouble(1e6),
        fc.integer({ min: 0, max: 1e6 }),
        fc.integer({ min: 0, max: 1e6 }),
        (base, d1, d2) => {
          const low = Math.min(d1, d2);
          const high = Math.max(d1, d2);
          const a = computeRawScore(velocity({ delta: low, base }), NO_MIN).finalScore;
          const b = computeRawScore(velocity({ delta: high, base }), NO_MIN).finalScore;
          return a <= b + 1e-9;
        },
      ),
      { numRuns: 300, seed: 2_610_180_001 },
    );
  });

  it('is non-increasing in B for fixed Δ', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1e6 }),
        finiteDouble(1e6),
        finiteDouble(1e6),
        (delta, b1, b2) => {
          const low = Math.min(b1, b2);
          const high = Math.max(b1, b2);
          const a = computeRawScore(velocity({ delta, base: low }), NO_MIN).finalScore;
          const b = computeRawScore(velocity({ delta, base: high }), NO_MIN).finalScore;
          return a >= b - 1e-9;
        },
      ),
      { numRuns: 300, seed: 2_610_180_002 },
    );
  });

  it('keeps relGrowth at or below r_max', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e9 }),
        finiteDouble(1e9),
        (delta, base) => computeRawScore(velocity({ delta, base }), NO_MIN).relGrowth <= 50,
      ),
      { numRuns: 300, seed: 2_610_180_003 },
    );
  });

  it('never returns a negative or non-finite final score', () => {
    fc.assert(
      fc.property(
        fc.record({
          delta: fc.integer({ min: -1e9, max: 1e9 }),
          base: finiteDouble(1e9),
          coverage: fc.double({ min: 0, max: 1, noNaN: true }),
          stale: fc.boolean(),
          ageDays: fc.option(fc.integer({ min: 0, max: 4000 }), { nil: null }),
          isPaper: fc.boolean(),
          anomalyPenalty: fc.constantFrom(0.2, 0.5, 0.7, 1),
        }),
        (fields) => {
          const scored = computeRawScore(velocity(fields), GITHUB_7D);
          return scored.finalScore >= 0 && Number.isFinite(scored.finalScore);
        },
      ),
      { numRuns: 300, seed: 2_610_180_004 },
    );
  });

  it('keeps ageFactor inside [1, 1.25] and non-increasing in age', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4000 }),
        fc.integer({ min: 0, max: 4000 }),
        (a1, a2) => {
          const lowAge = Math.min(a1, a2);
          const highAge = Math.max(a1, a2);
          const low = computeRawScore(velocity({ delta: 1000, ageDays: lowAge }), NO_MIN).ageFactor;
          const high = computeRawScore(
            velocity({ delta: 1000, ageDays: highAge }),
            NO_MIN,
          ).ageFactor;
          return low >= high - 1e-12 && low <= 1.25 + 1e-12 && high >= 1 - 1e-12;
        },
      ),
      { numRuns: 300, seed: 2_610_180_005 },
    );
  });

  it('uses τ_age = 7 days for papers and 14 days otherwise', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 365 }), (age) => {
        const paper = computeRawScore(
          velocity({ delta: 1000, ageDays: age, isPaper: true }),
          NO_MIN,
        ).ageFactor;
        const repo = computeRawScore(velocity({ delta: 1000, ageDays: age }), NO_MIN).ageFactor;
        const expectedPaper = 1 + 0.25 * Math.exp(-age / 7);
        const expectedRepo = 1 + 0.25 * Math.exp(-age / 14);
        return Math.abs(paper - expectedPaper) <= 1e-12 && Math.abs(repo - expectedRepo) <= 1e-12;
      }),
      { numRuns: 300, seed: 2_610_180_006 },
    );
  });

  it('keeps confidence in [0, 1] and exactly halves it when stale', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (coverage) => {
        const fresh = computeRawScore(velocity({ delta: 1000, coverage }), NO_MIN);
        const stale = computeRawScore(velocity({ delta: 1000, coverage, stale: true }), NO_MIN);
        return (
          fresh.confidence >= 0 &&
          fresh.confidence <= 1 &&
          Math.abs(stale.confidence - fresh.confidence / 2) <= 1e-12
        );
      }),
      { numRuns: 300, seed: 2_610_180_007 },
    );
  });

  it('excludes coverage below 0.25 with insufficient_data', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 0.2499, noNaN: true }),
        fc.integer({ min: 1, max: 1e6 }),
        (coverage, delta) => {
          const scored = computeRawScore(velocity({ delta, coverage }), NO_MIN);
          return scored.finalScore === 0 && scored.flags.includes('insufficient_data');
        },
      ),
      { numRuns: 300, seed: 2_610_180_008 },
    );
  });

  it('excludes Δ ≤ 0 with negative_growth', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e6, max: 0 }), (delta) => {
        const scored = computeRawScore(velocity({ delta }), NO_MIN);
        return scored.finalScore === 0 && scored.flags.includes('negative_growth');
      }),
      { numRuns: 200, seed: 2_610_180_009 },
    );
  });

  it('excludes 0 < Δ < minDelta with below_threshold', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 29 }), (delta) => {
        const scored = computeRawScore(velocity({ delta }), GITHUB_7D);
        return scored.finalScore === 0 && scored.flags.includes('below_threshold');
      }),
      { numRuns: 200, seed: 2_610_180_010 },
    );
  });

  it('flags new_item exactly when ageDays ≤ 30', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4000 }), (ageDays) => {
        const scored = computeRawScore(velocity({ delta: 1000, ageDays }), NO_MIN);
        return scored.flags.includes('new_item') === ageDays <= 30;
      }),
      { numRuns: 300, seed: 2_610_180_011 },
    );
  });

  it('applies eligibility checks in spec §8.2 order (first match wins)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 0.2499, noNaN: true }),
        fc.integer({ min: -1e6, max: 0 }),
        (coverage, delta) => {
          const scored = computeRawScore(velocity({ delta, coverage }), NO_MIN);
          // Both conditions hold; insufficient_data must win over negative_growth.
          return (
            scored.flags.includes('insufficient_data') && !scored.flags.includes('negative_growth')
          );
        },
      ),
      { numRuns: 200, seed: 2_610_180_012 },
    );
  });
});

describe('normalize properties (spec §16)', () => {
  it('keeps percentileRanks strictly inside (0, 100)', () => {
    fc.assert(
      fc.property(fc.uniqueArray(finiteDouble(1e12), { minLength: 1, maxLength: 50 }), (values) =>
        percentileRanks(values).every((rank) => rank > 0 && rank < 100),
      ),
      { numRuns: 300, seed: 2_610_180_013 },
    );
  });

  it('orders percentileRanks consistently with the values', () => {
    fc.assert(
      fc.property(fc.uniqueArray(finiteDouble(1e12), { minLength: 1, maxLength: 40 }), (values) => {
        const ranks = percentileRanks(values);
        for (let i = 0; i < values.length; i += 1) {
          for (let j = 0; j < values.length; j += 1) {
            const vi = values[i] ?? 0;
            const vj = values[j] ?? 0;
            if (vi < vj && (ranks[i] ?? 0) >= (ranks[j] ?? 0)) return false;
          }
        }
        return true;
      }),
      { numRuns: 200, seed: 2_610_180_014 },
    );
  });

  it('makes robustZ invariant to permutations of the input', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(finiteDouble(1e9), { minLength: 3, maxLength: 30 }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (values, seed) => {
          const shuffled = shuffle(values, seed);
          const originalZ = robustZ(values);
          const shuffledZ = robustZ(shuffled);
          for (let i = 0; i < values.length; i += 1) {
            const j = shuffled.indexOf(values[i] ?? 0);
            if (j < 0) return false;
            if (Math.abs((originalZ[i] ?? 0) - (shuffledZ[j] ?? 0)) > 1e-9) return false;
          }
          return true;
        },
      ),
      { numRuns: 200, seed: 2_610_180_015 },
    );
  });

  it('returns all-zero z for a constant input and clips to [−3, 8] otherwise', () => {
    fc.assert(
      fc.property(
        finiteDouble(1e12),
        fc.integer({ min: 1, max: 20 }),
        fc.array(finiteDouble(1e12), { minLength: 1, maxLength: 40 }),
        (constant, length, values) => {
          const flat = Array.from({ length }, () => constant);
          return (
            robustZ(flat).every((z) => z === 0) && robustZ(values).every((z) => z >= -3 && z <= 8)
          );
        },
      ),
      { numRuns: 300, seed: 2_610_180_016 },
    );
  });
});
