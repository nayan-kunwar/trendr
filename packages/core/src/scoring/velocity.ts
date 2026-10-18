import type { ScoreComponents, ScoreFlag } from '../types.js';
import type { ScoringParams } from './params.js';

/**
 * Spec §8.4 — the pure velocity formula. Eligibility is checked in the §8.2
 * order (first match wins) and ineligible items collapse to `final = 0`.
 */

export interface VelocityInput {
  delta: number;
  base: number;
  coverage: number;
  stale: boolean;
  ageDays: number | null;
  isPaper: boolean;
  anomalyPenalty: number;
}

export function computeRawScore(
  i: VelocityInput,
  p: ScoringParams,
): ScoreComponents & { flags: ScoreFlag[] } {
  const flags: ScoreFlag[] = [];
  const zero = (f: ScoreFlag) => ({
    delta: i.delta,
    base: i.base,
    relGrowth: 0,
    rawScore: 0,
    ageFactor: 1,
    confidence: 0,
    anomalyPenalty: i.anomalyPenalty,
    finalScore: 0,
    flags: [...flags, f],
  });

  if (i.coverage < 0.25) return zero('insufficient_data');
  if (i.delta <= 0) return zero('negative_growth');
  if (i.delta < p.minDelta) return zero('below_threshold');

  const relGrowth = Math.min(i.delta / (i.base + p.k), p.rMax);
  const rawScore = Math.log10(1 + i.delta) * relGrowth ** p.beta;
  const tau = i.isPaper ? 7 : 14;
  const ageFactor = i.ageDays === null ? 1 : 1 + 0.25 * Math.exp(-i.ageDays / tau);
  if (i.ageDays !== null && i.ageDays <= 30) flags.push('new_item');
  const confidence = Math.sqrt(Math.min(1, Math.max(0, i.coverage))) * (i.stale ? 0.5 : 1);
  if (i.anomalyPenalty < 1) flags.push('burst_suspected');
  const finalScore = rawScore * ageFactor * confidence * i.anomalyPenalty;
  return {
    delta: i.delta,
    base: i.base,
    relGrowth,
    rawScore,
    ageFactor,
    confidence,
    anomalyPenalty: i.anomalyPenalty,
    finalScore,
    flags,
  };
}
