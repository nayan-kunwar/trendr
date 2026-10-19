import { z } from 'zod';

import { ItemKindSchema, MetricSchema, SourceSchema, WindowSchema } from '@trendr/core';

/**
 * Spec §10.1 — `GET /v1/compare`: 2–5 items side by side over a window. The
 * response mirrors the §11.1 `compare_items` MCP output (`window`/`items`/
 * `series`) plus the resolved `granularity` and `metric`; documented in
 * SPEC_REVIEW.
 */

export const CompareQuery = z
  .object({
    /** 2–5 comma-separated item ids; parsed by `parseCompareIds` (routes/compare). */
    ids: z.string().min(1).max(128),
    window: WindowSchema.default('24h'),
    /** Default: `hour` for 24h/7d, `day` for 30d. */
    granularity: z.enum(['hour', 'day']).optional(),
    /** Default: each item's own primary metric. */
    metric: MetricSchema.optional(),
  })
  .refine((q) => q.granularity !== 'hour' || q.window !== '30d', {
    message: 'hour granularity limited to the 24h and 7d windows',
  });

export const CompareItemDto = z.object({
  id: z.string(),
  source: SourceSchema,
  kind: ItemKindSchema,
  name: z.string(),
  displayName: z.string(),
  url: z.url(),
  /** Growth fields from the current run's score row for `window`; `null` when unscored. */
  delta: z.number().nullable(),
  relGrowth: z.number().nullable(),
  percentile: z.number().nullable(),
  rankSource: z.number().int().nullable(),
});

export const CompareSeriesPointDto = z.object({ t: z.string(), v: z.number() });

export const CompareResponse = z.object({
  window: WindowSchema,
  granularity: z.enum(['hour', 'day']),
  /** The requested metric, or `null` when each item uses its primary metric. */
  metric: MetricSchema.nullable(),
  items: z.array(CompareItemDto),
  /** Points per item id (`t` is ISO for hour, `YYYY-MM-DD` for day). */
  series: z.record(z.string(), z.array(CompareSeriesPointDto)),
});

export type CompareQueryInput = z.infer<typeof CompareQuery>;
export type CompareBody = z.infer<typeof CompareResponse>;
export type CompareItem = z.infer<typeof CompareItemDto>;
