import { z } from 'zod';

/** Mirrors the API watchlist wire schemas (no server-only core imports). */

export const WatchlistSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  isDefault: z.boolean(),
  itemCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});

export const WatchlistsResponseSchema = z.object({ watchlists: z.array(WatchlistSchema) });

export const WatchlistScoreSchema = z.object({
  delta: z.number(),
  relGrowth: z.number(),
  percentile: z.number(),
  rankSource: z.number().int().nullable(),
});

export const WatchlistItemSchema = z.object({
  id: z.string(),
  source: z.enum(['github', 'npm', 'pypi', 'huggingface', 'arxiv', 'mcp']),
  kind: z.enum(['repo', 'package', 'model', 'dataset', 'space', 'paper', 'mcp_server']),
  displayName: z.string(),
  description: z.string().nullable(),
  url: z.url(),
  language: z.string().nullable(),
  primaryMetric: z.string(),
  topics: z.array(z.string()),
  current: z.number().nullable(),
  sparkline: z.array(z.number()),
  addedAt: z.iso.datetime(),
  scores: z.object({
    '24h': WatchlistScoreSchema.nullable(),
    '7d': WatchlistScoreSchema.nullable(),
  }),
});

export const WatchlistItemsResponseSchema = z.object({
  watchlist: WatchlistSchema,
  items: z.array(WatchlistItemSchema),
});

export const WatchlistItemWriteResponseSchema = z.object({
  added: z.boolean(),
  watchlist: WatchlistSchema,
});

export type Watchlist = z.infer<typeof WatchlistSchema>;
export type WatchlistItem = z.infer<typeof WatchlistItemSchema>;
