import { describe, expect, it } from 'vitest';

import { LanguagesResponse, TopicsQuery, TopicsResponse } from './topics.js';

/** Spec §10.1 — `/v1/topics` (limit ≤ 200) and `/v1/languages` (§9.1 top 30). */

describe('TopicsQuery (spec §10.1)', () => {
  it('applies the documented default of 100', () => {
    expect(TopicsQuery.parse({})).toEqual({ limit: 100 });
  });

  it('bounds limit to 1..200', () => {
    expect(TopicsQuery.parse({ limit: '200' }).limit).toBe(200);
    expect(TopicsQuery.safeParse({ limit: '0' }).success).toBe(false);
    expect(TopicsQuery.safeParse({ limit: '201' }).success).toBe(false);
  });

  it('validates the optional source filter', () => {
    expect(TopicsQuery.parse({ source: 'mcp' }).source).toBe('mcp');
    expect(TopicsQuery.safeParse({ source: 'news' }).success).toBe(false);
  });
});

describe('TopicsResponse (spec §10.1)', () => {
  it('accepts slug/name/itemCount rows', () => {
    expect(
      TopicsResponse.parse({ topics: [{ slug: 'ai-agents', name: 'AI Agents', itemCount: 3 }] }),
    ).toEqual({ topics: [{ slug: 'ai-agents', name: 'AI Agents', itemCount: 3 }] });
  });

  it('rejects fractional counts', () => {
    expect(
      TopicsResponse.safeParse({ topics: [{ slug: 'a', name: 'A', itemCount: 1.5 }] }).success,
    ).toBe(false);
  });
});

describe('LanguagesResponse (spec §9.1)', () => {
  it('accepts language/slug/itemCount rows', () => {
    expect(
      LanguagesResponse.parse({
        languages: [{ language: 'TypeScript', slug: 'typescript', itemCount: 42 }],
      }),
    ).toEqual({ languages: [{ language: 'TypeScript', slug: 'typescript', itemCount: 42 }] });
  });
});
