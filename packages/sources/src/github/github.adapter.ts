import {
  fetchJson,
  normalizeGitHubRepo,
  normalizeTopicSlugs,
  RedisTokenBucket,
  redisKeys,
  UpstreamError,
  type FetchJsonMetricsSink,
  type ItemFlag,
} from '@trendr/core';
import type { Redis } from 'ioredis';

import type {
  AdapterContext,
  DiscoveredRef,
  FetchedItem,
  NormalizedItem,
  SourceAdapter,
} from '../adapter.js';
import { createBucket, githubCoreBucketSpec } from '../buckets.js';
import {
  buildBatchQuery,
  cumulativeStarHistory,
  GRAPHQL_MAX_ALIASES,
  parseBatchResponse,
} from './graphql.js';
import {
  buildSearchQueries,
  parseLastPage,
  SEARCH_MAX_PAGE,
  SEARCH_PAGE_SIZE,
  splitCreatedRange,
  withCreatedRange,
  GITHUB_SEARCH_STRATEGIES,
  type GitHubSearchStrategy,
  type SearchQuery,
} from './rest.js';
import {
  GitHubGraphqlEnvelopeSchema,
  GitHubRestRepoSchema,
  GitHubSearchResponseSchema,
  GitHubStargazerPageSchema,
  type GitHubRepoRaw,
  type GitHubRestRepo,
} from './schemas.js';

/**
 * Spec §7.3.1 — the GitHub adapter: REST search discovery (date-sliced),
 * GraphQL batch snapshots, REST conditional refresh with Redis ETags, rename
 * detection via `nameWithOwner` (§5.4) and the stargazer backfill walk.
 */

const GITHUB_API = 'https://api.github.com';
const ETAG_TTL_SECONDS = 7 * 24 * 3_600; // spec §7.3.1
const STARGAZER_ACCEPT = 'application/vnd.github.star+json';
const STARGAZER_PAGE_SIZE = 100;
const DAY_MS = 86_400_000;
const DEFAULT_RESERVE = 200; // GITHUB_RESERVE
const DEFAULT_BACKFILL_MAX_PAGES = 50; // BACKFILL_GITHUB_MAX_PAGES

/** The bucket surface the adapter needs (fetchJson's own bucket option). */
export type BucketLike = Pick<RedisTokenBucket, 'take' | 'pauseUntil'>;

export interface GitHubBuckets {
  /** One `rl:github:core:{tokenIdx}` bucket per token (spec §7.3.1). */
  core: BucketLike[];
  search: BucketLike;
  graphql: BucketLike;
}

/** Spec §7.3.1 — `etag:github:{itemId}` (7 d TTL). */
export interface GitHubEtagStore {
  get(itemId: bigint): Promise<string | null>;
  set(itemId: bigint, etag: string): Promise<void>;
}

export function createRedisEtagStore(redis: Redis): GitHubEtagStore {
  return {
    async get(itemId) {
      return redis.get(redisKeys.etagGithub(itemId));
    },
    async set(itemId, etag) {
      await redis.set(redisKeys.etagGithub(itemId), etag, 'EX', ETAG_TTL_SECONDS);
    },
  };
}

export function createGitHubBuckets(redis: Redis, tokenCount: number): GitHubBuckets {
  const count = Math.max(1, tokenCount);
  return {
    core: Array.from(
      { length: count },
      (_, index) => new RedisTokenBucket(redis, githubCoreBucketSpec(index)),
    ),
    search: createBucket(redis, 'github:search'),
    graphql: createBucket(redis, 'github:graphql'),
  };
}

export interface GitHubAdapterConfig {
  /** `GITHUB_TOKENS` — fine-grained PATs with public read-only access. */
  tokens: readonly string[];
  /** `HTTP_USER_AGENT`. */
  userAgent: string;
  /** `GITHUB_RESERVE` — pause a bucket below this remaining budget (§7.4). */
  reserve?: number;
  /** `BACKFILL_GITHUB_MAX_PAGES`. */
  backfillMaxPages?: number;
  buckets: GitHubBuckets;
  etags: GitHubEtagStore;
}

function emptyToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Spec §5.1 `normalize` — pure payload → canonical shape. Handles both the
 * GraphQL batch shape and the REST repo shape (search items share it).
 */
export function normalizeGitHubItem(
  fetched: FetchedItem<GitHubRepoRaw | null>,
): NormalizedItem | null {
  const raw = fetched.raw;
  if (raw === null || fetched.notModified === true || fetched.notFound === true) {
    return null;
  }
  const isGraphql = 'nameWithOwner' in raw;
  const fullName = isGraphql ? raw.nameWithOwner : raw.full_name;
  let externalId: string;
  try {
    externalId = normalizeGitHubRepo(fullName);
  } catch {
    return null;
  }
  const slash = externalId.indexOf('/');
  const name = slash === -1 ? externalId : externalId.slice(slash + 1);
  const owner = slash === -1 ? null : externalId.slice(0, slash);

  const createdAt = new Date(isGraphql ? raw.createdAt : raw.created_at);
  const alreadyArchived = isGraphql ? raw.isArchived : raw.archived;
  const flags: ItemFlag[] = [];
  if (isGraphql ? raw.isFork : raw.fork) {
    flags.push('fork');
  }
  const spdx = isGraphql ? (raw.licenseInfo?.spdxId ?? null) : (raw.license?.spdx_id ?? null);
  const topics = isGraphql
    ? raw.repositoryTopics.nodes.map((node) => node.topic.name)
    : (raw.topics ?? []);

  const snapshots: { metric: 'stars' | 'forks' | 'watchers' | 'open_issues'; value: number }[] = [
    { metric: 'stars', value: isGraphql ? raw.stargazerCount : raw.stargazers_count },
    { metric: 'forks', value: isGraphql ? raw.forkCount : raw.forks_count },
    { metric: 'open_issues', value: isGraphql ? raw.issues.totalCount : raw.open_issues_count },
  ];
  if (isGraphql) {
    snapshots.push({ metric: 'watchers', value: raw.watchers.totalCount });
  } else if (raw.subscribers_count !== undefined) {
    // REST search items have no subscriber count; the repo endpoint does.
    snapshots.push({ metric: 'watchers', value: raw.subscribers_count });
  }

  return {
    item: {
      source: 'github',
      kind: 'repo',
      externalId,
      upstreamId: isGraphql ? raw.id : raw.node_id,
      name,
      displayName: externalId,
      description: raw.description,
      url: isGraphql ? raw.url : raw.html_url,
      homepage: emptyToNull(isGraphql ? raw.homepageUrl : raw.homepage),
      language: (isGraphql ? raw.primaryLanguage?.name : raw.language) ?? null,
      license: spdx === 'NOASSERTION' ? null : spdx,
      owner,
      topics: normalizeTopicSlugs(topics),
      primaryMetric: 'stars',
      upstreamCreatedAt: Number.isNaN(createdAt.getTime()) ? null : createdAt,
      isArchived: alreadyArchived,
      flags,
      metadata: { pushedAt: (isGraphql ? raw.pushedAt : raw.pushed_at) ?? null },
    },
    snapshots,
    daily: [],
    aliases: [],
  };
}

function parseStrategy(raw: string | undefined): GitHubSearchStrategy {
  const strategy = raw ?? 'new-hot';
  const found = GITHUB_SEARCH_STRATEGIES.find((candidate) => candidate === strategy);
  if (found === undefined) {
    throw new Error(`unknown github discovery strategy "${strategy}"`);
  }
  return found;
}

/** `exactOptionalPropertyTypes`: only forward the sink when the worker set one. */
function sinkOptions(ctx: AdapterContext): { metrics?: FetchJsonMetricsSink } {
  return ctx.metrics === undefined ? {} : { metrics: ctx.metrics };
}

/** Spec §7.3.1 adapter factory (one per worker process; §3.3). */
export function createGitHubAdapter(
  config: GitHubAdapterConfig,
): SourceAdapter<GitHubRepoRaw | null> {
  if (config.tokens.length === 0) {
    throw new Error('createGitHubAdapter needs at least one token (GITHUB_TOKENS)');
  }
  const reserve = config.reserve ?? DEFAULT_RESERVE;
  const backfillMaxPages = Math.max(1, config.backfillMaxPages ?? DEFAULT_BACKFILL_MAX_PAGES);

  let cursor = 0;
  function nextToken(): { index: number; token: string } {
    const index = cursor % config.tokens.length;
    cursor += 1;
    const token = config.tokens[index];
    if (token === undefined) throw new Error('GITHUB_TOKENS is empty');
    return { index, token };
  }

  function bucketForCore(index: number): BucketLike {
    const bucket = config.buckets.core[index];
    if (bucket === undefined) throw new Error(`no core bucket for token index ${index}`);
    return bucket;
  }

  /**
   * Spec §7.4 — observe `x-ratelimit-*` (gauge + run counter) and, below
   * `GITHUB_RESERVE`, pause the bucket that made the request until reset.
   * GAP-8: report the fine-grained PAT expiry header when present.
   */
  function makeOnHeaders(
    ctx: AdapterContext,
    tokenIndex: number,
    bucket: BucketLike,
  ): (headers: Headers) => Promise<void> {
    return async (headers) => {
      const remaining = Number(headers.get('x-ratelimit-remaining') ?? Number.NaN);
      const resetEpoch = Number(headers.get('x-ratelimit-reset') ?? Number.NaN);
      const resetAt =
        Number.isFinite(resetEpoch) && resetEpoch > 0 ? new Date(resetEpoch * 1000) : null;
      if (Number.isFinite(remaining)) {
        ctx.onRateLimit?.({
          resource: headers.get('x-ratelimit-resource') ?? 'core',
          remaining,
          resetAt,
        });
        if (remaining < reserve && resetAt !== null && resetAt.getTime() > Date.now()) {
          await bucket.pauseUntil(resetAt.getTime());
        }
      }
      const expiryHeader = headers.get('github-authentication-token-expiration');
      if (expiryHeader !== null) {
        const expiresAt = new Date(expiryHeader);
        if (!Number.isNaN(expiresAt.getTime())) {
          ctx.onTokenExpiry?.({ tokenIndex, expiresAt });
        }
      }
    };
  }

  function authHeaders(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  async function requestSearchPage(
    ctx: AdapterContext,
    query: SearchQuery,
    page: number,
    token: string,
    tokenIndex: number,
  ): Promise<{ totalCount: number; items: GitHubRestRepo[]; offset: number }> {
    const params = new URLSearchParams({
      q: query.q,
      sort: query.sort,
      order: query.order,
      per_page: String(SEARCH_PAGE_SIZE),
      page: String(page),
    });
    const bucket = config.buckets.search;
    const result = await fetchJson({
      url: `${GITHUB_API}/search/repositories?${params.toString()}`,
      schema: GitHubSearchResponseSchema,
      bucket,
      source: 'github',
      endpoint: 'search.repositories',
      userAgent: config.userAgent,
      headers: authHeaders(token),
      onHeaders: makeOnHeaders(ctx, tokenIndex, bucket),
      ...sinkOptions(ctx),
      signal: ctx.signal,
    });
    if (result.status !== 'ok') {
      throw new UpstreamError(`search returned ${result.status}`, 'github', null, null, false);
    }
    return {
      totalCount: result.data.total_count,
      items: result.data.items,
      offset: (page - 1) * SEARCH_PAGE_SIZE,
    };
  }

  function searchRefs(
    items: readonly GitHubRestRepo[],
    query: SearchQuery,
    strategy: GitHubSearchStrategy,
    offset: number,
  ): DiscoveredRef[] {
    return items.map((raw, index) => ({
      source: 'github' as const,
      kind: 'repo' as const,
      externalId: normalizeGitHubRepo(raw.full_name),
      hint: { reason: strategy, query: query.q, rank: offset + index },
      raw,
    }));
  }

  function searchPages(
    ctx: AdapterContext,
    query: SearchQuery,
    depth: number,
    strategy: GitHubSearchStrategy,
  ): AsyncGenerator<DiscoveredRef[]> {
    return (async function* iterate() {
      const { index, token } = nextToken();
      const first = await requestSearchPage(ctx, query, 1, token, index);
      yield searchRefs(first.items, query, strategy, 0);
      const pageCount = Math.min(
        SEARCH_MAX_PAGE,
        Math.max(1, Math.ceil(first.totalCount / SEARCH_PAGE_SIZE)),
      );
      for (let page = 2; page <= pageCount; page += 1) {
        ctx.signal.throwIfAborted();
        const next = await requestSearchPage(ctx, query, page, token, index);
        if (next.items.length === 0) break;
        yield searchRefs(next.items, query, strategy, next.offset);
      }
      // §7.3.1: beat the 1,000-result cap on created: ranges by bisecting.
      if (
        query.created !== null &&
        first.totalCount > SEARCH_PAGE_SIZE * SEARCH_MAX_PAGE &&
        depth < 4
      ) {
        for (const half of splitCreatedRange(query.created)) {
          yield* searchPages(ctx, withCreatedRange(query, half), depth + 1, strategy);
        }
      }
    })();
  }

  async function fetchSingleRest(
    ctx: AdapterContext,
    ref: DiscoveredRef,
  ): Promise<FetchedItem<GitHubRepoRaw | null>> {
    const { index, token } = nextToken();
    const bucket = bucketForCore(index);
    const etag = ref.itemId === undefined ? null : await config.etags.get(ref.itemId);
    const result = await fetchJson({
      url: `${GITHUB_API}/repos/${ref.externalId}`,
      schema: GitHubRestRepoSchema,
      bucket,
      source: 'github',
      endpoint: 'repos.get',
      userAgent: config.userAgent,
      headers: authHeaders(token),
      etag,
      onHeaders: makeOnHeaders(ctx, index, bucket),
      ...sinkOptions(ctx),
      signal: ctx.signal,
    });
    const fetchedAt = ctx.now();
    if (result.status === 'not_modified') {
      return { ref, raw: null, fetchedAt, notModified: true };
    }
    if (result.status === 'not_found') {
      return { ref, raw: null, fetchedAt, notFound: true };
    }
    if (result.etag !== null && ref.itemId !== undefined) {
      await config.etags.set(ref.itemId, result.etag);
    }
    return { ref, raw: result.data, fetchedAt };
  }

  async function fetchGraphqlBatch(
    ctx: AdapterContext,
    refs: readonly DiscoveredRef[],
  ): Promise<FetchedItem<GitHubRepoRaw | null>[]> {
    const { index, token } = nextToken();
    const request = buildBatchQuery(refs);
    const bucket = bucketForCore(index);
    const result = await fetchJson({
      url: `${GITHUB_API}/graphql`,
      method: 'POST',
      body: { query: request.query, variables: request.variables },
      schema: GitHubGraphqlEnvelopeSchema,
      bucket,
      source: 'github',
      endpoint: 'graphql.repository-batch',
      userAgent: config.userAgent,
      headers: authHeaders(token),
      onHeaders: makeOnHeaders(ctx, index, bucket),
      ...sinkOptions(ctx),
      signal: ctx.signal,
    });
    if (result.status !== 'ok') {
      throw new UpstreamError(`graphql returned ${result.status}`, 'github', null, null, false);
    }
    const parsed = parseBatchResponse(result.data, refs.length);
    if (parsed.rateLimit !== null) {
      // GAP-1: every batch reports its measured point cost.
      ctx.onRateLimit?.({
        resource: 'graphql',
        remaining: parsed.rateLimit.remaining,
        resetAt: parsed.rateLimit.resetAt,
      });
      ctx.logger.debug(
        { cost: parsed.rateLimit.cost, aliases: refs.length },
        'github graphql batch point cost',
      );
    }
    const fetchedAt = ctx.now();
    return refs.map((ref, position) => {
      const entry = parsed.entries[position];
      if (entry === undefined) {
        throw new Error(`graphql batch lost alias r${position}`);
      }
      return entry.raw === null
        ? { ref, raw: null, fetchedAt, notFound: true }
        : { ref, raw: entry.raw, fetchedAt };
    });
  }

  return {
    source: 'github',
    kinds: ['repo'],
    /** Spec §5.1: GraphQL batch 50 (spec §7.3.1 `repository` aliases). */
    batchSize: GRAPHQL_MAX_ALIASES,

    async *discover(ctx, opts) {
      const strategy = parseStrategy(opts.strategy);
      const queries = buildSearchQueries(strategy, ctx.now());
      const limit = Math.max(1, opts.maxItems);
      let emitted = 0;
      for (const query of queries) {
        for await (const page of searchPages(ctx, query, 0, strategy)) {
          if (emitted >= limit) return;
          const slice = page.slice(0, limit - emitted);
          emitted += slice.length;
          if (slice.length > 0) yield slice;
          if (emitted >= limit) return;
        }
      }
    },

    async fetchMetrics(ctx, refs) {
      if (refs.length === 0) return [];
      if (refs.length === 1) {
        const only = refs[0];
        if (only === undefined) return [];
        return [await fetchSingleRest(ctx, only)];
      }
      const out: FetchedItem<GitHubRepoRaw | null>[] = [];
      for (let offset = 0; offset < refs.length; offset += GRAPHQL_MAX_ALIASES) {
        out.push(
          ...(await fetchGraphqlBatch(ctx, refs.slice(offset, offset + GRAPHQL_MAX_ALIASES))),
        );
      }
      return out;
    },

    normalize: normalizeGitHubItem,

    /** Spec §7.3.1 backfill: walk stargazers backward → end-of-day cumulative stars. */
    async backfill(ctx, ref, days) {
      const { index, token } = nextToken();
      const bucket = bucketForCore(index);

      const requestPage = async (
        page: number,
      ): Promise<{ timestamps: number[]; lastPage: number }> => {
        const result = await fetchJson({
          url: `${GITHUB_API}/repos/${ref.externalId}/stargazers?per_page=${STARGAZER_PAGE_SIZE}&page=${page}`,
          schema: GitHubStargazerPageSchema,
          bucket,
          source: 'github',
          endpoint: 'repos.stargazers',
          userAgent: config.userAgent,
          headers: { ...authHeaders(token), accept: STARGAZER_ACCEPT },
          onHeaders: makeOnHeaders(ctx, index, bucket),
          ...sinkOptions(ctx),
          signal: ctx.signal,
        });
        if (result.status !== 'ok') {
          throw new UpstreamError(
            `stargazers returned ${result.status}`,
            'github',
            null,
            null,
            false,
          );
        }
        return {
          timestamps: result.data
            .map((row) => Date.parse(row.starred_at))
            .filter((value) => Number.isFinite(value)),
          lastPage: parseLastPage(result.headers.get('link')) ?? 1,
        };
      };

      const cutoff = new Date(ctx.now().getTime() - Math.max(1, days) * DAY_MS);
      const first = await requestPage(1);
      let pagesFetched = 1;
      const walked: number[] = [];
      let totalStars: number;
      if (first.lastPage === 1) {
        walked.push(...first.timestamps);
        totalStars = first.timestamps.length;
      } else {
        const last = await requestPage(first.lastPage);
        pagesFetched += 1;
        totalStars = (first.lastPage - 1) * STARGAZER_PAGE_SIZE + last.timestamps.length;
        walked.push(...last.timestamps);
        let page = first.lastPage - 1;
        let done = last.timestamps.some((value) => value < cutoff.getTime());
        while (!done && page >= 1 && pagesFetched < backfillMaxPages) {
          ctx.signal.throwIfAborted();
          const batch = page === 1 ? first : await requestPage(page);
          pagesFetched += 1;
          walked.push(...batch.timestamps);
          done = batch.timestamps.some((value) => value < cutoff.getTime());
          page -= 1;
        }
      }

      return cumulativeStarHistory(walked, totalStars, cutoff, ctx.now()).map((row) => ({
        metric: 'stars' as const,
        day: row.day,
        value: row.value,
      }));
    },
  };
}
