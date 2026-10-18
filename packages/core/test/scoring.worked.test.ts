import { describe, expect, it } from 'vitest';

import {
  buildAllBoard,
  computeRawScore,
  median,
  paramsFor,
  percentileRanks,
  robustZ,
  type AllBoardCandidate,
  type VelocityInput,
} from '../src/scoring/index.js';

/**
 * Spec §8.7 worked numeric example plus the §8.3 parameter table, and the §8.2
 * step 9 combined-board ordering. The spec table is rounded to three decimals,
 * so `toBeCloseTo(…, 3)` is the tolerance the acceptance criteria imply.
 */

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

function github7d(overrides: Partial<VelocityInput> = {}) {
  return computeRawScore(velocity(overrides), paramsFor('github', 'stars', '7d'));
}

/** A final-score input whose ln(1 + v) equals `x` (pins the z distribution). */
function fromX(x: number): number {
  return Math.E ** x - 1;
}

function repeat(value: number, times: number): number[] {
  return Array.from({ length: times }, () => value);
}

interface WorkedRow {
  name: string;
  input: Partial<VelocityInput>;
  final: number;
  /** Spec-table precision for the final score (default 3 decimals). */
  finalDigits?: number;
  relGrowth: number;
  rawScore: number;
  ageFactor: number;
  confidence: number;
  flags: string[];
}

const ROWS: WorkedRow[] = [
  {
    name: 'A big-framework',
    input: { delta: 1400, base: 80_000, ageDays: 2920 },
    final: 0.763,
    relGrowth: 0.0175,
    rawScore: 0.7633,
    ageFactor: 1,
    confidence: 1,
    flags: [],
  },
  {
    name: 'B small-agent',
    input: { delta: 1200, base: 150, ageDays: 40 },
    final: 5.409,
    relGrowth: 4.8,
    rawScore: 5.3324,
    ageFactor: 1.0144,
    confidence: 1,
    flags: [],
  },
  {
    name: 'C brand-new',
    input: { delta: 900, base: 0, ageDays: 5 },
    final: 7.491,
    // The spec's own intermediates (raw 6.3753 × age 1.1749 = 7.4903) round to
    // 7.490, so its printed 7.491 carries a ~1e-3 arithmetic slip; assert at
    // 2 decimals like the table effectively does. Recorded in SPEC_REVIEW.
    finalDigits: 2,
    relGrowth: 9,
    rawScore: 6.3753,
    ageFactor: 1.1749,
    confidence: 1,
    flags: ['new_item'],
  },
  {
    name: 'E burst',
    input: { delta: 3000, base: 400, ageDays: 2920, anomalyPenalty: 0.5 },
    final: 3.255,
    relGrowth: 6,
    rawScore: 6.5101,
    ageFactor: 1,
    confidence: 1,
    flags: ['burst_suspected'],
  },
  {
    name: 'F tracked-late',
    input: { delta: 600, base: 2000, ageDays: 2920, coverage: 3 / 7 },
    final: 1.173,
    relGrowth: 0.2857,
    rawScore: 1.7924,
    ageFactor: 1,
    confidence: 0.6547,
    flags: [],
  },
];

describe('§8.3 paramsFor', () => {
  it('matches the spec table for github:stars', () => {
    expect(paramsFor('github', 'stars', '24h')).toEqual({
      k: 100,
      minDelta: 10,
      beta: 0.35,
      rMax: 50,
      burstMinAbs: 300,
    });
    expect(paramsFor('github', 'stars', '7d').minDelta).toBe(30);
    expect(paramsFor('github', 'stars', '30d').minDelta).toBe(75);
  });

  it('scales the smoothing prior with the window for npm/PyPI downloads', () => {
    for (const source of ['npm', 'pypi'] as const) {
      expect(paramsFor(source, 'downloads', '24h')).toEqual({
        k: 100,
        minDelta: 200,
        beta: 0.35,
        rMax: 50,
        burstMinAbs: 10_000,
      });
      expect(paramsFor(source, 'downloads', '7d').k).toBe(700);
      expect(paramsFor(source, 'downloads', '30d')).toEqual({
        k: 3000,
        minDelta: 3000,
        beta: 0.35,
        rMax: 50,
        burstMinAbs: 10_000,
      });
    }
  });

  it('covers the huggingface, arxiv and mcp entries', () => {
    expect(paramsFor('huggingface', 'likes', '7d')).toEqual({
      k: 20,
      minDelta: 15,
      beta: 0.35,
      rMax: 50,
      burstMinAbs: 200,
    });
    expect(paramsFor('arxiv', 'upvotes', '24h')).toEqual({
      k: 5,
      minDelta: 3,
      beta: 0.35,
      rMax: 50,
      burstMinAbs: 100,
    });
    expect(paramsFor('mcp', 'stars', '7d')).toEqual({
      k: 30,
      minDelta: 10,
      beta: 0.35,
      rMax: 50,
      burstMinAbs: 300,
    });
    expect(paramsFor('mcp', 'downloads', '7d')).toEqual({
      k: 210,
      minDelta: 250,
      beta: 0.35,
      rMax: 50,
      burstMinAbs: 5000,
    });
    expect(paramsFor('mcp', 'downloads', '24h').k).toBe(30);
    expect(paramsFor('mcp', 'downloads', '30d').k).toBe(900);
  });

  it('throws for combinations the table deliberately omits (spec §8.3)', () => {
    expect(() => paramsFor('arxiv', 'stars', '7d')).toThrow('No scoring params for arxiv:stars');
    expect(() => paramsFor('github', 'downloads', '7d')).toThrow();
    expect(() => paramsFor('npm', 'likes', '7d')).toThrow();
  });
});

describe('§8.7 worked example — GitHub 7d', () => {
  it.each(ROWS)('$name matches the spec table to 3 decimals', (row) => {
    const scored = github7d(row.input);
    expect(scored.relGrowth).toBeCloseTo(row.relGrowth, 3);
    expect(scored.rawScore).toBeCloseTo(row.rawScore, 3);
    expect(scored.ageFactor).toBeCloseTo(row.ageFactor, 3);
    expect(scored.confidence).toBeCloseTo(row.confidence, 3);
    expect(scored.finalScore).toBeCloseTo(row.final, row.finalDigits ?? 3);
    expect(scored.flags).toEqual(row.flags);
  });

  it('ranks C > B > E > F > A by final score', () => {
    const ranking = ROWS.map((row) => ({ name: row.name, final: github7d(row.input).finalScore }))
      .sort((a, b) => b.final - a.final)
      .map((row) => row.name);
    expect(ranking).toEqual([
      'C brand-new',
      'B small-agent',
      'E burst',
      'F tracked-late',
      'A big-framework',
    ]);
  });

  it('excludes D tiny with below_threshold (18 < 30)', () => {
    const d = github7d({ delta: 18, base: 12 });
    expect(d.finalScore).toBe(0);
    expect(d.flags).toEqual(['below_threshold']);
  });

  it('reproduces the z table on a distribution with median 0.90 and MAD 0.35', () => {
    const finals = new Map(ROWS.map((row) => [row.name, github7d(row.input).finalScore]));
    const finalOf = (name: string): number => {
      const value = finals.get(name);
      if (value === undefined) throw new Error(`missing worked-example row: ${name}`);
      return value;
    };
    const distribution = [
      ...repeat(fromX(0.55), 4),
      finalOf('A big-framework'),
      finalOf('F tracked-late'),
      ...repeat(fromX(0.9), 8),
      ...repeat(fromX(1.25), 4),
      finalOf('E burst'),
      finalOf('B small-agent'),
      finalOf('C brand-new'),
    ];

    // The fixture itself must carry the spec's median/MAD before it can pin z.
    const xs = distribution.map((value) => Math.log1p(value));
    expect(median(xs)).toBeCloseTo(0.9, 9);
    expect(median(xs.map((x) => Math.abs(x - 0.9)))).toBeCloseTo(0.35, 9);

    const z = robustZ(distribution);
    expect(z[20]?.toFixed(3)).toBe('2.388'); // C
    expect(z[19]?.toFixed(3)).toBe('1.846'); // B
    expect(z[18]?.toFixed(3)).toBe('1.056'); // E
    expect(z[5]?.toFixed(3)).toBe('-0.238'); // F
    expect(z[4]?.toFixed(3)).toBe('-0.641'); // A
  });

  it('reproduces the npm package X example (Δ = 15,000 vs weekly mean)', () => {
    const npm7d = paramsFor('npm', 'downloads', '7d');
    expect(npm7d.k).toBe(700);

    const x = computeRawScore(velocity({ delta: 15_000, base: 10_000 }), npm7d);
    expect(x.relGrowth).toBeCloseTo(1.4019, 3);
    expect(x.rawScore).toBeCloseTo(4.7002, 3);
    expect(x.finalScore).toBeCloseTo(4.7002, 3); // age/conf/p are all neutral

    const distribution = [
      ...repeat(fromX(0.8), 4),
      ...repeat(fromX(1.1), 8),
      ...repeat(fromX(1.4), 4),
      x.finalScore,
    ];
    const z = robustZ(distribution);
    expect(z[16]?.toFixed(3)).toBe('1.440'); // spec prints 1.44
  });

  it('orders the combined All board: C > B > npm X > E > F > A', () => {
    const candidates: AllBoardCandidate[] = [
      { itemId: 3n, source: 'github', zScore: 2.388, percentile: 91.7, finalScore: 7.491 }, // C
      { itemId: 2n, source: 'github', zScore: 1.846, percentile: 75, finalScore: 5.409 }, // B
      { itemId: 6n, source: 'npm', zScore: 1.44, percentile: 100, finalScore: 4.7002 }, // X
      { itemId: 5n, source: 'github', zScore: 1.056, percentile: 58.3, finalScore: 3.255 }, // E
      { itemId: 4n, source: 'github', zScore: -0.238, percentile: 41.7, finalScore: 1.173 }, // F
      { itemId: 1n, source: 'github', zScore: -0.641, percentile: 25, finalScore: 0.763 }, // A
    ];

    const board = buildAllBoard(candidates);
    expect(board.map((placement) => placement.itemId)).toEqual([3n, 2n, 6n, 5n, 4n, 1n]);
    expect(board.map((placement) => placement.rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('breaks z ties by percentile, then by final score (spec §8.2 step 9)', () => {
    const candidates: AllBoardCandidate[] = [
      { itemId: 1n, source: 'github', zScore: 1.5, percentile: 50, finalScore: 9 },
      { itemId: 2n, source: 'npm', zScore: 1.5, percentile: 80, finalScore: 3 },
      { itemId: 3n, source: 'huggingface', zScore: 1.5, percentile: 50, finalScore: 12 },
    ];
    const board = buildAllBoard(candidates);
    expect(board.map((placement) => placement.itemId)).toEqual([2n, 3n, 1n]);
  });

  it('caps a single source share on the combined board (greedy fill)', () => {
    const candidates: AllBoardCandidate[] = [];
    const sources = ['github', 'npm', 'huggingface'] as const;
    sources.forEach((source, index) => {
      for (let i = 0; i < 12; i += 1) {
        candidates.push({
          itemId: BigInt(index * 100 + i),
          source,
          zScore: 100 - index * 20 - i * 0.1,
          percentile: 90,
          finalScore: 100 - index * 20 - i,
        });
      }
    });

    const byItemId = new Map(candidates.map((candidate) => [candidate.itemId, candidate.source]));
    const board = buildAllBoard(candidates, { topN: 10, maxShare: 0.4 });

    expect(board).toHaveLength(10);
    expect(board.map((placement) => placement.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const counts: Record<string, number> = {};
    for (const placement of board) {
      const source = byItemId.get(placement.itemId) ?? 'missing';
      counts[source] = (counts[source] ?? 0) + 1;
    }
    expect(counts).toEqual({ github: 4, npm: 4, huggingface: 2 });
  });
});

describe('normalize helpers', () => {
  it('median handles empty, odd and even inputs', () => {
    expect(median([])).toBe(0);
    expect(median([3])).toBe(3);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('percentileRanks returns the mid-rank percentage', () => {
    expect(percentileRanks([7])).toEqual([50]);
    expect(percentileRanks([10, 20, 30, 40])).toEqual([12.5, 37.5, 62.5, 87.5]);
  });
});
