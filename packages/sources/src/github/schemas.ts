import { z } from 'zod';

/**
 * Spec §7.3.1 — payload schemas for the three GitHub APIs the adapter speaks.
 * Every fetch validates with these; unknown fields are stripped (GitHub adds
 * fields freely, so the schemas list exactly what normalization consumes).
 */

/** `GET /repos/{owner}/{repo}` and the minimal repos inside search results. */
export const GitHubRestRepoSchema = z.object({
  id: z.number(),
  node_id: z.string(),
  name: z.string(),
  full_name: z.string(),
  owner: z.object({ login: z.string() }),
  html_url: z.string(),
  description: z.string().nullable(),
  homepage: z.string().nullable(),
  language: z.string().nullable(),
  license: z.object({ spdx_id: z.string().nullable() }).nullable(),
  fork: z.boolean(),
  archived: z.boolean(),
  created_at: z.string(),
  pushed_at: z.string().nullable(),
  stargazers_count: z.number(),
  forks_count: z.number(),
  /** Search results omit the subscriber count; `GET /repos/…` always has it. */
  subscribers_count: z.number().optional(),
  open_issues_count: z.number(),
  topics: z.array(z.string()).optional(),
});
export type GitHubRestRepo = z.infer<typeof GitHubRestRepoSchema>;

/** `GET /search/repositories` (spec §7.3.1, exactly 1,000 results max per query). */
export const GitHubSearchResponseSchema = z.object({
  total_count: z.number(),
  incomplete_results: z.boolean(),
  items: z.array(GitHubRestRepoSchema),
});
export type GitHubSearchResponse = z.infer<typeof GitHubSearchResponseSchema>;

/** One `repository(owner:, name:)` field of the GraphQL batch (spec §7.3.1). */
export const GitHubGraphqlRepoSchema = z.object({
  id: z.string(), // node id — survives renames (§5.4)
  nameWithOwner: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  homepageUrl: z.string().nullable(),
  createdAt: z.string(),
  pushedAt: z.string().nullable(),
  isArchived: z.boolean(),
  isFork: z.boolean(),
  stargazerCount: z.number(),
  forkCount: z.number(),
  watchers: z.object({ totalCount: z.number() }),
  issues: z.object({ totalCount: z.number() }),
  primaryLanguage: z.object({ name: z.string() }).nullable(),
  repositoryTopics: z.object({
    nodes: z.array(z.object({ topic: z.object({ name: z.string() }) })),
  }),
  licenseInfo: z.object({ spdxId: z.string().nullable() }).nullable(),
  owner: z.object({ login: z.string() }),
});
export type GitHubGraphqlRepo = z.infer<typeof GitHubGraphqlRepoSchema>;

export const GitHubGraphqlErrorSchema = z.object({
  type: z.string().nullable().optional(),
  message: z.string(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
});
export type GitHubGraphqlError = z.infer<typeof GitHubGraphqlErrorSchema>;

/** GraphQL envelope — partial data is normal, so `data` is a loose record. */
export const GitHubGraphqlEnvelopeSchema = z.object({
  data: z.record(z.string(), z.unknown()).nullish(),
  errors: z.array(GitHubGraphqlErrorSchema).optional(),
});
export type GitHubGraphqlEnvelope = z.infer<typeof GitHubGraphqlEnvelopeSchema>;

/** `rateLimit { cost remaining resetAt }` — always requested (GAP-1). */
export const GitHubGraphqlRateLimitSchema = z.object({
  cost: z.number(),
  remaining: z.number(),
  resetAt: z.string(),
});
export type GitHubGraphqlRateLimit = z.infer<typeof GitHubGraphqlRateLimitSchema>;

/** `GET /repos/{o}/{r}/stargazers` with `Accept: application/vnd.github.star+json`. */
export const GitHubStargazerPageSchema = z.array(z.object({ starred_at: z.string() }));
export type GitHubStargazerPage = z.infer<typeof GitHubStargazerPageSchema>;

/** Both shapes flow into one `normalize` (spec §5.1: pure, fixture-tested). */
export type GitHubRepoRaw = GitHubRestRepo | GitHubGraphqlRepo;
