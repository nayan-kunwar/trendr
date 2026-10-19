import { z } from 'zod';

import { ItemKindSchema, SourceSchema } from '@trendr/core';

import { PageMeta } from './common.js';

/**
 * Spec §10.1/§10.5 — `GET /v1/search` and `GET /v1/new`. The spec pins no Zod
 * shape for either, so the item summary mirrors the §11.1 `search_items` MCP
 * output (`id`…`score7d`, which the MCP passes through) plus
 * `upstreamCreatedAt` for the `/new` timeline; documented in SPEC_REVIEW.
 */

export const ItemSummaryDto = z.object({
  id: z.string(),
  source: SourceSchema,
  kind: ItemKindSchema,
  name: z.string(),
  url: z.url(),
  description: z.string().nullable(),
  /** Current value of the item's primary metric, `null` when never observed. */
  current: z.number().nullable(),
  /** Final score of the item in the current 7 d run, `null` when unscored. */
  score7d: z.number().nullable(),
  upstreamCreatedAt: z.iso.datetime().nullable(),
});

/** Spec §10.1: `q` 2–100 chars. */
export const SearchQuery = z.object({
  q: z.string().trim().min(2).max(100),
  source: SourceSchema.optional(),
  kind: ItemKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

/**
 * Search pages are served in two ordered parts (task 3.4): full-text hits
 * first, then the trigram tail when FTS found fewer than 5 hits. `m` pins the
 * mode chosen on the first page so deeper pages compose identically.
 */
export const SearchCursor = z.object({
  m: z.enum(['fts', 'both']),
  p: z.enum(['fts', 'trigram']),
  k: z.number(),
  i: z.string().regex(/^\d{1,19}$/),
});

export const SearchResponse = z.object({
  items: z.array(ItemSummaryDto),
  page: PageMeta,
});

/** Spec §10.1 `/v1/new`: `days` ≤ 30, fixed 50-item pages (no `limit` param). */
export const NewQuery = z.object({
  source: SourceSchema.optional(),
  kind: ItemKindSchema.optional(),
  days: z.coerce.number().int().min(1).max(30).default(7),
  cursor: z.string().max(512).optional(),
});

export const NewResponse = z.object({
  items: z.array(ItemSummaryDto),
  page: PageMeta,
});

export type ItemSummary = z.infer<typeof ItemSummaryDto>;
export type SearchQueryInput = z.infer<typeof SearchQuery>;
export type SearchCursorValue = z.infer<typeof SearchCursor>;
export type SearchResponseBody = z.infer<typeof SearchResponse>;
export type NewQueryInput = z.infer<typeof NewQuery>;
export type NewResponseBody = z.infer<typeof NewResponse>;
