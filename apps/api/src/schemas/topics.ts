import { z } from 'zod';

import { SourceSchema } from '@trendr/core';

/**
 * Spec §10.1 — `GET /v1/topics` (`source`, `limit` ≤ 200, sorted by item
 * count) and `GET /v1/languages` (languages that have leaderboards, §9.1:
 * the top 30 by item count).
 */

export const TopicsQuery = z.object({
  source: SourceSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/** Counts are live (spec §10.1 "sorted by item_count"); see SPEC_REVIEW. */
export const TopicDto = z.object({
  slug: z.string(),
  name: z.string(),
  itemCount: z.number().int(),
});

export const TopicsResponse = z.object({ topics: z.array(TopicDto) });

export const LanguageDto = z.object({
  /** Display value as stored on items (e.g. `TypeScript`). */
  language: z.string(),
  /** The `lang` filter slug: trimmed, lowercased (spec §9.1). */
  slug: z.string(),
  itemCount: z.number().int(),
});

export const LanguagesResponse = z.object({ languages: z.array(LanguageDto) });

export type TopicsQueryInput = z.infer<typeof TopicsQuery>;
export type TopicsBody = z.infer<typeof TopicsResponse>;
export type LanguagesBody = z.infer<typeof LanguagesResponse>;
