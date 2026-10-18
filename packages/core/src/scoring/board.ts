import type { Source } from '../types.js';

/**
 * Spec §8.2 step 9 — the combined "All" board: union of eligible items from
 * all sources, sorted by z desc, tie-break percentile desc then final desc,
 * greedily filled with an optional per-source share cap.
 */

export const ALL_BOARD_TOP_N = 100;
export const ALL_BOARD_MAX_SHARE = 0.4;

export interface AllBoardCandidate {
  itemId: bigint;
  source: Source;
  zScore: number;
  percentile: number;
  finalScore: number;
}

export interface AllBoardPlacement {
  itemId: bigint;
  rank: number;
}

/**
 * Items skipped by the share cap do not receive a rank (`scores.rank_all`
 * stays NULL for them); the board keeps filling from other sources until
 * `topN` is reached or the candidates run out.
 */
export function buildAllBoard(
  candidates: readonly AllBoardCandidate[],
  options: { topN?: number; maxShare?: number } = {},
): AllBoardPlacement[] {
  const topN = options.topN ?? ALL_BOARD_TOP_N;
  const maxShare = options.maxShare ?? ALL_BOARD_MAX_SHARE;
  const perSourceCap = Math.max(1, Math.floor(maxShare * topN));
  const sorted = [...candidates].sort(
    (a, b) => b.zScore - a.zScore || b.percentile - a.percentile || b.finalScore - a.finalScore,
  );

  const used = new Map<Source, number>();
  const placements: AllBoardPlacement[] = [];
  for (const candidate of sorted) {
    if (placements.length >= topN) break;
    const count = used.get(candidate.source) ?? 0;
    if (count >= perSourceCap) continue;
    used.set(candidate.source, count + 1);
    placements.push({ itemId: candidate.itemId, rank: placements.length + 1 });
  }
  return placements;
}
