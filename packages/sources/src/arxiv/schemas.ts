import { z } from 'zod';

/**
 * Spec §7.3.5 — the two upstream payload families: the arXiv export API's
 * Atom 1.0 XML (fast-xml-parser output) and the HF paper/daily-paper JSON used
 * for the only available popularity signal (`upvotes`). Unknown HF fields are
 * intentionally stripped; the adapter only owns what it persists.
 */

export const ArxivLinkSchema = z.object({
  '@_href': z.string().min(1),
  '@_rel': z.string().optional(),
  '@_type': z.string().optional(),
  '@_title': z.string().optional(),
});

export const ArxivCategorySchema = z.object({
  '@_term': z.string().min(1),
});

export const ArxivAuthorSchema = z.object({
  name: z.string().min(1),
});

export const ArxivEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  summary: z.string().optional(),
  published: z.string().optional(),
  updated: z.string().optional(),
  author: z.union([ArxivAuthorSchema, z.array(ArxivAuthorSchema)]).optional(),
  link: z.union([ArxivLinkSchema, z.array(ArxivLinkSchema)]).optional(),
  category: z.union([ArxivCategorySchema, z.array(ArxivCategorySchema)]).optional(),
  primary_category: ArxivCategorySchema.optional(),
  comment: z.string().optional(),
  doi: z.string().optional(),
  journal_ref: z.string().optional(),
});

export const ArxivFeedSchema = z.object({
  feed: z.object({
    title: z.string().optional(),
    entry: z.union([ArxivEntrySchema, z.array(ArxivEntrySchema)]).optional(),
  }),
});

export type RawArxivEntry = z.infer<typeof ArxivEntrySchema>;

export const HfPaperAuthorSchema = z.object({
  name: z.string().min(1),
});

export const HfPaperOrganizationSchema = z.object({
  name: z.string().nullish(),
  fullname: z.string().nullish(),
});

export const HfPaperSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullish(),
  summary: z.string().nullish(),
  upvotes: z.number().int().nonnegative().nullish(),
  publishedAt: z.string().nullish(),
  authors: z.array(HfPaperAuthorSchema).nullish(),
  githubRepo: z.string().nullish(),
  githubStars: z.number().int().nonnegative().nullish(),
  projectPage: z.string().nullish(),
  organization: HfPaperOrganizationSchema.nullish(),
  numTotalModels: z.number().int().nonnegative().nullish(),
  numTotalDatasets: z.number().int().nonnegative().nullish(),
  numTotalSpaces: z.number().int().nonnegative().nullish(),
});

export const HfDailyPaperSchema = z.object({
  paper: HfPaperSchema,
  publishedAt: z.string().nullish(),
  title: z.string().nullish(),
  summary: z.string().nullish(),
});

export const HfDailyPapersSchema = z.array(HfDailyPaperSchema);

export type HfPaper = z.infer<typeof HfPaperSchema>;
