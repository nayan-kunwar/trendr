import { z } from 'zod';

import {
  ItemKindSchema,
  LeaderboardEntrySchema,
  LeaderboardScopeSchema,
  MetricSchema,
  ScoreFlagSchema,
  SourceSchema,
  WindowSchema,
} from '@trendr/core';

/**
 * MCP wire schemas. The API is a separate app, so its response contracts are
 * mirrored here rather than imported from `apps/api`; enums come from
 * `@trendr/core` so the tool surface and the canonical types cannot drift.
 */

export const PageMetaSchema = z.object({
  nextCursor: z.string().nullable(),
  limit: z.number().int(),
});

export const TrendingApiResponseSchema = z.object({
  scope: LeaderboardScopeSchema,
  window: WindowSchema,
  runId: z.string(),
  computedAt: z.iso.datetime(),
  data: z.array(LeaderboardEntrySchema),
  page: PageMetaSchema,
});

export const ItemSummaryApiSchema = z.object({
  id: z.string().regex(/^\d{1,19}$/),
  source: SourceSchema,
  kind: ItemKindSchema,
  name: z.string(),
  url: z.url(),
  description: z.string().nullable(),
  current: z.number().nullable(),
  score7d: z.number().nullable(),
  upstreamCreatedAt: z.iso.datetime().nullable(),
});

export const SearchApiResponseSchema = z.object({
  items: z.array(ItemSummaryApiSchema),
  page: PageMetaSchema,
});

export const NewApiResponseSchema = SearchApiResponseSchema;

export const ItemDetailApiSchema = z.object({
  id: z.string().regex(/^\d{1,19}$/),
  source: SourceSchema,
  kind: ItemKindSchema,
  name: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  url: z.url(),
  primaryMetric: MetricSchema,
  latestMetrics: z.partialRecord(MetricSchema, z.number()),
  scores: z.record(
    WindowSchema,
    z.object({ finalScore: z.number(), percentile: z.number() }).nullable(),
  ),
  upstreamCreatedAt: z.iso.datetime().nullable(),
});

export const HistoryPointSchema = z.object({ t: z.string(), v: z.number() });

export const HistoryApiResponseSchema = z.object({
  itemId: z.string(),
  metric: MetricSchema,
  kind: z.enum(['cumulative', 'daily_count', 'gauge']),
  granularity: z.enum(['hour', 'day']),
  points: z.array(HistoryPointSchema),
});

export const AliasApiSchema = z.object({
  id: z.string(),
  source: SourceSchema,
  kind: ItemKindSchema,
  externalId: z.string(),
  displayName: z.string(),
  url: z.url(),
  relation: z.string(),
  confidence: z.number(),
  evidence: z.string(),
  direction: z.enum(['outgoing', 'incoming']),
});

export const AliasesApiResponseSchema = z.object({
  itemId: z.string(),
  aliases: z.array(AliasApiSchema),
});

export const CompareItemApiSchema = z.object({
  id: z.string(),
  source: SourceSchema,
  kind: ItemKindSchema,
  name: z.string(),
  displayName: z.string(),
  url: z.url(),
  delta: z.number().nullable(),
  relGrowth: z.number().nullable(),
  percentile: z.number().nullable(),
  rankSource: z.number().int().nullable(),
});

export const CompareApiResponseSchema = z.object({
  window: WindowSchema,
  granularity: z.enum(['hour', 'day']),
  metric: MetricSchema.nullable(),
  items: z.array(CompareItemApiSchema),
  series: z.record(z.string(), z.array(HistoryPointSchema)),
});

export const ProblemSchema = z.object({
  type: z.url(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string(),
  requestId: z.string(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

/** Compact item shape shared by `search_items` and `get_item_history`. */
export const SearchItemSchema = z.object({
  id: z.string(),
  source: SourceSchema,
  kind: ItemKindSchema,
  name: z.string(),
  description: z.string().nullable(),
  current: z.number().nullable(),
  score7d: z.number().nullable(),
  url: z.url(),
});

export const SearchOutputSchema = z.object({ items: z.array(SearchItemSchema) });

export const TrendingItemSchema = z.object({
  rank: z.number().int(),
  id: z.string(),
  source: SourceSchema,
  name: z.string(),
  url: z.url(),
  description: z.string().nullable(),
  current: z.number(),
  delta: z.number(),
  relGrowth: z.number(),
  percentile: z.number(),
  flags: z.array(ScoreFlagSchema),
});

export const TrendingOutputSchema = z.object({
  window: WindowSchema,
  computedAt: z.iso.datetime(),
  items: z.array(TrendingItemSchema),
});

export const HistoryItemSchema = z.object({
  id: z.string(),
  source: SourceSchema,
  kind: ItemKindSchema,
  name: z.string(),
  url: z.url(),
  description: z.string().nullable(),
  primaryMetric: MetricSchema,
  current: z.number().nullable(),
  score7d: z.number().nullable(),
});

export const HistoryOutputSchema = z.object({
  item: HistoryItemSchema,
  metric: MetricSchema,
  kind: z.enum(['cumulative', 'daily_count', 'gauge']),
  points: z.array(HistoryPointSchema),
  summary: z.object({
    first: z.number(),
    last: z.number(),
    delta: z.number(),
    maxDailyGain: z.number(),
  }),
});

export const CompareOutputItemSchema = z.object({
  id: z.string(),
  source: SourceSchema,
  name: z.string(),
  delta: z.number().nullable(),
  relGrowth: z.number().nullable(),
  percentile: z.number().nullable(),
  rankSource: z.number().int().nullable(),
});

export const CompareOutputSchema = z.object({
  window: WindowSchema,
  items: z.array(CompareOutputItemSchema),
  series: z.record(z.string(), z.array(HistoryPointSchema)),
});

export const McpPackageSchema = z.object({
  registryType: z.enum(['npm', 'pypi']),
  identifier: z.string(),
});

export const WhatsNewItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  url: z.url(),
  current: z.number().optional(),
  publishedAt: z.iso.datetime().optional(),
  delta7d: z.number().optional(),
  repoUrl: z.url().optional(),
  registryName: z.string().optional(),
  packages: z.array(McpPackageSchema),
});

export const WhatsNewOutputSchema = z.object({
  items: z.array(WhatsNewItemSchema),
});

export type TrendingApiResponse = z.infer<typeof TrendingApiResponseSchema>;
export type SearchApiResponse = z.infer<typeof SearchApiResponseSchema>;
export type NewApiResponse = z.infer<typeof NewApiResponseSchema>;
export type ItemDetailApi = z.infer<typeof ItemDetailApiSchema>;
export type HistoryApiResponse = z.infer<typeof HistoryApiResponseSchema>;
export type AliasesApiResponse = z.infer<typeof AliasesApiResponseSchema>;
export type CompareApiResponse = z.infer<typeof CompareApiResponseSchema>;
export type Problem = z.infer<typeof ProblemSchema>;
export type SearchItem = z.infer<typeof SearchItemSchema>;
export type TrendingItem = z.infer<typeof TrendingItemSchema>;
export type TrendingOutput = z.infer<typeof TrendingOutputSchema>;
export type HistoryOutput = z.infer<typeof HistoryOutputSchema>;
export type CompareOutput = z.infer<typeof CompareOutputSchema>;
export type WhatsNewItem = z.infer<typeof WhatsNewItemSchema>;
export type WhatsNewOutput = z.infer<typeof WhatsNewOutputSchema>;
