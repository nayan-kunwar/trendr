import {
  fetchJson,
  normalizeNpmPackage,
  normalizeTopicSlugs,
  RedisTokenBucket,
  safeHttpUrl,
  UpstreamError,
  type FetchJsonMetricsSink,
} from '@trendr/core';

import type {
  AdapterContext,
  DiscoveredRef,
  FetchedItem,
  NormalizedItem,
  SourceAdapter,
} from '../adapter.js';
import {
  NPM_BACKFILL_DAYS,
  NPM_BULK_MAX,
  NPM_SEARCH_MAX_FROM,
  NPM_SEARCH_PAGE_SIZE,
  addDays,
  bulkRangeUrl,
  chunkNpmNames,
  isScopedNpmName,
  lastDayPointUrl,
  missingDailyBucket,
  npmWindowEndingAt,
  packumentUrl,
  parseGitHubRepositoryUrl,
  repositoryUrl,
  searchUrl,
  singleRangeUrl,
} from './downloads.js';
import {
  NpmBulkDownloadsSchema,
  NpmDownloadsRangeSchema,
  NpmPackumentSchema,
  NpmPointSchema,
  NpmSearchResponseSchema,
  type NpmDownloadsRange,
  type NpmPackument,
  type NpmSearchResult,
  type NpmVersion,
} from './schemas.js';

/**
 * Spec §7.3.2 — the npm adapter: keyword discovery through the registry
 * search API, daily download series from `api.npmjs.org` (bulk ≤ 128
 * unscoped, one request per scoped package), 60-day backfill and
 * `repository` → GitHub `package_of` aliases.
 */

const DAY_MS = 86_400_000;
const DEFAULT_MIN_WEEKLY_DOWNLOADS = 200;
const DEFAULT_BACKFILL_DAYS = NPM_BACKFILL_DAYS;
/** Long-lived package whose `last-day` is the public availability watermark. */
const DEFAULT_WATERMARK_PACKAGE = 'react';
/** Re-probe the watermark at most this often (the value changes once a day). */
const WATERMARK_CACHE_MS = 10 * 60_000;

/** Spec §7.3.2 discovery keywords. */
export const NPM_KEYWORDS = [
  'mcp',
  'mcp-server',
  'modelcontextprotocol',
  'ai',
  'llm',
  'agent',
  'ai-agent',
  'openai',
  'anthropic',
  'langchain',
  'rag',
  'embeddings',
  'vector-database',
  'cli',
  'typescript',
  'react',
  'nextjs',
  'vite',
  'bun',
] as const;

/** The bucket surface the adapter needs (fetchJson's own bucket option). */
export type NpmBucketLike = Pick<RedisTokenBucket, 'take' | 'pauseUntil'>;

export interface NpmAdapterConfig {
  /** `HTTP_USER_AGENT`. */
  userAgent: string;
  /** `NPM_MIN_WEEKLY_DOWNLOADS` (spec §7.3.2 admission filter). */
  minWeeklyDownloads?: number;
  /** `rl:npm:downloads` — separate from the registry bucket in `ctx.bucket`. */
  downloadsBucket: NpmBucketLike;
  /** `range/{D-N}:{D}` backfill bound; spec §7.3.2 fixes it at 60. */
  backfillDays?: number;
  /** Package whose `last-day` point defines D (defaults to `react`). */
  watermarkPackage?: string;
}

/** Upstream payloads that all flow into one pure `normalize` (spec §5.1). */
export type NpmRaw =
  | { kind: 'search'; result: NpmSearchResult }
  | { kind: 'packument'; packument: NpmPackument | null }
  | { kind: 'downloads'; range: NpmDownloadsRange | null; day: string };

export function packageUrl(externalId: string): string {
  return `https://www.npmjs.com/package/${externalId}`;
}

/**
 * Spec §7.3.2 discovery rotation: the adapter is stateless across runs, so a
 * deterministic 6-hour slot offset gives every keyword a turn at the front of
 * the `maxItems` budget instead of starving all but the first few.
 */
export function rotatedNpmKeywords(now: Date): readonly string[] {
  const slot = Math.floor(now.getTime() / (6 * 3_600_000));
  const offset = ((slot % NPM_KEYWORDS.length) + NPM_KEYWORDS.length) % NPM_KEYWORDS.length;
  return [...NPM_KEYWORDS.slice(offset), ...NPM_KEYWORDS.slice(0, offset)];
}

function sinkOptions(ctx: AdapterContext): { metrics?: FetchJsonMetricsSink } {
  return ctx.metrics === undefined ? {} : { metrics: ctx.metrics };
}

function cleanString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function licenseString(value: NpmPackument['license']): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return cleanString(value);
  return cleanString(value.type) ?? cleanString(value.url);
}

function hasTypeScriptMarker(
  version: NpmVersion | undefined,
  keywords: readonly string[],
): boolean {
  if (version?.types !== undefined || version?.typings !== undefined) return true;
  return keywords.some((keyword) => {
    const lowered = keyword.toLowerCase();
    return lowered === 'typescript' || lowered === 'ts';
  });
}

function splitNpmIdentity(externalId: string): { owner: string | null; name: string } {
  const slash = externalId.lastIndexOf('/');
  return slash === -1
    ? { owner: null, name: externalId }
    : { owner: externalId.slice(0, slash), name: externalId.slice(slash + 1) };
}

function metadataRecord(
  entries: Record<string, string | null | undefined>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    const cleaned = cleanString(value);
    if (cleaned !== null) out[key] = cleaned;
  }
  return out;
}

function githubAlias(repository: string | null): NormalizedItem['aliases'] {
  if (repository === null) return [];
  return [
    {
      source: 'github',
      kind: 'repo',
      externalId: repository,
      relation: 'package_of',
      confidence: 0.9,
      evidence: 'npm.repository.url',
    },
  ];
}

function canonicalName(raw: string, fallback: string): string | null {
  try {
    const canonical = normalizeNpmPackage(raw === '' ? fallback : raw);
    return canonical === '' ? null : canonical;
  } catch {
    return null;
  }
}

/** Spec §5.1 `normalize` — pure payload → canonical shape (fixture-tested). */
export function normalizeNpmItem(fetched: FetchedItem<NpmRaw>): NormalizedItem | null {
  if (fetched.notModified === true || fetched.notFound === true) return null;
  const raw = fetched.raw;
  switch (raw.kind) {
    case 'search':
      return normalizeSearch(fetched.ref.externalId, raw.result);
    case 'packument':
      return normalizePackument(fetched.ref.externalId, raw.packument);
    case 'downloads':
      return normalizeDownloads(fetched.ref.externalId, raw.range);
  }
}

function normalizeSearch(refExternalId: string, result: NpmSearchResult): NormalizedItem | null {
  const externalId = canonicalName(result.package.name, refExternalId);
  if (externalId === null) return null;
  const pkg = result.package;
  const keywords = pkg.keywords ?? [];
  const identity = splitNpmIdentity(externalId);
  const repository = parseGitHubRepositoryUrl(repositoryUrl(pkg.links?.repository));

  return {
    item: {
      source: 'npm',
      kind: 'package',
      externalId,
      upstreamId: null,
      name: identity.name,
      displayName: externalId,
      description: cleanString(pkg.description),
      url: packageUrl(externalId),
      homepage: safeHttpUrl(pkg.links?.homepage),
      language: hasTypeScriptMarker(undefined, keywords) ? 'typescript' : 'javascript',
      license: licenseString(pkg.license),
      owner: identity.owner,
      topics: normalizeTopicSlugs(keywords),
      primaryMetric: 'downloads',
      // Search exposes the latest *publish* date, not package creation
      // (`react` is from 2011, its `date` is the latest release). The full
      // packument's `time.created` fills this in on refresh/backfill (§5.6).
      upstreamCreatedAt: null,
      isArchived: false,
      metadata: metadataRecord({
        repository: repositoryUrl(pkg.links?.repository),
        publisher: pkg.publisher?.username,
        version: pkg.version,
      }),
    },
    snapshots: [],
    daily: [],
    aliases: githubAlias(repository),
  };
}

function normalizePackument(
  refExternalId: string,
  packument: NpmPackument | null,
): NormalizedItem | null {
  if (packument === null) return null;
  const externalId = canonicalName(packument.name, refExternalId);
  if (externalId === null) return null;
  const keywords = packument.keywords ?? [];
  const latestTag = packument['dist-tags']?.latest;
  const latest = latestTag === undefined ? undefined : packument.versions?.[latestTag];
  const repositoryRaw = repositoryUrl(packument.repository) ?? repositoryUrl(latest?.repository);
  const repository = parseGitHubRepositoryUrl(repositoryRaw);
  const created = packument.time?.created;
  const createdAt = created === undefined ? null : new Date(created);
  const identity = splitNpmIdentity(externalId);

  return {
    item: {
      source: 'npm',
      kind: 'package',
      externalId,
      upstreamId: null,
      name: identity.name,
      displayName: externalId,
      description: cleanString(packument.description) ?? cleanString(latest?.description),
      url: packageUrl(externalId),
      homepage: safeHttpUrl(packument.homepage),
      language: hasTypeScriptMarker(latest, keywords) ? 'typescript' : 'javascript',
      license: licenseString(packument.license) ?? licenseString(latest?.license),
      owner: identity.owner,
      topics: normalizeTopicSlugs(keywords),
      primaryMetric: 'downloads',
      upstreamCreatedAt:
        createdAt !== null && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
      isArchived: false,
      metadata: metadataRecord({
        repository: repositoryRaw,
        version: latestTag,
      }),
    },
    snapshots: [],
    daily: [],
    aliases: githubAlias(repository),
  };
}

function normalizeDownloads(
  refExternalId: string,
  range: NpmDownloadsRange | null,
): NormalizedItem | null {
  if (range === null) return null;
  const externalId = canonicalName(range.package, refExternalId);
  if (externalId === null) return null;
  const identity = splitNpmIdentity(externalId);

  return {
    item: {
      source: 'npm',
      kind: 'package',
      externalId,
      upstreamId: null,
      name: identity.name,
      displayName: externalId,
      // A downloads payload carries no metadata; the daily persist keeps the
      // existing columns (upsertItems preserveMetadata, §7.1 step 4).
      description: null,
      url: packageUrl(externalId),
      homepage: null,
      language: null,
      license: null,
      owner: identity.owner,
      topics: [],
      primaryMetric: 'downloads',
      upstreamCreatedAt: null,
      isArchived: false,
      metadata: {},
    },
    snapshots: [],
    daily: range.downloads.map((point) => ({
      metric: 'downloads' as const,
      day: point.day,
      value: point.downloads,
    })),
    aliases: [],
  };
}

/** Spec §7.3.2 adapter factory (one per worker process; §3.3). */
export function createNpmAdapter(config: NpmAdapterConfig): SourceAdapter<NpmRaw> {
  const minWeeklyDownloads = config.minWeeklyDownloads ?? DEFAULT_MIN_WEEKLY_DOWNLOADS;
  const backfillDays = Math.max(1, config.backfillDays ?? DEFAULT_BACKFILL_DAYS);
  const watermarkPackage = config.watermarkPackage ?? DEFAULT_WATERMARK_PACKAGE;
  let watermark: { key: number; day: string } | null = null;

  async function requestSearch(
    ctx: AdapterContext,
    keyword: string,
    from: number,
  ): Promise<{ objects: NpmSearchResult[] }> {
    const result = await fetchJson({
      url: searchUrl(keyword, from),
      schema: NpmSearchResponseSchema,
      bucket: ctx.bucket,
      source: 'npm',
      endpoint: 'search.keywords',
      userAgent: config.userAgent,
      ...sinkOptions(ctx),
      signal: ctx.signal,
    });
    if (result.status !== 'ok') {
      throw new UpstreamError(`npm search returned ${result.status}`, 'npm', null, null, false);
    }
    return result.data;
  }

  function admitted(result: NpmSearchResult, now: Date): boolean {
    const weekly = result.downloads?.weekly ?? 0;
    if (weekly >= minWeeklyDownloads) return true;
    const published =
      result.package.date === undefined ? Number.NaN : Date.parse(result.package.date);
    if (!Number.isFinite(published)) return false;
    return now.getTime() - published <= 30 * DAY_MS;
  }

  async function fetchPackuments(
    ctx: AdapterContext,
    refs: readonly DiscoveredRef[],
  ): Promise<FetchedItem<NpmRaw>[]> {
    const out: FetchedItem<NpmRaw>[] = [];
    for (const ref of refs) {
      ctx.signal.throwIfAborted();
      const result = await fetchJson({
        url: packumentUrl(ref.externalId),
        schema: NpmPackumentSchema,
        bucket: ctx.bucket,
        source: 'npm',
        endpoint: 'packument.get',
        userAgent: config.userAgent,
        ...sinkOptions(ctx),
        signal: ctx.signal,
      });
      const fetchedAt = ctx.now();
      if (result.status === 'not_found') {
        out.push({ ref, raw: { kind: 'packument', packument: null }, fetchedAt, notFound: true });
      } else if (result.status === 'not_modified') {
        out.push({
          ref,
          raw: { kind: 'packument', packument: null },
          fetchedAt,
          notModified: true,
        });
      } else {
        out.push({ ref, raw: { kind: 'packument', packument: result.data }, fetchedAt });
      }
    }
    return out;
  }

  async function fetchBulkRange(
    ctx: AdapterContext,
    start: string,
    end: string,
    names: readonly string[],
  ): Promise<Record<string, NpmDownloadsRange | null>> {
    const result = await fetchJson({
      url: bulkRangeUrl(start, end, names),
      schema: NpmBulkDownloadsSchema,
      bucket: config.downloadsBucket,
      source: 'npm',
      endpoint: 'downloads.range.bulk',
      userAgent: config.userAgent,
      ...sinkOptions(ctx),
      signal: ctx.signal,
    });
    if (result.status !== 'ok') {
      throw new UpstreamError(
        `npm bulk downloads returned ${result.status}`,
        'npm',
        null,
        null,
        false,
      );
    }
    return result.data;
  }

  async function fetchSingleRange(
    ctx: AdapterContext,
    start: string,
    end: string,
    name: string,
    endpoint: string,
  ): Promise<NpmDownloadsRange | null> {
    const result = await fetchJson({
      url: singleRangeUrl(start, end, name),
      schema: NpmDownloadsRangeSchema,
      bucket: config.downloadsBucket,
      source: 'npm',
      endpoint,
      userAgent: config.userAgent,
      ...sinkOptions(ctx),
      signal: ctx.signal,
    });
    if (result.status === 'not_found') return null;
    if (result.status !== 'ok') {
      throw new UpstreamError(`npm downloads returned ${result.status}`, 'npm', null, null, false);
    }
    return result.data;
  }

  /**
   * The last day npm has actually computed (spec §7.3.2: "`last-day` is the
   * last available day"). Ranges echo the requested end and put `0` in a day
   * that has not landed; anchoring on this probe avoids persisting that zero
   * as a real data point. Cached briefly because every 128-item chunk calls
   * `fetchMetrics` and the watermark only moves once a day.
   */
  async function lastAvailableDay(ctx: AdapterContext): Promise<string> {
    const key = Math.floor(ctx.now().getTime() / WATERMARK_CACHE_MS);
    if (watermark !== null && watermark.key === key) return watermark.day;
    const result = await fetchJson({
      url: lastDayPointUrl(watermarkPackage),
      schema: NpmPointSchema,
      bucket: config.downloadsBucket,
      source: 'npm',
      endpoint: 'downloads.point.last-day',
      userAgent: config.userAgent,
      ...sinkOptions(ctx),
      signal: ctx.signal,
    });
    if (result.status !== 'ok') {
      throw new UpstreamError(`npm last-day returned ${result.status}`, 'npm', null, null, false);
    }
    watermark = { key, day: result.data.end };
    return result.data.end;
  }

  async function fetchDailyDownloads(
    ctx: AdapterContext,
    refs: readonly DiscoveredRef[],
  ): Promise<FetchedItem<NpmRaw>[]> {
    const window = npmWindowEndingAt(await lastAvailableDay(ctx));
    const ranges = new Map<string, NpmDownloadsRange | null>();
    const unscoped: string[] = [];
    const scoped: string[] = [];
    for (const ref of refs) {
      const name = normalizeNpmPackage(ref.externalId);
      if (isScopedNpmName(name)) scoped.push(name);
      else unscoped.push(name);
    }

    for (const chunk of chunkNpmNames(unscoped, NPM_BULK_MAX)) {
      ctx.signal.throwIfAborted();
      const response = await fetchBulkRange(ctx, window.start, window.end, chunk);
      for (const name of chunk) ranges.set(name, response[name] ?? null);
    }
    for (const name of scoped) {
      ctx.signal.throwIfAborted();
      ranges.set(
        name,
        await fetchSingleRange(ctx, window.start, window.end, name, 'downloads.range.single'),
      );
    }

    const fetchedAt = ctx.now();
    return refs.map((ref) => {
      const name = normalizeNpmPackage(ref.externalId);
      const range = ranges.get(name) ?? null;
      if (range === null) {
        return {
          ref,
          raw: { kind: 'downloads' as const, range: null, day: window.end },
          fetchedAt,
          notFound: true,
        };
      }
      return {
        ref,
        raw: { kind: 'downloads' as const, range, day: window.end },
        fetchedAt,
        ...(missingDailyBucket(range, window.end) ? { dailyIncomplete: true } : {}),
      };
    });
  }

  return {
    source: 'npm',
    kinds: ['package'],
    /** Spec §7.3.2: bulk downloads accept ≤ 128 packages per request. */
    batchSize: NPM_BULK_MAX,

    async *discover(ctx, opts) {
      const limit = Math.max(1, opts.maxItems);
      const seen = new Set<string>();
      const exhausted = new Set<string>();
      const keywords = rotatedNpmKeywords(ctx.now());
      let emitted = 0;

      for (let from = 0; from <= NPM_SEARCH_MAX_FROM; from += NPM_SEARCH_PAGE_SIZE) {
        for (const keyword of keywords) {
          if (emitted >= limit) return;
          if (exhausted.has(keyword)) continue;
          ctx.signal.throwIfAborted();
          const response = await requestSearch(ctx, keyword, from);
          if (response.objects.length < NPM_SEARCH_PAGE_SIZE) exhausted.add(keyword);

          const refs: DiscoveredRef[] = [];
          for (const [index, result] of response.objects.entries()) {
            let externalId: string;
            try {
              externalId = normalizeNpmPackage(result.package.name);
            } catch {
              continue;
            }
            if (externalId === '' || seen.has(externalId)) continue;
            seen.add(externalId);
            if (!admitted(result, ctx.now())) continue;
            refs.push({
              source: 'npm',
              kind: 'package',
              externalId,
              hint: { reason: 'keywords', query: keyword, rank: from + index },
              raw: { kind: 'search', result } satisfies NpmRaw,
            });
          }

          if (refs.length > 0) {
            const slice = refs.slice(0, limit - emitted);
            emitted += slice.length;
            yield slice;
          }
        }
        if (exhausted.size === keywords.length) return;
      }
    },

    async fetchMetrics(ctx, refs, opts) {
      if (refs.length === 0) return [];
      if ((opts.mode ?? 'snapshot') === 'daily') {
        return fetchDailyDownloads(ctx, refs);
      }
      return fetchPackuments(ctx, refs);
    },

    normalize: normalizeNpmItem,

    /** Spec §7.3.2: `range/{D-60}:{D}` (one request, scoped names encoded). */
    async backfill(ctx, ref, days) {
      const windowDays = Math.min(Math.max(1, days), backfillDays);
      const end = await lastAvailableDay(ctx);
      const start = addDays(end, -windowDays);
      const range = await fetchSingleRange(
        ctx,
        start,
        end,
        ref.externalId,
        'downloads.range.backfill',
      );
      if (range === null) {
        throw new UpstreamError(
          `npm backfill returned 404 for ${ref.externalId}`,
          'npm',
          null,
          null,
          false,
        );
      }
      return range.downloads.map((point) => ({
        metric: 'downloads' as const,
        day: point.day,
        value: point.downloads,
      }));
    },
  };
}
