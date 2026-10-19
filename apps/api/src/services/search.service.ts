import { ValidationError } from '@trendr/core';
import type { ItemSummaryRow, ScoredItemSummaryRow } from '@trendr/db';

import { decodeCursor, encodeCursor } from '../schemas/common.js';
import {
  SearchCursor,
  type ItemSummary,
  type SearchCursorValue,
  type SearchQueryInput,
} from '../schemas/search.js';

/**
 * Spec §18 task 3.4 — the search read path's framework-free core: the `q:`
 * cache key, the FTS→trigram fallback decision, the two-part page composition
 * and the cursor codec. The route supplies database rows; everything here is
 * pure (unit-tested in `search.service.test.ts`).
 */

/** Spec §18: the trigram fallback runs when FTS finds fewer than 5 hits. */
export const SEARCH_FALLBACK_THRESHOLD = 5;

export type SearchMode = 'fts' | 'both';
export type SearchPart = 'fts' | 'trigram';

export interface ComposedSearchPage {
  items: ScoredItemSummaryRow[];
  /** Encoded `SearchCursor` for the next page, or `null` at the end. */
  nextCursor: string | null;
}

/** Canonical request key for the `q:{sha1}` cache (spec §9.1; search 120 s). */
export function canonicalSearchQuery(query: SearchQueryInput): string {
  return JSON.stringify({
    endpoint: 'search',
    q: query.q.toLowerCase(),
    source: query.source ?? null,
    kind: query.kind ?? null,
    limit: query.limit,
    cursor: query.cursor ?? null,
  });
}

/** FTS alone when it finds ≥ 5 hits; otherwise FTS with a trigram tail. */
export function resolveSearchMode(totalFtsHits: number): SearchMode {
  return totalFtsHits < SEARCH_FALLBACK_THRESHOLD ? 'both' : 'fts';
}

export function decodeSearchCursor(raw: string): SearchCursorValue {
  try {
    return decodeCursor(raw, SearchCursor);
  } catch {
    throw new ValidationError('Invalid cursor');
  }
}

export interface ComposeSearchPageInput {
  mode: SearchMode;
  limit: number;
  /** `null` on the first page; otherwise the part the last returned row belongs to. */
  cursorPart: SearchPart | null;
  /** FTS rows after the cursor (first page: from the top), already `limit + 1`-bounded. */
  fts: ScoredItemSummaryRow[];
  /** Trigram-only rows; supplied only when the page may reach the tail. */
  trigram: ScoredItemSummaryRow[];
}

/**
 * Ordering is `fts` rows by rank, then trigram-only rows by similarity — the
 * fallback supplements, never reorders. A page boundary can sit inside either
 * part; the cursor records the mode so deeper pages compose identically.
 */
export function composeSearchPage(input: ComposeSearchPageInput): ComposedSearchPage {
  const { mode, limit, cursorPart } = input;
  const combined: { row: ScoredItemSummaryRow; part: SearchPart }[] = [];

  if (cursorPart === 'trigram') {
    for (const row of input.trigram) {
      combined.push({ row, part: 'trigram' });
    }
  } else {
    for (const row of input.fts) {
      combined.push({ row, part: 'fts' });
    }
    // The trigram tail follows only after the whole FTS part is on the page.
    if (mode === 'both' && input.fts.length <= limit) {
      for (const row of input.trigram) {
        combined.push({ row, part: 'trigram' });
      }
    }
  }

  const page = combined.slice(0, limit);
  const last = page.at(-1);
  const hasMore = combined.length > limit;
  const cursorValue: SearchCursorValue | null =
    hasMore && last !== undefined
      ? { m: mode, p: last.part, k: last.row.score, i: String(last.row.id) }
      : null;

  return {
    items: page.map((entry) => entry.row),
    nextCursor: cursorValue === null ? null : encodeCursor(cursorValue),
  };
}

/** The repo row → §10.1 wire summary (spec §11.1 `search_items` shape + timeline). */
export function toItemSummary(row: ItemSummaryRow): ItemSummary {
  const current = row.latestMetrics[row.primaryMetric];
  return {
    id: String(row.id),
    source: row.source,
    kind: row.kind,
    name: row.name,
    url: row.url,
    description: row.description,
    current: typeof current === 'number' ? current : null,
    score7d: row.score7d,
    upstreamCreatedAt: row.upstreamCreatedAt?.toISOString() ?? null,
  };
}
