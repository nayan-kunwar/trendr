import { z } from 'zod';

/**
 * Spec §7.3.3 — payload schemas for PyPI project JSON and pypistats. The
 * project payload is large (numpy is ~3.7 MB); the schema lists only the
 * fields normalization consumes and strips the rest, keeping the in-memory
 * object small after validation.
 */

const PypiReleaseFileSchema = z.object({
  upload_time_iso_8601: z.string().optional(),
  upload_time: z.string().optional(),
  yanked: z.boolean().optional(),
});

export const PypiProjectSchema = z.object({
  info: z.object({
    name: z.string(),
    version: z.string().nullish(),
    summary: z.string().nullish(),
    description: z.string().nullish(),
    author: z.string().nullish(),
    maintainer: z.string().nullish(),
    home_page: z.string().nullish(),
    project_url: z.string().nullish(),
    project_urls: z.record(z.string(), z.string().nullable()).nullish(),
    license: z.string().nullish(),
    license_expression: z.string().nullish(),
    keywords: z.string().nullish(),
    classifiers: z.array(z.string()).nullish(),
    requires_python: z.string().nullish(),
    yanked: z.boolean().nullish(),
  }),
  releases: z.record(z.string(), z.array(PypiReleaseFileSchema)).optional(),
});

export type PypiProject = z.infer<typeof PypiProjectSchema>;
export type PypiReleaseFile = z.infer<typeof PypiReleaseFileSchema>;

const IsoDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const PypiStatsPointSchema = z.object({
  category: z.string(),
  date: IsoDaySchema,
  downloads: z.number().int().nonnegative(),
});

export const PypiStatsOverallSchema = z.object({
  data: z.array(PypiStatsPointSchema),
  package: z.string(),
  type: z.string().optional(),
});

export type PypiStatsPoint = z.infer<typeof PypiStatsPointSchema>;

const PypiRecentDataSchema = z.object({
  last_day: z.number().int().nonnegative(),
  last_week: z.number().int().nonnegative(),
  last_month: z.number().int().nonnegative(),
});

export const PypiStatsRecentSchema = z.object({
  data: PypiRecentDataSchema,
  package: z.string(),
  type: z.string().optional(),
});

export type PypiRecentData = z.infer<typeof PypiRecentDataSchema>;
