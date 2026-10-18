import { z } from 'zod';

import {
  ItemKindSchema,
  LeaderboardEntrySchema,
  LeaderboardScopeSchema,
  WindowSchema,
} from '@trendr/core';

import { PageMeta } from './common.js';

/**
 * Spec §10.3 — `GET /v1/trending` query and response. `newOnly` parses
 * `'true'|'false'|'1'|'0'` explicitly (ISS-2: `Boolean()` would turn the string
 * `'false'` into `true`); absent means no filter, i.e. `false`.
 */

export const TrendingQuery = z.object({
  scope: LeaderboardScopeSchema.default('all'),
  window: WindowSchema.default('24h'),
  lang: z.string().trim().toLowerCase().max(40).optional(),
  topic: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,49}$/)
    .optional(),
  kind: ItemKindSchema.optional(),
  newOnly: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'), // default false; upstream_created_at within 30 d
  minCurrent: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

/** §10.3 mirrors the §5 `LeaderboardEntry` contract defined in `@trendr/core`. */
export const LeaderboardEntryDto = LeaderboardEntrySchema;

export const TrendingResponse = z.object({
  scope: LeaderboardScopeSchema,
  window: WindowSchema,
  runId: z.string(),
  computedAt: z.iso.datetime(),
  data: z.array(LeaderboardEntryDto),
  page: PageMeta,
});

export type TrendingQueryInput = z.infer<typeof TrendingQuery>;
export type TrendingResponseBody = z.infer<typeof TrendingResponse>;
export type LeaderboardEntry = z.infer<typeof LeaderboardEntryDto>;
