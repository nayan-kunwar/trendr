import { z } from 'zod';

import { ItemKindSchema, MetricSchema, SourceSchema } from '@trendr/core';

/**
 * Spec §10.5 / task 7.2 — watchlists. Item rows intentionally mirror the card
 * shape the web dashboard already renders (current value + sparkline) and add
 * the current 24h/7d score summary.
 */

export const WatchlistIdParam = z.object({ watchlistId: z.uuid() });
export const WatchlistItemParam = z.object({
  watchlistId: z.uuid(),
  itemId: z.string().regex(/^\d{1,19}$/),
});

export const CreateWatchlistBody = z.strictObject({ name: z.string().trim().min(1).max(80) });
export const RenameWatchlistBody = CreateWatchlistBody;

export const WatchlistDto = z.object({
  id: z.uuid(),
  name: z.string(),
  isDefault: z.boolean(),
  itemCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});

export const WatchlistsResponse = z.object({ watchlists: z.array(WatchlistDto) });

export const WatchlistScoreDto = z.object({
  delta: z.number(),
  relGrowth: z.number(),
  percentile: z.number(),
  rankSource: z.number().int().nullable(),
});

export const WatchlistItemDto = z.object({
  id: z.string(),
  source: SourceSchema,
  kind: ItemKindSchema,
  displayName: z.string(),
  description: z.string().nullable(),
  url: z.url(),
  language: z.string().nullable(),
  primaryMetric: MetricSchema,
  topics: z.array(z.string()),
  current: z.number().nullable(),
  sparkline: z.array(z.number()),
  addedAt: z.iso.datetime(),
  scores: z.object({
    '24h': WatchlistScoreDto.nullable(),
    '7d': WatchlistScoreDto.nullable(),
  }),
});

export const WatchlistItemsResponse = z.object({
  watchlist: WatchlistDto,
  items: z.array(WatchlistItemDto),
});

export const WatchlistItemWriteResponse = z.object({
  added: z.boolean(),
  watchlist: WatchlistDto,
});

export type WatchlistBody = z.infer<typeof WatchlistDto>;
export type WatchlistsBody = z.infer<typeof WatchlistsResponse>;
export type WatchlistItemBody = z.infer<typeof WatchlistItemDto>;
export type WatchlistItemsBody = z.infer<typeof WatchlistItemsResponse>;
