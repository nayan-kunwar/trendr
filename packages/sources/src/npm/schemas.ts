import { z } from 'zod';

/**
 * Spec §7.3.2 — payload schemas for the three npm endpoints the adapter
 * speaks. Every fetch validates with these; unknown fields are stripped (npm
 * adds fields freely, so the schemas list exactly what normalization consumes).
 */

/** `license` is a string in the registry today, but legacy docs use an object. */
const NpmLicenseSchema = z
  .union([z.string(), z.object({ type: z.string().optional(), url: z.string().optional() })])
  .nullable();

/** `repository` accepts the string shorthand (`github:o/r`) or the object form. */
const NpmRepositorySchema = z
  .union([
    z.string(),
    z.object({
      type: z.string().optional(),
      url: z.string().optional(),
      directory: z.string().optional(),
    }),
  ])
  .nullable();

/**
 * `GET https://registry.npmjs.org/-/v1/search?text=keywords:{k}` — the result
 * object carries enough metadata to normalize a discovered item without a
 * second request (`links.repository` is the alias source, spec §7.3.2).
 */
export const NpmSearchPackageSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  description: z.string().nullable().optional(),
  keywords: z.array(z.string()).optional(),
  date: z.string().optional(),
  links: z
    .object({
      npm: z.string().optional(),
      homepage: z.string().nullable().optional(),
      repository: z.string().nullable().optional(),
      bugs: z.string().nullable().optional(),
    })
    .optional(),
  publisher: z
    .object({
      username: z.string().optional(),
      email: z.string().optional(),
    })
    .optional(),
  license: NpmLicenseSchema.optional(),
});
export type NpmSearchPackage = z.infer<typeof NpmSearchPackageSchema>;

export const NpmSearchResultSchema = z.object({
  package: NpmSearchPackageSchema,
  downloads: z
    .object({
      monthly: z.number(),
      weekly: z.number(),
    })
    .optional(),
  updated: z.string().optional(),
});
export type NpmSearchResult = z.infer<typeof NpmSearchResultSchema>;

export const NpmSearchResponseSchema = z.object({
  objects: z.array(NpmSearchResultSchema),
});
export type NpmSearchResponse = z.infer<typeof NpmSearchResponseSchema>;

/** One version manifest; only the fields used for metadata/aliases are listed. */
export const NpmVersionSchema = z.looseObject({
  description: z.string().nullable().optional(),
  license: NpmLicenseSchema.optional(),
  repository: NpmRepositorySchema.optional(),
  types: z.string().optional(),
  typings: z.string().optional(),
});
export type NpmVersion = z.infer<typeof NpmVersionSchema>;

/**
 * `GET https://registry.npmjs.org/{pkg}` — the full packument (spec §7.3.2
 * uses the full doc, not the install-v1 abbreviated form, because only the
 * former reliably carries `repository`).
 */
export const NpmPackumentSchema = z.looseObject({
  name: z.string(),
  description: z.string().nullable().optional(),
  homepage: z.string().nullable().optional(),
  license: NpmLicenseSchema.optional(),
  keywords: z.array(z.string()).optional(),
  repository: NpmRepositorySchema.optional(),
  'dist-tags': z.looseObject({ latest: z.string().optional() }).optional(),
  time: z
    .looseObject({
      created: z.string().optional(),
      modified: z.string().optional(),
    })
    .optional(),
  versions: z.record(z.string(), NpmVersionSchema).optional(),
});
export type NpmPackument = z.infer<typeof NpmPackumentSchema>;

export const NpmDownloadsPointSchema = z.object({
  downloads: z.number(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type NpmDownloadsPoint = z.infer<typeof NpmDownloadsPointSchema>;

/** `GET https://api.npmjs.org/downloads/range/{start}:{end}/{pkg}`. */
export const NpmDownloadsRangeSchema = z.object({
  start: z.string(),
  end: z.string(),
  package: z.string(),
  downloads: z.array(NpmDownloadsPointSchema),
});
export type NpmDownloadsRange = z.infer<typeof NpmDownloadsRangeSchema>;

/**
 * `GET https://api.npmjs.org/downloads/point/last-day/{pkg}`. Unlike a range
 * request — which echoes the requested end and fills a not-yet-computed day
 * with `0` — this returns the last day whose counts are actually available.
 */
export const NpmPointSchema = z.object({
  downloads: z.number(),
  start: z.string(),
  end: z.string(),
  package: z.string(),
});
export type NpmPoint = z.infer<typeof NpmPointSchema>;

/**
 * Bulk range response: package name → range. A package the registry has never
 * seen comes back as `null` (HTTP 200), which the adapter maps to `notFound`.
 */
export const NpmBulkDownloadsSchema = z.record(z.string(), NpmDownloadsRangeSchema.nullable());
export type NpmBulkDownloads = z.infer<typeof NpmBulkDownloadsSchema>;
