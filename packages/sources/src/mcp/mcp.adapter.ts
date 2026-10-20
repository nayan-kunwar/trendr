import {
  fetchJson,
  mcpGitHubFallback,
  mcpNpmFallback,
  normalizeGitHubRepo,
  normalizeNpmPackage,
  RedisTokenBucket,
  UpstreamError,
} from '@trendr/core';

import type {
  AdapterContext,
  AliasTargetKey,
  DerivedMetrics,
  DiscoveredRef,
  FetchedItem,
  NormalizedItem,
  SourceAdapter,
} from '../adapter.js';
import { GitHubSearchResponseSchema } from '../github/schemas.js';
import { NpmSearchResponseSchema } from '../npm/schemas.js';
import { createRedisMcpCursorStore, type McpCursorStore } from './cursor.js';
import { normalizeMcpItem, type McpRaw } from './normalize.js';
import { McpRegistryListSchema } from './schemas.js';
import {
  MCP_DISCOVERY_MAX_ITEMS,
  MCP_DISCOVERY_MAX_PAGES,
  MCP_FALLBACK_MAX_ITEMS,
  MCP_GITHUB_MAX_PAGES,
  MCP_GITHUB_MIN_STARS,
  MCP_GITHUB_QUERIES,
  MCP_NPM_KEYWORDS,
  MCP_NPM_MAX_PAGES,
  MCP_NPM_MIN_WEEKLY_DOWNLOADS,
  MCP_NPM_PAGE_SIZE,
  MCP_REGISTRY_BASE_V0,
  MCP_REGISTRY_BASE_V01,
  MCP_SERVER_SCHEMA_URL,
  mcpGitHubSearchUrl,
  mcpNpmSearchUrl,
  mcpServersUrl,
} from './urls.js';

/**
 * Spec §7.3.6 — the MCP adapter. Registry sync is a bounded incremental walk
 * keyed by `updated_since` (full weekly); GitHub-topic and npm-keyword passes
 * add servers that are not in the registry. Snapshots make no registry calls:
 * they copy alias metrics through the worker-injected `loadDerivedMetrics`.
 */

export type McpBucketLike = Pick<RedisTokenBucket, 'take' | 'pauseUntil'>;

export interface McpGithubConfig {
  tokens: readonly string[];
  searchBucket: McpBucketLike;
  /** Pause the search bucket when fewer than this many requests remain. */
  reserve?: number;
}

export interface McpAdapterConfig {
  userAgent: string;
  cursorStore: McpCursorStore;
  npmBucket: McpBucketLike;
  github?: McpGithubConfig;
  maxRegistryItems?: number;
  maxFallbackItems?: number;
}

export const createRedisMcpCursor = createRedisMcpCursorStore;

export function createMcpAdapter(config: McpAdapterConfig): SourceAdapter<McpRaw> {
  const maxRegistryItems = config.maxRegistryItems ?? MCP_DISCOVERY_MAX_ITEMS;
  const maxFallbackItems = config.maxFallbackItems ?? MCP_FALLBACK_MAX_ITEMS;
  const githubReserve = config.github?.reserve ?? 2;
  let tokenCursor = 0;

  async function requestRegistry(
    ctx: AdapterContext,
    base: string,
    query: { cursor: string | null; updatedSince: Date | null },
  ) {
    return fetchJson({
      url: mcpServersUrl(base, {
        cursor: query.cursor,
        updatedSince: query.updatedSince,
        includeDeleted: true,
      }),
      schema: McpRegistryListSchema,
      bucket: ctx.bucket,
      source: 'mcp',
      endpoint: 'registry.servers',
      userAgent: config.userAgent,
      ...(ctx.metrics === undefined ? {} : { metrics: ctx.metrics }),
      signal: ctx.signal,
    });
  }

  async function* discoverRegistry(
    ctx: AdapterContext,
    maxItems: number,
    full: boolean,
  ): AsyncGenerator<DiscoveredRef[]> {
    const cap = Math.max(0, maxItems);
    if (cap === 0) return;

    const cursor = full ? null : await config.cursorStore.get();
    let base: string | null = null;
    let nextCursor: string | null = null;
    let maxUpdated: Date | null = null;
    let yielded = 0;
    let complete = false;
    let warnedSchema = false;
    const seen = new Set<string>();

    for (let page = 0; page < MCP_DISCOVERY_MAX_PAGES && yielded < cap; page += 1) {
      let result = await requestRegistry(ctx, base ?? MCP_REGISTRY_BASE_V01, {
        cursor: nextCursor,
        updatedSince: cursor,
      });
      if (base === null && result.status === 'not_found') {
        ctx.logger.warn('MCP registry v0.1 missing — falling back to v0');
        base = MCP_REGISTRY_BASE_V0;
        result = await requestRegistry(ctx, base, {
          cursor: nextCursor,
          updatedSince: cursor,
        });
      }
      if (result.status === 'not_found') {
        throw new UpstreamError(
          'MCP registry list endpoint returned 404 on both v0.1 and v0',
          'mcp',
          404,
          null,
          false,
        );
      }
      if (result.status === 'not_modified') return;
      base ??= MCP_REGISTRY_BASE_V01;

      const entries = result.data.servers ?? [];
      const refs: DiscoveredRef[] = [];
      for (const entry of entries) {
        const externalId = entry.server.name.trim();
        if (externalId === '' || seen.has(externalId)) continue;
        seen.add(externalId);
        if (
          !warnedSchema &&
          entry.server.$schema &&
          entry.server.$schema !== MCP_SERVER_SCHEMA_URL
        ) {
          warnedSchema = true;
          ctx.logger.warn(
            { observed: entry.server.$schema, expected: MCP_SERVER_SCHEMA_URL },
            'MCP registry schema version changed — normalization continues defensively',
          );
        }
        const updatedAt = dateOrNull(
          entry._meta['io.modelcontextprotocol.registry/official'].updatedAt,
        );
        if (updatedAt !== null && (maxUpdated === null || updatedAt > maxUpdated)) {
          maxUpdated = updatedAt;
        }
        refs.push({
          source: 'mcp',
          kind: 'mcp_server',
          externalId,
          hint: { reason: full ? 'registry-full' : 'registry-incremental' },
          raw: { kind: 'registry', entry },
        });
      }

      if (refs.length > 0) {
        const slice = refs.slice(0, Math.max(0, cap - yielded));
        if (slice.length > 0) {
          yielded += slice.length;
          yield slice;
        }
      }

      const metadataNext = result.data.metadata?.nextCursor ?? null;
      complete = metadataNext === null || metadataNext === '' || entries.length === 0;
      if (complete) break;
      nextCursor = metadataNext;
    }

    if (complete) {
      if (
        maxUpdated !== null &&
        (full || cursor === null || maxUpdated.getTime() > cursor.getTime())
      ) {
        await config.cursorStore.set(maxUpdated);
      }
    } else {
      ctx.logger.warn(
        { yielded, cap },
        'MCP registry pass reached its bound before the last page — cursor left unchanged',
      );
    }
  }

  async function requestGitHubPage(
    ctx: AdapterContext,
    query: string,
    page: number,
    tokens: readonly string[],
    bucket: McpBucketLike,
  ) {
    if (tokens.length === 0) return null;
    const tokenIndex = tokenCursor % tokens.length;
    tokenCursor += 1;
    const token = tokens[tokenIndex];
    if (token === undefined) return null;
    return fetchJson({
      url: mcpGitHubSearchUrl(query, page),
      schema: GitHubSearchResponseSchema,
      bucket,
      source: 'mcp',
      endpoint: 'github.search',
      userAgent: config.userAgent,
      headers: { authorization: `Bearer ${token}` },
      ...(ctx.metrics === undefined ? {} : { metrics: ctx.metrics }),
      signal: ctx.signal,
      onHeaders: async (headers) => {
        const remaining = Number(headers.get('x-ratelimit-remaining') ?? Number.NaN);
        const resetEpoch = Number(headers.get('x-ratelimit-reset') ?? Number.NaN);
        const resetAt =
          Number.isFinite(resetEpoch) && resetEpoch > 0 ? new Date(resetEpoch * 1000) : null;
        if (Number.isFinite(remaining)) {
          ctx.onRateLimit?.({
            resource: headers.get('x-ratelimit-resource') ?? 'search',
            remaining,
            resetAt,
          });
          if (remaining < githubReserve && resetAt !== null && resetAt.getTime() > Date.now()) {
            await bucket.pauseUntil(resetAt.getTime());
          }
        }
        const expiry = headers.get('github-authentication-token-expiration');
        if (expiry !== null) {
          const expiresAt = new Date(expiry);
          if (!Number.isNaN(expiresAt.getTime())) ctx.onTokenExpiry?.({ tokenIndex, expiresAt });
        }
      },
    });
  }

  async function* discoverFallback(
    ctx: AdapterContext,
    maxItems: number,
  ): AsyncGenerator<DiscoveredRef[]> {
    const cap = Math.max(0, Math.min(maxItems, maxFallbackItems));
    if (cap === 0) return;
    const refs: DiscoveredRef[] = [];
    const seen = new Set<string>();
    const github = config.github;

    if (github === undefined || github.tokens.length === 0) {
      ctx.logger.warn(
        'MCP GitHub-topic discovery skipped — no GITHUB_TOKENS configured; npm keywords still run',
      );
    } else {
      for (const query of MCP_GITHUB_QUERIES) {
        if (refs.length >= cap) break;
        const pages = Math.min(MCP_GITHUB_MAX_PAGES, Math.ceil((cap - refs.length) / 100));
        for (let page = 1; page <= pages && refs.length < cap; page += 1) {
          const result = await requestGitHubPage(
            ctx,
            query,
            page,
            github.tokens,
            github.searchBucket,
          );
          if (result === null) break;
          if (result.status === 'not_found') {
            throw new UpstreamError(
              'GitHub MCP fallback search returned 404',
              'mcp',
              404,
              null,
              false,
            );
          }
          if (result.status === 'not_modified') continue;
          for (const repo of result.data.items) {
            if (repo.stargazers_count < MCP_GITHUB_MIN_STARS) continue;
            let externalId: string;
            try {
              externalId = mcpGitHubFallback(repo.full_name);
            } catch {
              continue;
            }
            if (seen.has(externalId)) continue;
            seen.add(externalId);
            refs.push({
              source: 'mcp',
              kind: 'mcp_server',
              externalId,
              hint: { reason: 'github-topic', query },
              raw: { kind: 'github', repo, query },
            });
            if (refs.length >= cap) break;
          }
          if (result.data.items.length < 100) break;
        }
      }
    }

    for (const keyword of MCP_NPM_KEYWORDS) {
      if (refs.length >= cap) break;
      for (let page = 0; page < MCP_NPM_MAX_PAGES && refs.length < cap; page += 1) {
        const result = await fetchJson({
          url: mcpNpmSearchUrl(keyword, page * MCP_NPM_PAGE_SIZE),
          schema: NpmSearchResponseSchema,
          bucket: config.npmBucket,
          source: 'mcp',
          endpoint: 'npm.search',
          userAgent: config.userAgent,
          ...(ctx.metrics === undefined ? {} : { metrics: ctx.metrics }),
          signal: ctx.signal,
        });
        if (result.status === 'not_found') {
          throw new UpstreamError('npm MCP fallback search returned 404', 'mcp', 404, null, false);
        }
        if (result.status === 'not_modified') break;
        for (const item of result.data.objects) {
          const weekly = item.downloads?.weekly ?? 0;
          if (weekly < MCP_NPM_MIN_WEEKLY_DOWNLOADS) continue;
          let externalId: string;
          try {
            externalId = mcpNpmFallback(item.package.name);
          } catch {
            continue;
          }
          if (seen.has(externalId)) continue;
          seen.add(externalId);
          refs.push({
            source: 'mcp',
            kind: 'mcp_server',
            externalId,
            hint: { reason: 'npm-keyword', query: keyword },
            raw: { kind: 'npm', result: item, keyword },
          });
          if (refs.length >= cap) break;
        }
        if (result.data.objects.length < 250) break;
      }
    }

    const filtered = await filterLinked(ctx, refs);
    for (let offset = 0; offset < filtered.length; offset += 100) {
      yield filtered.slice(offset, offset + 100);
    }
  }

  async function filterLinked(
    ctx: AdapterContext,
    refs: readonly DiscoveredRef[],
  ): Promise<DiscoveredRef[]> {
    if (ctx.filterLinkedAliasTargets === undefined || refs.length === 0) return [...refs];
    const targets: AliasTargetKey[] = [];
    for (const ref of refs) {
      const raw = ref.raw as McpRaw | undefined;
      if (raw?.kind === 'github') {
        try {
          targets.push({ source: 'github', externalId: normalizeGitHubRepo(raw.repo.full_name) });
        } catch {
          // Invalid names were already skipped during normalization later.
        }
      } else if (raw?.kind === 'npm') {
        targets.push({ source: 'npm', externalId: normalizeNpmPackage(raw.result.package.name) });
      }
    }
    if (targets.length === 0) return [...refs];
    const linked = await ctx.filterLinkedAliasTargets(targets);
    return refs.filter((ref) => {
      const raw = ref.raw as McpRaw | undefined;
      if (raw?.kind === 'github') {
        try {
          return !linked.has(`github:${normalizeGitHubRepo(raw.repo.full_name)}`);
        } catch {
          return true;
        }
      }
      if (raw?.kind === 'npm') {
        return !linked.has(`npm:${normalizeNpmPackage(raw.result.package.name)}`);
      }
      return true;
    });
  }

  return {
    source: 'mcp',
    kinds: ['mcp_server'],
    batchSize: 200,

    async *discover(ctx, opts) {
      const maxItems = Math.max(0, opts.maxItems);
      switch (opts.strategy ?? 'registry') {
        case 'registry':
          yield* discoverRegistry(ctx, Math.min(maxItems, maxRegistryItems), false);
          return;
        case 'full':
          yield* discoverRegistry(ctx, Math.min(maxItems, maxRegistryItems), true);
          return;
        case 'github-npm':
          yield* discoverFallback(ctx, maxItems);
          return;
        default:
          throw new Error(`unknown MCP discovery strategy "${opts.strategy}"`);
      }
    },

    async fetchMetrics(ctx, refs): Promise<FetchedItem<McpRaw>[]> {
      const derived: Map<string, DerivedMetrics> =
        ctx.loadDerivedMetrics === undefined
          ? new Map<string, DerivedMetrics>()
          : await ctx.loadDerivedMetrics(refs);
      return refs.map((ref) => ({
        ref,
        raw: {
          kind: 'derived',
          metrics: derived.get(ref.externalId) ?? { latest: {}, daily: [] },
        },
        fetchedAt: ctx.now(),
      }));
    },

    normalize: normalizeMcpItem,

    async backfill(ctx, ref, days): Promise<NormalizedItem['daily']> {
      if (ctx.loadDerivedMetrics === undefined) return [];
      const derived = await ctx.loadDerivedMetrics([ref], { days });
      return derived.get(ref.externalId)?.daily ?? [];
    },
  };
}

function dateOrNull(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
