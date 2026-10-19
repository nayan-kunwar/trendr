import { describe, expect, it } from 'vitest';

import { SearchCursor, SearchQuery, NewQuery, SearchResponse } from './search.js';

/**
 * Spec §10.1 — `/v1/search` (`q` 2–100, `limit` 1–100 default 50) and
 * `/v1/new` (`days` 1–30 default 7, no `limit` parameter).
 */

describe('SearchQuery (spec §10.1)', () => {
  it('applies the documented defaults', () => {
    expect(SearchQuery.parse({ q: 'rust' })).toEqual({ q: 'rust', limit: 50 });
  });

  it('trims q before enforcing length', () => {
    expect(SearchQuery.parse({ q: '  nxt  ' }).q).toBe('nxt');
    expect(SearchQuery.safeParse({ q: ' x ' }).success).toBe(false); // trims to 1 char
    expect(SearchQuery.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
  });

  it('coerces limit and bounds it to 1..100', () => {
    expect(SearchQuery.parse({ q: 'ab', limit: '25' }).limit).toBe(25);
    expect(SearchQuery.safeParse({ q: 'ab', limit: '0' }).success).toBe(false);
    expect(SearchQuery.safeParse({ q: 'ab', limit: '101' }).success).toBe(false);
  });

  it('validates source and kind against the spec enums', () => {
    expect(SearchQuery.parse({ q: 'ab', source: 'github', kind: 'repo' }).source).toBe('github');
    expect(SearchQuery.safeParse({ q: 'ab', source: 'gitlab' }).success).toBe(false);
    expect(SearchQuery.safeParse({ q: 'ab', kind: 'thing' }).success).toBe(false);
  });
});

describe('SearchCursor (task 3.4)', () => {
  it('accepts both parts and modes', () => {
    expect(SearchCursor.parse({ m: 'both', p: 'trigram', k: 0.286, i: '42' })).toEqual({
      m: 'both',
      p: 'trigram',
      k: 0.286,
      i: '42',
    });
  });

  it('rejects a non-numeric item id and unknown parts', () => {
    expect(SearchCursor.safeParse({ m: 'fts', p: 'fts', k: 1, i: 'abc' }).success).toBe(false);
    expect(SearchCursor.safeParse({ m: 'fts', p: 'like', k: 1, i: '1' }).success).toBe(false);
  });
});

describe('NewQuery (spec §10.1)', () => {
  it('applies the documented default of 7 days', () => {
    expect(NewQuery.parse({})).toEqual({ days: 7 });
  });

  it('bounds days to 1..30', () => {
    expect(NewQuery.parse({ days: '30' }).days).toBe(30);
    expect(NewQuery.safeParse({ days: '0' }).success).toBe(false);
    expect(NewQuery.safeParse({ days: '31' }).success).toBe(false);
  });

  it('has no limit parameter (fixed page size)', () => {
    expect(NewQuery.parse({ limit: '5' })).toEqual({ days: 7 });
  });
});

describe('SearchResponse (spec §10.5)', () => {
  it('accepts the summary shape with null current/score7d', () => {
    const parsed = SearchResponse.parse({
      items: [
        {
          id: '1',
          source: 'github',
          kind: 'repo',
          name: 'next.js',
          url: 'https://github.com/vercel/next.js',
          description: null,
          current: null,
          score7d: 12.5,
          upstreamCreatedAt: '2026-01-02T03:04:05.000Z',
        },
      ],
      page: { nextCursor: null, limit: 50 },
    });
    expect(parsed.items[0]?.score7d).toBe(12.5);
  });

  it('rejects a missing page.nextCursor', () => {
    expect(SearchResponse.safeParse({ items: [], page: { limit: 50 } }).success).toBe(false);
  });
});
