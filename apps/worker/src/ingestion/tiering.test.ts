import { describe, expect, it } from 'vitest';

import { planRetierItems, type TierCandidate } from './tiering.js';

function candidate(overrides: Partial<TierCandidate> & { itemId: bigint }): TierCandidate {
  return {
    source: 'github',
    tier: 'cold',
    primaryMetricValue: null,
    createdDaysAgo: 400,
    watched: false,
    rank24: null,
    rank7: null,
    rank30: null,
    pct7: null,
    seen90d: false,
    upstreamArchived: false,
    dailyCount: false,
    delta30Positive: null,
    trendingTop100: false,
    ...overrides,
  };
}

function tierOf(candidates: readonly TierCandidate[], itemId: bigint): string | undefined {
  return planRetierItems(candidates).find((change) => change.itemId === itemId)?.to;
}

describe('planRetierItems (spec §7.8)', () => {
  it('promotes watched items to hot even beyond the cap', () => {
    const watched = candidate({ itemId: 1n, watched: true, pct7: 1 });
    const ranked = candidate({ itemId: 2n, rank24: 5, pct7: 99 });
    const changes = planRetierItems([watched, ranked], { hotMaxBySource: { github: 1 } });
    expect(changes).toContainEqual({ itemId: 1n, from: 'cold', to: 'hot' });
    expect(changes).toContainEqual({ itemId: 2n, from: 'cold', to: 'hot' });
  });

  it('applies the cap with the best-7d-percentile tie-break', () => {
    const best = candidate({ itemId: 1n, rank24: 10, pct7: 90 });
    const second = candidate({ itemId: 2n, rank7: 500, pct7: 50 });
    const changes = planRetierItems([second, best], { hotMaxBySource: { github: 1 } });
    expect(changes).toContainEqual({ itemId: 1n, from: 'cold', to: 'hot' });
    // rank ≤ 2000 keeps the capped-out candidate at warm, not cold
    expect(changes).toContainEqual({ itemId: 2n, from: 'cold', to: 'warm' });
  });

  it('promotes rank_source ≤ 200 in any window of the current run', () => {
    expect(tierOf([candidate({ itemId: 1n, rank24: 200 })], 1n)).toBe('hot');
    expect(tierOf([candidate({ itemId: 2n, rank7: 200 })], 2n)).toBe('hot');
    expect(tierOf([candidate({ itemId: 3n, rank30: 200 })], 3n)).toBe('hot');
    expect(tierOf([candidate({ itemId: 4n, rank24: 201, rank7: 201, rank30: 201 })], 4n)).toBe(
      'warm',
    );
  });

  it('promotes fresh items above the source admission minimum', () => {
    expect(tierOf([candidate({ itemId: 1n, createdDaysAgo: 3, primaryMetricValue: 25 })], 1n)).toBe(
      'hot',
    );
    // below the minimum: still warm by age, not hot
    expect(tierOf([candidate({ itemId: 2n, createdDaysAgo: 3, primaryMetricValue: 4 })], 2n)).toBe(
      'warm',
    );
    // npm admission minimum is 200 weekly downloads
    expect(
      tierOf(
        [candidate({ itemId: 3n, source: 'npm', createdDaysAgo: 1, primaryMetricValue: 500 })],
        3n,
      ),
    ).toBe('hot');
  });

  it('treats arXiv papers ≤ 30 d old and HF trending top 100 as hot', () => {
    expect(tierOf([candidate({ itemId: 1n, source: 'arxiv', createdDaysAgo: 10 })], 1n)).toBe(
      'hot',
    );
    expect(tierOf([candidate({ itemId: 2n, trendingTop100: true })], 2n)).toBe('hot');
    expect(tierOf([candidate({ itemId: 3n, source: 'arxiv', createdDaysAgo: 60 })], 3n)).toBe(
      'archived',
    );
  });

  it('keeps warm: rank ≤ 2000 in 7d/30d, created ≤ 30 d, alias of a hot item', () => {
    expect(tierOf([candidate({ itemId: 1n, rank7: 2000, seen90d: true })], 1n)).toBe('warm');
    expect(tierOf([candidate({ itemId: 2n, rank30: 1999, seen90d: true })], 2n)).toBe('warm');
    expect(tierOf([candidate({ itemId: 3n, createdDaysAgo: 30 })], 3n)).toBe('warm');
    const hot = candidate({ itemId: 4n, rank24: 1 });
    const alias = candidate({ itemId: 5n });
    const changes = planRetierItems([hot, alias], { aliasEdges: [[4n, 5n]] });
    expect(changes).toContainEqual({ itemId: 5n, from: 'cold', to: 'warm' });
  });

  it('keeps cold: seen in the last 90 days or a positive 30d delta', () => {
    expect(tierOf([candidate({ itemId: 1n, seen90d: true })], 1n)).toBeUndefined(); // already cold
    expect(tierOf([candidate({ itemId: 2n, tier: 'warm', seen90d: true })], 2n)).toBe('cold');
    expect(tierOf([candidate({ itemId: 3n, tier: 'hot', delta30Positive: true })], 3n)).toBe(
      'cold',
    );
  });

  it('archives items with no growth for 60+ days, or upstream-archived ones', () => {
    // not seen recently and no positive delta → archived
    expect(tierOf([candidate({ itemId: 1n, tier: 'cold', seen90d: false })], 1n)).toBe('archived');
    expect(tierOf([candidate({ itemId: 2n, tier: 'warm', seen90d: false })], 2n)).toBe('archived');
    // upstream archived stops polling unless the item is watched
    expect(
      tierOf([candidate({ itemId: 3n, tier: 'cold', seen90d: true, upstreamArchived: true })], 3n),
    ).toBe('archived');
    expect(
      tierOf([candidate({ itemId: 4n, watched: true, seen90d: true, upstreamArchived: true })], 4n),
    ).toBe('hot');
  });

  it('emits a change only when the tier actually moves', () => {
    const hot = candidate({ itemId: 1n, tier: 'hot', rank24: 5 });
    const cold = candidate({ itemId: 2n, tier: 'cold', seen90d: true });
    const changes = planRetierItems([hot, cold]);
    expect(changes).toEqual([]);
  });

  it('is deterministic regardless of candidate order', () => {
    const best = candidate({ itemId: 1n, rank24: 10, pct7: 90 });
    const second = candidate({ itemId: 2n, rank24: 20, pct7: 50 });
    const forward = planRetierItems([best, second], { hotMaxBySource: { github: 1 } });
    const backward = planRetierItems([second, best], { hotMaxBySource: { github: 1 } });
    expect(forward).toEqual(backward);
  });
});
