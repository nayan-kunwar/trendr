import {
  fetchJson,
  UpstreamError,
  type HuggingFaceRepoKind,
  type RedisTokenBucket,
} from '@trendr/core';

import type { AdapterContext, DiscoveredRef, FetchedItem, SourceAdapter } from '../adapter.js';
import { normalizeHuggingFaceItem, type HfRaw } from './normalize.js';
import { HfRepoListSchema, HfRepoSchema, type HfRepoPayload } from './schemas.js';
import {
  HF_DISCOVERY_MAX_ITEMS,
  HF_LIKES_PAGES,
  HF_NEWEST_MIN_LIKES,
  HF_NEWEST_PAGES,
  HF_OPTIONAL_PAGES,
  HF_TRENDING_PAGES,
  hfDetailUrl,
  hfListUrl,
  hfNextLink,
  hfRateLimitDelayMs,
  hfRateLimitInfo,
  huggingFaceExternalId,
  parseHuggingFaceExternalId,
} from './urls.js';

/**
 * Spec §7.3.4 — Hugging Face Hub adapter. Discovery pages are full snapshots
 * (list payloads already carry likes/downloads/trendingScore), while the
 * hourly snapshot job uses a one-hour in-process coverage cache to avoid a
 * detail call for items that just appeared in a list page. Everything not
 * covered by the cache gets one `/api/{kind}/{repo_id}` call (batchSize 1).
 */

/** The bucket surface the adapter needs (fetchJson's own bucket option). */
export type HuggingFaceBucketLike = Pick<RedisTokenBucket, 'take' | 'pauseUntil'>;

export interface HuggingFaceAdapterConfig {
  /** `HTTP_USER_AGENT`. */
  userAgent: string;
  /** `HF_TOKEN`; optional for anonymous access. Never logged. */
  token?: string;
  /** `HF_INCLUDE_DATASETS`. */
  includeDatasets?: boolean;
  /** `HF_INCLUDE_SPACES`. */
  includeSpaces?: boolean;
  /** Page-count overrides for tests/ops (defaults are the §7.3.4 values). */
  trendingPages?: number;
  newestPages?: number;
  likesPages?: number;
  optionalPages?: number;
}

const HOUR_MS = 3_600_000;
const LIST_LIMIT = 100;

interface ListPage {
  repos: HfRepoPayload[];
  next: string | null;
}

interface ListPhase {
  kind: HuggingFaceRepoKind;
  sort: string;
  pages: number;
  reason: string;
  /** Applied before dedupe/emission (newest models require `likes ≥ 5`). */
  accept?: (repo: HfRepoPayload) => boolean;
}

function sinkOptions(ctx: AdapterContext): {
  metrics?: NonNullable<AdapterContext['metrics']>;
} {
  return ctx.metrics === undefined ? {} : { metrics: ctx.metrics };
}

function authHeaders(token: string | undefined): Record<string, string> {
  const trimmed = token?.trim() ?? '';
  return trimmed === '' ? {} : { authorization: `Bearer ${trimmed}` };
}

function rateLimitHook(ctx: AdapterContext): (headers: Headers) => void {
  return (headers) => {
    const info = hfRateLimitInfo(headers, ctx.now());
    if (info !== null) ctx.onRateLimit?.(info);
  };
}

function positivePages(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Math.max(0, Math.floor(value));
}

export function createHuggingFaceAdapter(config: HuggingFaceAdapterConfig): SourceAdapter<HfRaw> {
  const headers = authHeaders(config.token);
  const includeDatasets = config.includeDatasets ?? false;
  const includeSpaces = config.includeSpaces ?? false;
  const trendingPages = positivePages(config.trendingPages, HF_TRENDING_PAGES);
  const newestPages = positivePages(config.newestPages, HF_NEWEST_PAGES);
  const likesPages = positivePages(config.likesPages, HF_LIKES_PAGES);
  const optionalPages = positivePages(config.optionalPages, HF_OPTIONAL_PAGES);

  /**
   * The list pages that covered this hour's snapshot window. A worker restart
   * between discovery and snapshot empties the cache and falls back to detail
   * calls, which is correct (just one extra request per item).
   */
  let cacheHour = -1;
  const listCache = new Map<string, HfRaw>();

  function cacheFor(now: Date): Map<string, HfRaw> {
    const hour = Math.floor(now.getTime() / HOUR_MS);
    if (hour !== cacheHour) {
      listCache.clear();
      cacheHour = hour;
    }
    return listCache;
  }

  async function fetchListPage(
    ctx: AdapterContext,
    kind: HuggingFaceRepoKind,
    url: string,
  ): Promise<ListPage> {
    const result = await fetchJson({
      url,
      schema: HfRepoListSchema,
      bucket: ctx.bucket,
      source: 'huggingface',
      endpoint: `list.${kind}s`,
      userAgent: config.userAgent,
      headers,
      onHeaders: rateLimitHook(ctx),
      rateLimitDelayMs: hfRateLimitDelayMs,
      ...sinkOptions(ctx),
      signal: ctx.signal,
    });
    if (result.status !== 'ok') {
      throw new UpstreamError(
        `huggingface ${kind} list returned ${result.status}`,
        'huggingface',
        null,
        null,
        false,
      );
    }
    return { repos: result.data, next: hfNextLink(result.headers) };
  }

  async function* listPages(
    ctx: AdapterContext,
    phase: ListPhase,
  ): AsyncGenerator<{ page: number; repos: HfRepoPayload[] }> {
    let url = hfListUrl(phase.kind, phase.sort, LIST_LIMIT);
    const seenUrls = new Set<string>();
    for (let page = 0; page < phase.pages; page += 1) {
      ctx.signal.throwIfAborted();
      if (seenUrls.has(url)) return;
      seenUrls.add(url);
      const response = await fetchListPage(ctx, phase.kind, url);
      yield { page, repos: response.repos };
      if (response.next === null) return;
      url = response.next;
    }
  }

  function refsForPage(
    repos: readonly HfRepoPayload[],
    phase: ListPhase,
    page: number,
    seen: Set<string>,
  ): DiscoveredRef[] {
    const refs: DiscoveredRef[] = [];
    for (const [index, repo] of repos.entries()) {
      if (phase.accept !== undefined && !phase.accept(repo)) continue;
      const repoId = repo.id.trim();
      if (repoId === '') continue;
      const externalId = huggingFaceExternalId(phase.kind, repoId);
      if (seen.has(externalId)) continue;
      seen.add(externalId);
      refs.push({
        source: 'huggingface',
        kind: phase.kind,
        externalId,
        hint: {
          reason: phase.reason,
          query: `sort=${phase.sort}`,
          rank: page * LIST_LIMIT + index,
        },
        raw: { kind: 'list', repo } satisfies HfRaw,
      });
    }
    return refs;
  }

  async function fetchDetail(
    ctx: AdapterContext,
    ref: DiscoveredRef,
    parsed: { kind: HuggingFaceRepoKind; repoId: string },
  ): Promise<FetchedItem<HfRaw>> {
    const result = await fetchJson({
      url: hfDetailUrl(parsed.kind, parsed.repoId),
      schema: HfRepoSchema,
      bucket: ctx.bucket,
      source: 'huggingface',
      endpoint: `detail.${parsed.kind}`,
      userAgent: config.userAgent,
      headers,
      onHeaders: rateLimitHook(ctx),
      rateLimitDelayMs: hfRateLimitDelayMs,
      ...sinkOptions(ctx),
      signal: ctx.signal,
    });
    const fetchedAt = ctx.now();
    if (result.status === 'not_found') {
      return { ref, raw: { kind: 'detail', repo: null }, fetchedAt, notFound: true };
    }
    if (result.status === 'not_modified') {
      return { ref, raw: { kind: 'detail', repo: null }, fetchedAt, notModified: true };
    }
    return { ref, raw: { kind: 'detail', repo: result.data }, fetchedAt };
  }

  return {
    source: 'huggingface',
    kinds: ['model', 'dataset', 'space'],
    /** Spec §7.3.4: one detail call per item. */
    batchSize: 1,

    async *discover(ctx, opts) {
      const limit = Math.max(1, opts.maxItems);
      const seen = new Set<string>();
      const cache = cacheFor(ctx.now());
      let emitted = 0;

      const strategy = opts.strategy ?? 'trending';
      const phases: ListPhase[] =
        strategy === 'likes'
          ? [
              {
                kind: 'model',
                sort: 'likes',
                pages: likesPages,
                reason: 'likes',
              },
            ]
          : strategy === 'newest'
            ? [
                {
                  kind: 'model',
                  sort: 'createdAt',
                  pages: newestPages,
                  reason: 'newest',
                  accept: (repo) => (repo.likes ?? 0) >= HF_NEWEST_MIN_LIKES,
                },
              ]
            : strategy === 'trending'
              ? [
                  {
                    kind: 'model',
                    sort: 'trendingScore',
                    pages: trendingPages,
                    reason: 'trending',
                  },
                  {
                    kind: 'model',
                    sort: 'createdAt',
                    pages: newestPages,
                    reason: 'newest',
                    accept: (repo) => (repo.likes ?? 0) >= HF_NEWEST_MIN_LIKES,
                  },
                  ...(includeDatasets
                    ? [
                        {
                          kind: 'dataset' as const,
                          sort: 'trendingScore',
                          pages: optionalPages,
                          reason: 'dataset-trending',
                        },
                      ]
                    : []),
                  ...(includeSpaces
                    ? [
                        {
                          kind: 'space' as const,
                          sort: 'trendingScore',
                          pages: optionalPages,
                          reason: 'space-trending',
                        },
                      ]
                    : []),
                ]
              : [];

      if (phases.length === 0) {
        throw new UpstreamError(
          `unsupported huggingface discovery strategy "${strategy}"`,
          'huggingface',
          null,
          null,
          false,
        );
      }

      for (const phase of phases) {
        for await (const { page, repos } of listPages(ctx, phase)) {
          const refs = refsForPage(repos, phase, page, seen);
          const slice = refs.slice(0, Math.max(0, limit - emitted));
          for (const ref of slice) {
            if (ref.raw !== undefined) cache.set(ref.externalId, ref.raw as HfRaw);
            emitted += 1;
          }
          if (slice.length > 0) yield slice;
          if (emitted >= limit) return;
        }
      }
    },

    async fetchMetrics(ctx, refs) {
      const out: FetchedItem<HfRaw>[] = [];
      const cache = cacheFor(ctx.now());
      for (const ref of refs) {
        ctx.signal.throwIfAborted();
        const parsed = parseHuggingFaceExternalId(ref.externalId);
        if (parsed === null) {
          out.push({
            ref,
            raw: { kind: 'detail', repo: null },
            fetchedAt: ctx.now(),
            notFound: true,
          });
          continue;
        }
        const cached = cache.get(ref.externalId);
        if (cached?.kind === 'list' && cached.repo.id.trim() === parsed.repoId) {
          out.push({ ref, raw: cached, fetchedAt: ctx.now() });
          continue;
        }
        out.push(await fetchDetail(ctx, ref, parsed));
      }
      return out;
    },

    normalize: normalizeHuggingFaceItem,
  };
}

/** Spec §7.3.4 default discovery budget (5 trending pages + 2 newest pages). */
export const HUGGINGFACE_DISCOVERY_MAX_ITEMS = HF_DISCOVERY_MAX_ITEMS;
