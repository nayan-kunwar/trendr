import { describe, expect, it } from 'vitest';

import {
  computeRawScore,
  paramsFor,
  percentileRanks,
  robustZ,
  type VelocityInput,
} from '../src/scoring/index.js';

/**
 * Spec §8.3/§16 golden fixture: a fixed 50-item input set must produce an exact
 * ranking. Any change to the parameter table or the formulas shows up here as
 * a snapshot diff and forces an explicit golden-file update in review.
 */

const SOURCE_METRIC = [
  ['github', 'stars'],
  ['npm', 'downloads'],
  ['pypi', 'downloads'],
  ['huggingface', 'likes'],
  ['arxiv', 'upvotes'],
  ['mcp', 'stars'],
] as const;

function sourceMetricFor(index: number): (typeof SOURCE_METRIC)[number] {
  const pair = SOURCE_METRIC.at(index % SOURCE_METRIC.length);
  if (pair === undefined) throw new Error('SOURCE_METRIC is empty');
  return pair;
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

describe('scoring golden fixture (spec §8.3/§16)', () => {
  it('produces the exact ranking for the fixed 50-item set', () => {
    const rand = lcg(0x7e_4d_00_01);
    const rows = Array.from({ length: 50 }, (_, index) => {
      const [source, metric] = sourceMetricFor(index);
      const id = `${source}:${metric}:${String(index).padStart(2, '0')}`;
      const input: VelocityInput = {
        delta: Math.floor(rand() ** 2 * 80_000) + 1,
        base: Math.floor(rand() ** 2 * 150_000),
        coverage: 1,
        stale: rand() < 0.15,
        ageDays: rand() < 0.8 ? Math.floor(rand() * 3000) : null,
        isPaper: source === 'arxiv',
        anomalyPenalty: rand() < 0.08 ? 0.5 : 1,
      };
      return { id, input, scored: computeRawScore(input, paramsFor(source, metric, '7d')) };
    });

    const eligible = rows.filter((row) => row.scored.finalScore > 0);
    const ineligible = rows.filter((row) => row.scored.finalScore === 0);
    expect(eligible.length).toBeGreaterThan(30);
    expect(ineligible.length).toBeGreaterThan(0);

    const finals = eligible.map((row) => row.scored.finalScore);
    const z = robustZ(finals);
    const percentile = percentileRanks(finals);

    const ranking = eligible
      .map((row, i) => ({
        id: row.id,
        final: round(row.scored.finalScore, 4),
        z: round(z[i] ?? 0, 4),
        percentile: round(percentile[i] ?? 0, 2),
      }))
      .sort((a, b) => b.z - a.z || b.percentile - a.percentile || b.final - a.final);

    expect(ranking).toMatchSnapshot();
    expect(
      ineligible.map((row) => ({ id: row.id, flags: row.scored.flags, delta: row.input.delta })),
    ).toMatchSnapshot();
  });
});
