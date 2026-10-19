import { describe, expect, it } from 'vitest';

import { ValidationError } from '@trendr/core';
import type { ScoredItemSummaryRow } from '@trendr/db';

import { encodeCursor } from '../schemas/common.js';
import { SearchQuery } from '../schemas/search.js';
import {
  SEARCH_FALLBACK_THRESHOLD,
  canonicalSearchQuery,
  composeSearchPage,
  decodeSearchCursor,
  resolveSearchMode,
  toItemSummary,
  type SearchMode,
  type SearchPart,
} from './search.service.js';

/**
 * Spec §18 task 3.4 — the search merge: FTS + trigram fallback (< 5 FTS hits),
 * two-part keyset pagination, `q:` cache key and the wire mapping.
 */

function row(id: number, score: number): ScoredItemSummaryRow {
  return {
    id: BigInt(id),
    source: 'github',
    kind: 'repo',
    name: `item-${id}`,
    displayName: `scope/item-${id}`,
    description: null,
    url: 'https://example.test/item',
    upstreamCreatedAt: null,
    primaryMetric: 'stars',
    latestMetrics: {},
    score7d: null,
    score,
  };
}

function compose(input: {
  mode: SearchMode;
  limit: number;
  cursorPart?: SearchPart | null;
  fts?: ScoredItemSummaryRow[];
  trigram?: ScoredItemSummaryRow[];
}) {
  return composeSearchPage({
    mode: input.mode,
    limit: input.limit,
    cursorPart: input.cursorPart ?? null,
    fts: input.fts ?? [],
    trigram: input.trigram ?? [],
  });
}

describe('canonicalSearchQuery (spec §9.1)', () => {
  it('is stable across property order and case-insensitive for q', () => {
    const a = SearchQuery.parse({ q: 'NXT', limit: '10' });
    const b = SearchQuery.parse({ limit: 10, q: 'nxt' });
    expect(canonicalSearchQuery(a)).toBe(canonicalSearchQuery(b));
  });

  it('includes the cursor so pages cache separately', () => {
    const page1 = SearchQuery.parse({ q: 'nxt' });
    const page2 = SearchQuery.parse({ q: 'nxt', cursor: 'abc' });
    expect(canonicalSearchQuery(page1)).not.toBe(canonicalSearchQuery(page2));
  });
});

describe('resolveSearchMode (task 3.4)', () => {
  it(`falls back to trigram below ${SEARCH_FALLBACK_THRESHOLD} FTS hits`, () => {
    for (const total of [0, 1, 4]) {
      expect(resolveSearchMode(total)).toBe('both');
    }
    for (const total of [5, 6, 100]) {
      expect(resolveSearchMode(total)).toBe('fts');
    }
  });
});

describe('decodeSearchCursor', () => {
  it('round-trips a composed cursor', () => {
    const raw = encodeCursor({ m: 'both', p: 'trigram', k: 0.286, i: '42' });
    expect(decodeSearchCursor(raw)).toEqual({ m: 'both', p: 'trigram', k: 0.286, i: '42' });
  });

  it('throws ValidationError for garbage and malformed ids', () => {
    expect(() => decodeSearchCursor('!!not-base64!!')).toThrow(ValidationError);
    expect(() => decodeSearchCursor(encodeCursor({ m: 'fts', p: 'fts', k: 1, i: 'x' }))).toThrow(
      ValidationError,
    );
  });
});

describe('composeSearchPage (task 3.4)', () => {
  it('serves FTS only when the mode is fts, ignoring any trigram rows', () => {
    const page = compose({
      mode: 'fts',
      limit: 2,
      fts: [row(1, 0.9), row(2, 0.8), row(3, 0.7)],
      trigram: [row(9, 0.5)],
    });
    expect(page.items.map((r) => r.id)).toEqual([1n, 2n]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeSearchCursor(page.nextCursor ?? '')).toEqual({
      m: 'fts',
      p: 'fts',
      k: 0.8,
      i: '2',
    });
  });

  it('ends the pagination when neither part has more rows', () => {
    const page = compose({ mode: 'fts', limit: 5, fts: [row(1, 0.9)] });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('fills the page tail with trigram rows after the FTS part', () => {
    const page = compose({
      mode: 'both',
      limit: 3,
      fts: [row(1, 0.9), row(2, 0.8)],
      trigram: [row(8, 0.5)],
    });
    expect(page.items.map((r) => r.id)).toEqual([1n, 2n, 8n]);
    expect(page.nextCursor).toBeNull();
  });

  it('keeps a page boundary inside the FTS part (cursor p=fts)', () => {
    // limit 2: page 1 = the two FTS rows; the trigram tail continues next page.
    const page = compose({
      mode: 'both',
      limit: 2,
      fts: [row(1, 0.9), row(2, 0.8)],
      trigram: [row(8, 0.5), row(9, 0.4)],
    });
    expect(page.items.map((r) => r.id)).toEqual([1n, 2n]);
    expect(decodeSearchCursor(page.nextCursor ?? '')).toEqual({
      m: 'both',
      p: 'fts',
      k: 0.8,
      i: '2',
    });
  });

  it('continues into the trigram part when the remaining FTS rows are exhausted', () => {
    const page = compose({
      mode: 'both',
      limit: 2,
      cursorPart: 'fts',
      fts: [],
      trigram: [row(8, 0.5), row(9, 0.4), row(10, 0.3)],
    });
    expect(page.items.map((r) => r.id)).toEqual([8n, 9n]);
    expect(decodeSearchCursor(page.nextCursor ?? '')).toEqual({
      m: 'both',
      p: 'trigram',
      k: 0.4,
      i: '9',
    });
  });

  it('keeps a page boundary inside the trigram part (cursor p=trigram)', () => {
    const page = compose({
      mode: 'both',
      limit: 2,
      cursorPart: 'trigram',
      trigram: [row(8, 0.5), row(9, 0.4), row(10, 0.3)],
    });
    expect(page.items.map((r) => r.id)).toEqual([8n, 9n]);
    expect(decodeSearchCursor(page.nextCursor ?? '')).toEqual({
      m: 'both',
      p: 'trigram',
      k: 0.4,
      i: '9',
    });
  });

  it('never mixes the parts when the cursor is in the trigram part', () => {
    const page = compose({
      mode: 'both',
      limit: 5,
      cursorPart: 'trigram',
      fts: [row(1, 0.9)],
      trigram: [row(8, 0.5)],
    });
    expect(page.items.map((r) => r.id)).toEqual([8n]);
    expect(page.nextCursor).toBeNull();
  });

  it('returns an empty page without a cursor for no matches', () => {
    const page = compose({ mode: 'both', limit: 50 });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe('toItemSummary (spec §11.1)', () => {
  it('maps ids to strings, current from the primary metric and nulls', () => {
    const summary = toItemSummary({
      ...row(7, 0.1),
      displayName: 'vercel/next.js',
      description: 'The React Framework',
      upstreamCreatedAt: new Date('2026-01-02T03:04:05.000Z'),
      primaryMetric: 'stars',
      latestMetrics: { stars: 1234 },
      score7d: 9.5,
    });
    expect(summary).toEqual({
      id: '7',
      source: 'github',
      kind: 'repo',
      name: 'item-7',
      url: 'https://example.test/item',
      description: 'The React Framework',
      current: 1234,
      score7d: 9.5,
      upstreamCreatedAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it('keeps current/score7d null when unscored or never observed', () => {
    const summary = toItemSummary({ ...row(8, 0.2), latestMetrics: {} });
    expect(summary.current).toBeNull();
    expect(summary.score7d).toBeNull();
    expect(summary.upstreamCreatedAt).toBeNull();
  });
});
