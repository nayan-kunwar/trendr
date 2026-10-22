import { z } from 'zod';

import { SourceSchema } from '@trendr/core';

/** Spec §10.1/§13.2 — weekly-digest subscription and unsubscribe wires. */

export const DigestSubscriptionDto = z.object({
  sources: z.array(SourceSchema),
  topics: z.array(z.string()),
  includeWatchlist: z.boolean(),
  dayOfWeek: z.number().int().min(0).max(6),
  enabled: z.boolean(),
  unsubscribedAt: z.iso.datetime().nullable(),
});

export const DigestResponse = z.object({
  subscription: DigestSubscriptionDto.nullable(),
});

export const DigestBody = z.strictObject({
  sources: z
    .array(SourceSchema)
    .min(1)
    .default(['github', 'npm', 'pypi', 'huggingface', 'arxiv', 'mcp']),
  topics: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  includeWatchlist: z.boolean().default(true),
  dayOfWeek: z.number().int().min(0).max(6).default(1),
  enabled: z.boolean().default(true),
});

export const UnsubscribeQuery = z.object({
  token: z.string().min(1).max(2_000),
});

export const UnsubscribeResponse = z.object({
  ok: z.literal(true),
  purpose: z.enum(['digest', 'alerts', 'all']),
});
export type UnsubscribeBody = z.infer<typeof UnsubscribeResponse>;

export type DigestBody = z.infer<typeof DigestBody>;
export type DigestSubscriptionBody = z.infer<typeof DigestSubscriptionDto>;
