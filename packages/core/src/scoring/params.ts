import { WINDOW_DAYS, type Metric, type Source, type Window } from '../types.js';

/**
 * Spec §8.3 — scoring parameters per `(source, metric, window)`. Keep this
 * table in lockstep with the spec: every change is a regression-fixture update
 * for `packages/core/test/scoring.golden.test.ts`.
 */

export interface ScoringParams {
  k: number;
  minDelta: number;
  beta: number;
  rMax: number;
  burstMinAbs: number;
}

type Key = `${Source}:${Metric}`;

const kPerDay = (perDay: number, w: Window): number => perDay * WINDOW_DAYS[w];

export function paramsFor(source: Source, metric: Metric, w: Window): ScoringParams {
  const base = { beta: 0.35, rMax: 50 };
  const table: Partial<Record<Key, (w: Window) => ScoringParams>> = {
    'github:stars': (w) => ({
      ...base,
      k: 100,
      minDelta: { '24h': 10, '7d': 30, '30d': 75 }[w],
      burstMinAbs: 300,
    }),
    'npm:downloads': (w) => ({
      ...base,
      k: kPerDay(100, w),
      minDelta: { '24h': 200, '7d': 1000, '30d': 3000 }[w],
      burstMinAbs: 10_000,
    }),
    'pypi:downloads': (w) => ({
      ...base,
      k: kPerDay(100, w),
      minDelta: { '24h': 200, '7d': 1000, '30d': 3000 }[w],
      burstMinAbs: 10_000,
    }),
    'huggingface:likes': (w) => ({
      ...base,
      k: 20,
      minDelta: { '24h': 5, '7d': 15, '30d': 40 }[w],
      burstMinAbs: 200,
    }),
    'arxiv:upvotes': (w) => ({
      ...base,
      k: 5,
      minDelta: { '24h': 3, '7d': 8, '30d': 15 }[w],
      burstMinAbs: 100,
    }),
    'mcp:stars': (w) => ({
      ...base,
      k: 30,
      minDelta: { '24h': 3, '7d': 10, '30d': 25 }[w],
      burstMinAbs: 300,
    }),
    'mcp:downloads': (w) => ({
      ...base,
      k: kPerDay(30, w),
      minDelta: { '24h': 50, '7d': 250, '30d': 750 }[w],
      burstMinAbs: 5000,
    }),
  };
  const f = table[`${source}:${metric}`];
  if (!f) throw new Error(`No scoring params for ${source}:${metric}`);
  return f(w);
}
