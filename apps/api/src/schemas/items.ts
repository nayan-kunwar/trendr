import { z } from 'zod';

import { ItemKindSchema, MetricSchema, SourceSchema, TierSchema, WindowSchema } from '@trendr/core';

/**
 * Spec §10.4 — item detail, history and score-history wire schemas, plus the
 * lookup/score-explain/aliases contracts of §10.1. Where the spec's Zod-v3
 * spelling differs from Zod v4 semantics the translation is noted inline.
 */

export const ItemAliasDto = z.object({
  id: z.string(),
  source: SourceSchema,
  displayName: z.string(),
  relation: z.string(),
  confidence: z.number(),
});

/** One window's current score as embedded in the item detail (spec §10.4). */
export const ItemScoreDto = z.object({
  rankSource: z.number().int().nullable(),
  rankAll: z.number().int().nullable(),
  delta: z.number(),
  relGrowth: z.number(),
  finalScore: z.number(),
  zScore: z.number(),
  percentile: z.number(),
  flags: z.array(z.string()),
});

export const ItemDetailResponse = z.object({
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
  // Zod v4 `z.record(enum, …)` requires every key; §10.4's record is partial
  // (`items.latest_metrics` only holds metrics observed so far).
  latestMetrics: z.partialRecord(MetricSchema, z.number()),
  tier: TierSchema,
  flags: z.array(z.string()),
  upstreamCreatedAt: z.iso.datetime().nullable(),
  firstSeenAt: z.iso.datetime(),
  lastSnapshotAt: z.iso.datetime().nullable(),
  // All three §5 windows are always present, `null` when the current run did
  // not score the item.
  scores: z.record(WindowSchema, ItemScoreDto.nullable()),
  aliases: z.array(ItemAliasDto),
  metadata: z.record(z.string(), z.unknown()),
});

export const HistoryQuery = z
  .object({
    metric: MetricSchema.optional(), // default: item.primaryMetric
    from: z.iso.datetime().optional(), // default: now - 30d
    to: z.iso.datetime().optional(), // default: now
    granularity: z.enum(['hour', 'day']).default('day'),
  })
  .refine(
    (q) => q.granularity === 'day' || !q.from || Date.now() - Date.parse(q.from) <= 14 * 864e5,
    { message: 'hour granularity limited to 14 days' },
  );

export const HistoryResponse = z.object({
  itemId: z.string(),
  metric: MetricSchema,
  kind: z.enum(['cumulative', 'daily_count', 'gauge']),
  granularity: z.enum(['hour', 'day']),
  points: z.array(z.object({ t: z.string(), v: z.number() })),
});

/** Score history. Limits mirror scores retention (6.5); the route reads env for the actual bounds. */
export const ScoresQuery = z
  .object({
    window: WindowSchema.default('7d'),
    granularity: z.enum(['hour', 'day']).default('day'),
    days: z.coerce.number().int().min(1).max(365).default(30), // capped at SCORES_DAILY_RETENTION_DAYS
  })
  .refine((q) => q.granularity === 'day' || q.days <= 2, {
    message: 'hour granularity limited to the last 48 hours',
  });

export const ScoresResponse = z.object({
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

export const LookupQuery = z.object({
  source: SourceSchema,
  externalId: z.string().trim().min(1).max(255),
});

export const ScoreExplainQuery = z.object({ window: WindowSchema.default('24h') });

export const ScoreComponentsDto = z.object({
  delta: z.number(),
  base: z.number(),
  relGrowth: z.number(),
  rawScore: z.number(),
  ageFactor: z.number(),
  confidence: z.number(),
  anomalyPenalty: z.number(),
  finalScore: z.number(),
});

export const ScoringParamsDto = z.object({
  k: z.number(),
  minDelta: z.number(),
  beta: z.number(),
  rMax: z.number(),
  burstMinAbs: z.number(),
});

/**
 * Spec §10.1: `ScoreComponents` + params + inputs for the current run; `null`
 * components with `reason: 'not_eligible'` when the item has no row in the
 * current run. `inputs` carries the persisted scoring inputs and run context
 * the row holds (delta/base/anomalyPenalty feed the formula; the rank and
 * z-score fields are the run's context).
 */
export const ScoreExplainResponse = z.object({
  itemId: z.string(),
  source: SourceSchema,
  window: WindowSchema,
  runId: z.string().nullable(),
  computedAt: z.iso.datetime().nullable(),
  components: ScoreComponentsDto.nullable(),
  params: ScoringParamsDto.nullable(),
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

export const AliasLinkDto = ItemAliasDto.extend({
  kind: ItemKindSchema,
  externalId: z.string(),
  url: z.url(),
  evidence: z.string(),
  direction: z.enum(['outgoing', 'incoming']),
});

export const ItemAliasesResponse = z.object({
  itemId: z.string(),
  aliases: z.array(AliasLinkDto),
});

export type ItemDetailBody = z.infer<typeof ItemDetailResponse>;
export type ItemScoreDto = z.infer<typeof ItemScoreDto>;
export type HistoryQueryInput = z.infer<typeof HistoryQuery>;
export type HistoryBody = z.infer<typeof HistoryResponse>;
export type ScoresQueryInput = z.infer<typeof ScoresQuery>;
export type ScoresBody = z.infer<typeof ScoresResponse>;
export type ScoreExplainBody = z.infer<typeof ScoreExplainResponse>;
export type ItemAliasesBody = z.infer<typeof ItemAliasesResponse>;
export type LookupQueryInput = z.infer<typeof LookupQuery>;
export type ScoreExplainQueryInput = z.infer<typeof ScoreExplainQuery>;
