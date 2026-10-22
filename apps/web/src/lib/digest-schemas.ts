import { z } from 'zod';

/** Mirrors the API digest wires. */

export const DigestSourceSchema = z.enum(['github', 'npm', 'pypi', 'huggingface', 'arxiv', 'mcp']);
export type DigestSource = z.infer<typeof DigestSourceSchema>;

export const DigestSubscriptionSchema = z.object({
  sources: z.array(DigestSourceSchema),
  topics: z.array(z.string()),
  includeWatchlist: z.boolean(),
  dayOfWeek: z.number().int().min(0).max(6),
  enabled: z.boolean(),
  unsubscribedAt: z.iso.datetime().nullable(),
});
export type DigestSubscription = z.infer<typeof DigestSubscriptionSchema>;

export const DigestResponseSchema = z.object({
  subscription: DigestSubscriptionSchema.nullable(),
});
