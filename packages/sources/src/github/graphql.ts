import { UpstreamError } from '@trendr/core';

import type { DiscoveredRef } from '../adapter.js';
import {
  GitHubGraphqlRateLimitSchema,
  GitHubGraphqlRepoSchema,
  type GitHubGraphqlEnvelope,
  type GitHubGraphqlRepo,
} from './schemas.js';

/**
 * Spec §7.3.1 — the batched snapshot query: ≤ 50 aliased `repository` fields
 * per request and `rateLimit { cost }` always requested (GAP-1). Parsing is a
 * pure function so request/response shapes are unit-testable.
 */

/** Spec §7.3.1: "≤ 50 aliased repository(owner:, name:) fields per query". */
export const GRAPHQL_MAX_ALIASES = 50;

const REPO_SELECTION = [
  'id',
  'nameWithOwner',
  'url',
  'description',
  'homepageUrl',
  'createdAt',
  'pushedAt',
  'isArchived',
  'isFork',
  'stargazerCount',
  'forkCount',
  'watchers{totalCount}',
  'issues(states:OPEN){totalCount}',
  'primaryLanguage{name}',
  'repositoryTopics(first:20){nodes{topic{name}}}',
  'licenseInfo{spdxId}',
  'owner{login}',
].join(' ');

export interface GraphqlBatchRequest {
  query: string;
  variables: Record<string, string>;
}

/** Build the aliased batch query for one chunk of refs (≤ `GRAPHQL_MAX_ALIASES`). */
export function buildBatchQuery(refs: readonly DiscoveredRef[]): GraphqlBatchRequest {
  if (refs.length === 0) throw new Error('buildBatchQuery needs at least one ref');
  if (refs.length > GRAPHQL_MAX_ALIASES) {
    throw new Error(`buildBatchQuery accepts at most ${GRAPHQL_MAX_ALIASES} refs`);
  }
  const variables: Record<string, string> = {};
  const declarations: string[] = [];
  const fields: string[] = [];
  refs.forEach((ref, index) => {
    const slash = ref.externalId.indexOf('/');
    if (slash <= 0 || slash === ref.externalId.length - 1) {
      throw new Error(`invalid github ref "${ref.externalId}" (expected "owner/name")`);
    }
    variables[`o${index}`] = ref.externalId.slice(0, slash);
    variables[`n${index}`] = ref.externalId.slice(slash + 1);
    declarations.push(`$o${index}: String!`, `$n${index}: String!`);
    fields.push(`r${index}: repository(owner:$o${index}, name:$n${index}) { ${REPO_SELECTION} }`);
  });
  return {
    query: `query TrendrRepoBatch(${declarations.join(', ')}) { ${fields.join(' ')} rateLimit { cost remaining resetAt } }`,
    variables,
  };
}

export interface GraphqlBatchEntry {
  index: number;
  /** `null` when the alias resolved to no repository. */
  raw: GitHubGraphqlRepo | null;
  status: 'ok' | 'not_found';
}

export interface GraphqlBatchParsed {
  entries: GraphqlBatchEntry[];
  /** GAP-1: measured point cost of this batch. */
  rateLimit: { cost: number; remaining: number; resetAt: Date | null } | null;
}

function summarize(messages: readonly string[]): string {
  return messages.slice(0, 3).join('; ');
}

/**
 * Parse one GraphQL batch response. Per-alias `null` + `NOT_FOUND` errors mean
 * the repository is gone; any other GraphQL error fails the batch (rate limits
 * stay retryable, everything else is a schema/contract problem → DLQ).
 */
export function parseBatchResponse(
  envelope: GitHubGraphqlEnvelope,
  aliasCount: number,
): GraphqlBatchParsed {
  const errors = envelope.errors ?? [];
  if (errors.some((error) => error.type === 'RATE_LIMITED')) {
    throw new UpstreamError('github graphql: rate limited', 'github', 200, null, true);
  }
  const isNotFound = (error: (typeof errors)[number]): boolean =>
    error.type === 'NOT_FOUND' || error.message.includes('Could not resolve to a Repository');
  const fatal = errors.filter((error) => !isNotFound(error));
  if (fatal.length > 0) {
    throw new UpstreamError(
      `github graphql error: ${summarize(fatal.map((error) => error.message))}`,
      'github',
      200,
      null,
      false,
    );
  }

  const data = envelope.data ?? null;
  const rateLimitRaw = data?.rateLimit;
  const rateLimitParsed =
    rateLimitRaw === undefined ? null : GitHubGraphqlRateLimitSchema.safeParse(rateLimitRaw);
  const rateLimit =
    rateLimitParsed?.success === true
      ? {
          cost: rateLimitParsed.data.cost,
          remaining: rateLimitParsed.data.remaining,
          resetAt: Number.isNaN(Date.parse(rateLimitParsed.data.resetAt))
            ? null
            : new Date(rateLimitParsed.data.resetAt),
        }
      : null;

  const entries: GraphqlBatchEntry[] = [];
  for (let index = 0; index < aliasCount; index += 1) {
    const value = data === null ? undefined : data[`r${index}`];
    if (value === undefined || value === null) {
      entries.push({ index, raw: null, status: 'not_found' });
      continue;
    }
    const parsed = GitHubGraphqlRepoSchema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new UpstreamError(
        `github graphql shape mismatch at alias r${index}: ${issues}`,
        'github',
        200,
        null,
        false,
      );
    }
    entries.push({ index, raw: parsed.data, status: 'ok' });
  }
  return { entries, rateLimit };
}
