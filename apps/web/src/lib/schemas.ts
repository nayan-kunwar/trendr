import { z } from 'zod';

/**
 * Runtime enums are mirrored locally so the browser bundle never pulls
 * `@trendr/core` (which also exposes server-only Redis/Lua helpers). Type-only
 * imports from core are erased at compile time.
 */
const SOURCES = ['github', 'npm', 'pypi', 'huggingface', 'arxiv', 'mcp'] as const;
const SourceSchema = z.enum(SOURCES);
const LeaderboardScopeSchema = z.enum(['all', ...SOURCES]);
const WindowSchema = z.enum(['24h', '7d', '30d']);
const ItemKindSchema = z.enum([
  'repo',
  'package',
  'model',
  'dataset',
  'space',
  'paper',
  'mcp_server',
]);
const MetricSchema = z.enum([
  'stars',
  'forks',
  'watchers',
  'open_issues',
  'downloads',
  'downloads_total',
  'likes',
  'upvotes',
  'trending_score',
  'comments',
]);
const TierSchema = z.enum(['hot', 'warm', 'cold', 'archived']);

const LeaderboardItemSchema = z.object({
  id: z.string(),
  source: SourceSchema,
  kind: ItemKindSchema,
  externalId: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  url: z.url(),
  language: z.string().nullable(),
  topics: z.array(z.string()),
  primaryMetric: MetricSchema,
});

const LeaderboardEntrySchema = z.object({
  rank: z.number().int().positive(),
  item: LeaderboardItemSchema,
  window: WindowSchema,
  delta: z.number(),
  relGrowth: z.number(),
  score: z.number(),
  percentile: z.number(),
  current: z.number(),
  sparkline: z.array(z.number()).max(30),
  flags: z.array(z.string()),
});

/**
 * Wire schemas for the web client. The API exports its own schemas from
 * `apps/api/src/schemas`; the web app deliberately keeps a typed boundary here
 * so it can be built independently of the API server package. Shapes mirror
 * spec §10 exactly and are validated on every fetch.
 */

export const PageMetaSchema = z.object({
  nextCursor: z.string().nullable(),
  limit: z.number().int(),
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

export const TrendingResponseSchema = z.object({
  scope: LeaderboardScopeSchema,
  window: WindowSchema,
  runId: z.string(),
  computedAt: z.iso.datetime(),
  data: z.array(LeaderboardEntrySchema),
  page: PageMetaSchema,
});

export type TrendingResponse = z.infer<typeof TrendingResponseSchema>;
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;

export const ItemScoreSchema = z.object({
  rankSource: z.number().int().nullable(),
  rankAll: z.number().int().nullable(),
  delta: z.number(),
  relGrowth: z.number(),
  finalScore: z.number(),
  zScore: z.number(),
  percentile: z.number(),
  flags: z.array(z.string()),
});

export const ItemAliasSchema = z.object({
  id: z.string(),
  source: SourceSchema,
  displayName: z.string(),
  relation: z.string(),
  confidence: z.number(),
});

export const ItemDetailSchema = z.object({
  id: z.string(),
  source: SourceSchema,
  kind: ItemKindSchema,
  externalId: z.string(),
  name: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  url: z.url(),
  homepage: z.string().nullable(),
  language: z.string().nullable(),
  license: z.string().nullable(),
  owner: z.string().nullable(),
  topics: z.array(z.string()),
  primaryMetric: MetricSchema,
  latestMetrics: z.partialRecord(MetricSchema, z.number()),
  tier: TierSchema,
  flags: z.array(z.string()),
  upstreamCreatedAt: z.iso.datetime().nullable(),
  firstSeenAt: z.iso.datetime(),
  lastSnapshotAt: z.iso.datetime().nullable(),
  scores: z.record(WindowSchema, ItemScoreSchema.nullable()),
  aliases: z.array(ItemAliasSchema),
  metadata: z.record(z.string(), z.unknown()),
});

export type ItemDetail = z.infer<typeof ItemDetailSchema>;
export type ItemScore = z.infer<typeof ItemScoreSchema>;

export const HistoryResponseSchema = z.object({
  itemId: z.string(),
  metric: MetricSchema,
  kind: z.enum(['cumulative', 'daily_count', 'gauge']),
  granularity: z.enum(['hour', 'day']),
  points: z.array(z.object({ t: z.string(), v: z.number() })),
});

export type HistoryResponse = z.infer<typeof HistoryResponseSchema>;

export const ScoresResponseSchema = z.object({
  itemId: z.string(),
  window: WindowSchema,
  granularity: z.enum(['hour', 'day']),
  points: z.array(
    z.object({
      t: z.iso.datetime(),
      runId: z.string(),
      finalScore: z.number(),
      zScore: z.number(),
      percentile: z.number(),
      rankSource: z.number().int().nullable(),
      delta: z.number(),
    }),
  ),
});

export type ScoresResponse = z.infer<typeof ScoresResponseSchema>;

export const ScoreExplainResponseSchema = z.object({
  itemId: z.string(),
  source: SourceSchema,
  window: WindowSchema,
  runId: z.string().nullable(),
  computedAt: z.iso.datetime().nullable(),
  components: z
    .object({
      delta: z.number(),
      base: z.number(),
      relGrowth: z.number(),
      rawScore: z.number(),
      ageFactor: z.number(),
      confidence: z.number(),
      anomalyPenalty: z.number(),
      finalScore: z.number(),
    })
    .nullable(),
  params: z
    .object({
      k: z.number(),
      minDelta: z.number(),
      beta: z.number(),
      rMax: z.number(),
      burstMinAbs: z.number(),
    })
    .nullable(),
  inputs: z
    .object({
      delta: z.number(),
      base: z.number(),
      anomalyPenalty: z.number(),
      zScore: z.number(),
      percentile: z.number(),
      rankSource: z.number().int().nullable(),
      rankAll: z.number().int().nullable(),
      flags: z.array(z.string()),
    })
    .nullable(),
  reason: z.literal('not_eligible').optional(),
});

export type ScoreExplain = z.infer<typeof ScoreExplainResponseSchema>;

export const ItemAliasesResponseSchema = z.object({
  itemId: z.string(),
  aliases: z.array(
    ItemAliasSchema.extend({
      kind: ItemKindSchema,
      externalId: z.string(),
      url: z.url(),
      evidence: z.string(),
      direction: z.enum(['outgoing', 'incoming']),
    }),
  ),
});

export type ItemAliasesResponse = z.infer<typeof ItemAliasesResponseSchema>;

export const ItemSummarySchema = z.object({
  id: z.string(),
  source: SourceSchema,
  kind: ItemKindSchema,
  name: z.string(),
  url: z.url(),
  description: z.string().nullable(),
  current: z.number().nullable(),
  score7d: z.number().nullable(),
  upstreamCreatedAt: z.iso.datetime().nullable(),
});

export type ItemSummary = z.infer<typeof ItemSummarySchema>;

export const SearchResponseSchema = z.object({
  items: z.array(ItemSummarySchema),
  page: PageMetaSchema,
});

export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const NewResponseSchema = SearchResponseSchema;
export type NewResponse = z.infer<typeof NewResponseSchema>;

export const TopicsResponseSchema = z.object({
  topics: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      itemCount: z.number().int(),
    }),
  ),
});

export type TopicsResponse = z.infer<typeof TopicsResponseSchema>;

export const LanguagesResponseSchema = z.object({
  languages: z.array(
    z.object({
      language: z.string(),
      slug: z.string(),
      itemCount: z.number().int(),
    }),
  ),
});

export type LanguagesResponse = z.infer<typeof LanguagesResponseSchema>;

export const CompareResponseSchema = z.object({
  window: WindowSchema,
  granularity: z.enum(['hour', 'day']),
  metric: MetricSchema.nullable(),
  items: z.array(
    z.object({
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
    }),
  ),
  series: z.record(z.string(), z.array(z.object({ t: z.string(), v: z.number() }))),
});

export type CompareResponse = z.infer<typeof CompareResponseSchema>;

export const StatsResponseSchema = z.object({
  items: z.record(SourceSchema, z.number().int()),
  runs: z.array(
    z.object({
      source: SourceSchema.nullable(),
      jobType: z.string(),
      runId: z.string(),
      lastSuccessAt: z.iso.datetime(),
    }),
  ),
});

export type StatsResponse = z.infer<typeof StatsResponseSchema>;

/** The API's `leaderboard.update` SSE frame (spec §10.6). */
export const StreamUpdateSchema = z.object({
  scope: LeaderboardScopeSchema,
  window: WindowSchema,
  runId: z.string(),
  movers: z.array(z.unknown()),
  entered: z.array(z.string()),
  exited: z.array(z.string()),
});

export type StreamUpdate = z.infer<typeof StreamUpdateSchema>;
