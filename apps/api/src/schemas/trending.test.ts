import { describe, expect, it } from 'vitest';

import { TrendingQuery } from './trending.js';

/**
 * Spec §10.3 / ISS-2 — `newOnly` parses `'true'|'false'|'1'|'0'` explicitly:
 * `Boolean('false')` is `true`, so coercion is not an option; absent means no
 * filter. §16 also pins the rejection of `newOnly=yes`.
 */
describe('TrendingQuery (spec §10.3)', () => {
  it('applies the documented defaults', () => {
    expect(TrendingQuery.parse({})).toEqual({
      scope: 'all',
      window: '24h',
      newOnly: false,
      limit: 50,
    });
  });

  it.each([
    ['false', false],
    ['0', false],
    ['true', true],
    ['1', true],
  ])('parses newOnly=%s as %s', (raw, expected) => {
    expect(TrendingQuery.parse({ newOnly: raw }).newOnly).toBe(expected);
  });

  it('treats absent newOnly as false (not coerced)', () => {
    expect(TrendingQuery.parse({}).newOnly).toBe(false);
  });

  it('rejects newOnly=yes', () => {
    expect(TrendingQuery.safeParse({ newOnly: 'yes' }).success).toBe(false);
  });

  it('coerces minCurrent and rejects negatives and fractions', () => {
    expect(TrendingQuery.parse({ minCurrent: '10' }).minCurrent).toBe(10);
    expect(TrendingQuery.safeParse({ minCurrent: '-1' }).success).toBe(false);
    expect(TrendingQuery.safeParse({ minCurrent: '1.5' }).success).toBe(false);
  });

  it('bounds limit to 1..100', () => {
    expect(TrendingQuery.parse({ limit: '10' }).limit).toBe(10);
    expect(TrendingQuery.safeParse({ limit: '0' }).success).toBe(false);
    expect(TrendingQuery.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('trims and lowercases lang and validates topic slugs', () => {
    expect(TrendingQuery.parse({ lang: ' TypeScript ' }).lang).toBe('typescript');
    expect(TrendingQuery.parse({ topic: 'ai-agents' }).topic).toBe('ai-agents');
    expect(TrendingQuery.safeParse({ topic: 'AI Agents' }).success).toBe(false);
    expect(TrendingQuery.safeParse({ topic: '-leading' }).success).toBe(false);
  });
});
