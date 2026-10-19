import { describe, expect, it } from 'vitest';

import { CompareQuery, CompareResponse } from './compare.js';

/** Spec §10.1 — `/v1/compare`: 2–5 items, window, granularity, metric. */

describe('CompareQuery (spec §10.1)', () => {
  it('defaults the window to 24h and leaves granularity/metric unresolved', () => {
    expect(CompareQuery.parse({ ids: '1,2' })).toEqual({ ids: '1,2', window: '24h' });
  });

  it.each([
    ['24h', 'hour', true],
    ['7d', 'hour', true],
    ['30d', 'hour', false], // the history limit: 30 d has no hourly resolution
    ['30d', 'day', true],
    ['7d', 'day', true],
    ['24h', 'day', true],
  ] as const)('window=%s granularity=%s accepted=%s', (window, granularity, accepted) => {
    expect(CompareQuery.safeParse({ ids: '1,2', window, granularity }).success).toBe(accepted);
  });

  it('rejects a missing or oversized ids string', () => {
    expect(CompareQuery.safeParse({}).success).toBe(false);
    expect(CompareQuery.safeParse({ ids: '1'.repeat(129) }).success).toBe(false);
  });

  it('validates metric against the spec enum', () => {
    expect(CompareQuery.parse({ ids: '1,2', metric: 'stars' }).metric).toBe('stars');
    expect(CompareQuery.safeParse({ ids: '1,2', metric: 'claps' }).success).toBe(false);
  });
});

describe('CompareResponse (spec §10.1)', () => {
  it('accepts items with null growth fields and a per-id series record', () => {
    const parsed = CompareResponse.parse({
      window: '24h',
      granularity: 'hour',
      metric: null,
      items: [
        {
          id: '1',
          source: 'github',
          kind: 'repo',
          name: 'next.js',
          displayName: 'vercel/next.js',
          url: 'https://github.com/vercel/next.js',
          delta: null,
          relGrowth: null,
          percentile: null,
          rankSource: null,
        },
      ],
      series: { '1': [{ t: '2026-06-01T12:00:00.000Z', v: 10 }] },
    });
    expect(parsed.series['1']).toHaveLength(1);
  });

  it('rejects a series value that is not a points array', () => {
    expect(
      CompareResponse.safeParse({
        window: '24h',
        granularity: 'hour',
        metric: null,
        items: [],
        series: { '1': 5 },
      }).success,
    ).toBe(false);
  });
});
