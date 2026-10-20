import { z } from 'zod';

/**
 * Spec §7.3.4 — the HF Hub list/detail shape. `expand[]` controls which fields
 * are returned, so every consumed field is optional (the adapter requests its
 * own per-kind set); unknown fields are stripped. `_id` is the stable upstream
 * id used for rename detection (§5.4).
 */

export const HfRepoSchema = z.object({
  _id: z.string().nullish(),
  id: z.string().min(1),
  author: z.string().nullish(),
  likes: z.number().int().nonnegative().nullish(),
  downloads: z.number().int().nonnegative().nullish(),
  downloadsAllTime: z.number().int().nonnegative().nullish(),
  trendingScore: z.number().nullish(),
  createdAt: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  description: z.string().nullish(),
  pipeline_tag: z.string().nullish(),
  library_name: z.string().nullish(),
  sdk: z.string().nullish(),
  gated: z.union([z.boolean(), z.string()]).nullish(),
  disabled: z.boolean().nullish(),
});

export type HfRepoPayload = z.infer<typeof HfRepoSchema>;

export const HfRepoListSchema = z.array(HfRepoSchema);
