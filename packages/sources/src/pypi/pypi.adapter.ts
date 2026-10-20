import { normalizeTopicSlugs, redisKeys } from '@trendr/core';
import {
  fetchJson,
  UpstreamError,
  type FetchJsonMetricsSink,
  type RedisTokenBucket,
} from '@trendr/core';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import type {
  AdapterContext,
  DiscoveredRef,
  FetchedItem,
  NormalizedItem,
  SourceAdapter,
} from '../adapter.js';
import { parseGitHubRepositoryUrl } from '../npm/downloads.js';
import { parsePypiRss } from './rss.js';
import {
  PypiProjectSchema,
  PypiStatsOverallSchema,
  PypiStatsRecentSchema,
  type PypiProject,
  type PypiRecentData,
  type PypiStatsPoint,
} from './schemas.js';
import {
  canonicalPypiName,
  isStatsIncomplete,
  keepLatestDays,
  lastCompletePypiDay,
  latestDay,
  matchesPypiKeywords,
  overallStatsUrl,
  projectJsonUrl,
  projectPageUrl,
  PYPI_BACKFILL_DAYS,
  PYPI_DAILY_WINDOW_DAYS,
  PYPI_FEEDS,
  pypiNameFromFeedLink,
  pypiNameFromFeedTitle,
  recentStatsUrl,
  windowEndingAt,
} from './urls.js';
import seedPackages from './seed.json' with { type: 'json' };

/**
 * Spec §7.3.3 — the PyPI adapter: RSS newest/updates discovery plus a seed
 * list, project JSON with ETags, pypistats `overall?mirrors=false` daily
 * series/backfill and `project_urls` → GitHub `package_of` aliases.
 */

const DAY_MS = 86_400_000;
const DEFAULT_MIN_WEEKLY_DOWNLOADS = 500;
const SEED_REFRESH_MS = DAY_MS;
const RECENT_CACHE_MS = DAY_MS;
const RECENT_CACHE_MAX = 10_000;
const ETAG_TTL_SECONDS = 7 * 24 * 3_600;
const PAGE_SIZE = 25;
const ADMISSION_WINDOW_MS = 30 * DAY_MS;

/** The bucket surface the adapter needs (fetchJson's own bucket option). */
export type PypiBucketLike = Pick<RedisTokenBucket, 'take' | 'pauseUntil'>;

/** Spec §7.3.3 — the project JSON carries an ETag (cached by the CDN for 900 s). */
export interface PypiEtagStore {
  get(project: string): Promise<string | null>;
  set(project: string, etag: string): Promise<void>;
}

export function createRedisPypiEtagStore(redis: Redis): PypiEtagStore {
  return {
    async get(project) {
      return redis.get(redisKeys.etagPypi(project));
    },
    async set(project, etag) {
      await redis.set(redisKeys.etagPypi(project), etag, 'EX', ETAG_TTL_SECONDS);
    },
  };
}

export interface PypiAdapterConfig {
  /** `HTTP_USER_AGENT`. */
  userAgent: string;
  /** `PYPI_MIN_WEEKLY_DOWNLOADS` (spec §7.3.3 admission filter). */
  minWeeklyDownloads?: number;
  /** `rl:pypi:stats` — separate from the project JSON bucket in `ctx.bucket`. */
  statsBucket: PypiBucketLike;
  /** Redis-backed ETag cache for project JSON; omitted in unit tests. */
  etags?: PypiEtagStore;
  /** The pypistats series is trimmed to this many days on backfill. */
  backfillDays?: number;
  /** Test/ops override for the seeded projects (defaults to `seed.json`). */
  seeds?: readonly string[];
}

/** Upstream payloads that all flow into one pure `normalize` (spec §5.1). */
export type PypiRaw =
  | { kind: 'metadata'; project: PypiProject | null }
  | { kind: 'downloads'; points: PypiStatsPoint[]; latestDay: string | null };

export const SEED_PACKAGES: readonly string[] = Array.isArray(seedPackages) ? seedPackages : [];

const SEED_NAMES: readonly string[] = [
  ...new Set(
    SEED_PACKAGES.map((name) => canonicalPypiName(name)).filter(
      (name): name is string => name !== null,
    ),
  ),
];

function sinkOptions(ctx: AdapterContext): { metrics?: FetchJsonMetricsSink } {
  return ctx.metrics === undefined ? {} : { metrics: ctx.metrics };
}

function cleanString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
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

function firstReleaseAt(project: PypiProject): Date | null {
  let earliest: number | null = null;
  for (const files of Object.values(project.releases ?? {})) {
    for (const file of files) {
      const raw = file.upload_time_iso_8601 ?? file.upload_time;
      if (raw === undefined) continue;
      const time = Date.parse(raw);
      if (!Number.isFinite(time)) continue;
      if (earliest === null || time < earliest) earliest = time;
    }
  }
  return earliest === null ? null : new Date(earliest);
}

function projectUrls(project: PypiProject): string[] {
  const urls: string[] = [];
  for (const value of Object.values(project.info.project_urls ?? {})) {
    if (value === null) continue;
    const trimmed = value.trim();
    if (trimmed !== '') urls.push(trimmed);
  }
  return urls;
}

function githubAliases(project: PypiProject): NormalizedItem['aliases'] {
  const seen = new Set<string>();
  const aliases: NormalizedItem['aliases'] = [];
  for (const raw of projectUrls(project)) {
    const repository = parseGitHubRepositoryUrl(raw);
    if (repository === null || seen.has(repository)) continue;
    seen.add(repository);
    aliases.push({
      source: 'github',
      kind: 'repo',
      externalId: repository,
      relation: 'package_of',
      confidence: 0.9,
      evidence: 'pypi.project_urls',
    });
  }
  return aliases;
}

function homepageFor(project: PypiProject): string | null {
  const home = cleanString(project.info.home_page);
  if (home !== null) return home;
  for (const [key, value] of Object.entries(project.info.project_urls ?? {})) {
    const lowered = key.toLowerCase();
    if ((lowered === 'homepage' || lowered === 'home') && value !== null) {
      const cleaned = cleanString(value);
      if (cleaned !== null) return cleaned;
    }
  }
  return null;
}

function licenseFor(project: PypiProject): string | null {
  const license = cleanString(project.info.license_expression) ?? cleanString(project.info.license);
  if (license === null) return null;
  return license.length > 200 ? license.slice(0, 200) : license;
}

function topicsFor(project: PypiProject): string[] {
  const keywords = (project.info.keywords ?? '')
    .split(',')
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword !== '');
  const classifiers = (project.info.classifiers ?? [])
    .filter((classifier) => classifier.startsWith('Topic ::'))
    .map((classifier) => classifier.split('::').at(-1)?.trim() ?? '')
    .filter((topic) => topic !== '');
  return normalizeTopicSlugs([...keywords, ...classifiers]);
}

function summaryFor(project: PypiProject): string | null {
  const summary = cleanString(project.info.summary);
  if (summary !== null) return summary;
  const description = cleanString(project.info.description);
  if (description === null) return null;
  return description.length > 500 ? description.slice(0, 500) : description;
}

function normalizeMetadata(
  refExternalId: string,
  project: PypiProject | null,
): NormalizedItem | null {
  if (project === null) return null;
  const externalId = canonicalPypiName(project.info.name) ?? canonicalPypiName(refExternalId);
  if (externalId === null) return null;
  const aliases = githubAliases(project);
  const repository = aliases[0]?.externalId ?? null;
  const createdAt = firstReleaseAt(project);

  return {
    item: {
      source: 'pypi',
      kind: 'package',
      externalId,
      upstreamId: null,
      name: externalId,
      displayName: cleanString(project.info.name) ?? externalId,
      description: summaryFor(project),
      url: projectPageUrl(externalId),
      homepage: homepageFor(project),
      language: 'python',
      license: licenseFor(project),
      owner: cleanString(project.info.author) ?? cleanString(project.info.maintainer),
      topics: topicsFor(project),
      primaryMetric: 'downloads',
      upstreamCreatedAt: createdAt,
      isArchived: false,
      metadata: metadataRecord({
        repository,
        version: project.info.version,
        requiresPython: project.info.requires_python,
        author: project.info.author,
      }),
    },
    snapshots: [],
    daily: [],
    aliases,
  };
}

function normalizeDownloads(
  refExternalId: string,
  points: readonly PypiStatsPoint[],
): NormalizedItem | null {
  const externalId = canonicalPypiName(refExternalId);
  if (externalId === null) return null;

  return {
    item: {
      source: 'pypi',
      kind: 'package',
      externalId,
      upstreamId: null,
      name: externalId,
      displayName: externalId,
      // pypistats carries no metadata; the daily persist keeps the columns
      // written by discovery/refresh (`upsertItems` preserveMetadata).
      description: null,
      url: projectPageUrl(externalId),
      homepage: null,
      language: 'python',
      license: null,
      owner: null,
      topics: [],
      primaryMetric: 'downloads',
      upstreamCreatedAt: null,
      isArchived: false,
      metadata: {},
    },
    snapshots: [],
    daily: points.map((point) => ({
      metric: 'downloads' as const,
      day: point.date,
      value: point.downloads,
    })),
    aliases: [],
  };
}

/** Spec §5.1 `normalize` — pure payload → canonical shape (fixture-tested). */
export function normalizePypiItem(fetched: FetchedItem<PypiRaw>): NormalizedItem | null {
  if (fetched.notModified === true || fetched.notFound === true) return null;
  const raw = fetched.raw;
  return raw.kind === 'metadata'
    ? normalizeMetadata(fetched.ref.externalId, raw.project)
    : normalizeDownloads(fetched.ref.externalId, raw.points);
}

/** Spec §7.3.3 adapter factory (one per worker process; §3.3). */
export function createPypiAdapter(config: PypiAdapterConfig): SourceAdapter<PypiRaw> {
  const minWeeklyDownloads = config.minWeeklyDownloads ?? DEFAULT_MIN_WEEKLY_DOWNLOADS;
  const backfillDays = Math.max(1, config.backfillDays ?? PYPI_BACKFILL_DAYS);
  const seedNames =
    config.seeds === undefined
      ? SEED_NAMES
      : [
          ...new Set(
            config.seeds
              .map((name) => canonicalPypiName(name))
              .filter((name): name is string => name !== null),
          ),
        ];
  const recentCache = new Map<string, { at: number; data: PypiRecentData | null }>();
  let nextSeedAt = 0;

  function rememberRecent(name: string, at: Date, data: PypiRecentData | null): void {
    if (recentCache.size >= RECENT_CACHE_MAX) {
      const oldest = recentCache.keys().next().value;
      if (oldest !== undefined) recentCache.delete(oldest);
    }
    recentCache.set(name, { at: at.getTime(), data });
  }

  async function requestRss(ctx: AdapterContext, url: string, endpoint: string): Promise<string> {
    const result = await fetchJson({
      url,
      schema: z.string().min(1),
      responseType: 'text',
      headers: { accept: 'application/rss+xml, application/xml;q=0.9' },
      bucket: ctx.bucket,
      source: 'pypi',
      endpoint,
      userAgent: config.userAgent,
      ...sinkOptions(ctx),
      signal: ctx.signal,
    });
    if (result.status !== 'ok') {
      throw new UpstreamError(`pypi RSS returned ${result.status}`, 'pypi', null, null, false);
    }
    return result.data;
  }

  async function requestProject(ctx: AdapterContext, name: string): Promise<PypiProject | null> {
    const result = await fetchJson({
      url: projectJsonUrl(name),
      schema: PypiProjectSchema,
      bucket: ctx.bucket,
      source: 'pypi',
      endpoint: 'project.get',
      userAgent: config.userAgent,
      ...sinkOptions(ctx),
      signal: ctx.signal,
    });
    if (result.status === 'not_found') return null;
    if (result.status !== 'ok') {
      throw new UpstreamError(`pypi project returned ${result.status}`, 'pypi', null, null, false);
    }
    return result.data;
  }

  async function requestRecent(ctx: AdapterContext, name: string): Promise<PypiRecentData | null> {
    const cached = recentCache.get(name);
    const now = ctx.now();
    if (cached !== undefined && now.getTime() - cached.at < RECENT_CACHE_MS) {
      return cached.data;
    }
    const result = await fetchJson({
      url: recentStatsUrl(name),
      schema: PypiStatsRecentSchema,
      bucket: config.statsBucket,
      source: 'pypi',
      endpoint: 'stats.recent',
      userAgent: config.userAgent,
      ...sinkOptions(ctx),
      signal: ctx.signal,
    });
    if (result.status === 'not_found') {
      rememberRecent(name, now, null);
      return null;
    }
    if (result.status !== 'ok') {
      throw new UpstreamError(
        `pypi recent stats returned ${result.status}`,
        'pypi',
        null,
        null,
        false,
      );
    }
    rememberRecent(name, now, result.data.data);
    return result.data.data;
  }

  async function requestOverall(
    ctx: AdapterContext,
    name: string,
    endpoint: string,
  ): Promise<PypiStatsPoint[]> {
    const result = await fetchJson({
      url: overallStatsUrl(name),
      schema: PypiStatsOverallSchema,
      bucket: config.statsBucket,
      source: 'pypi',
      endpoint,
      userAgent: config.userAgent,
      ...sinkOptions(ctx),
      signal: ctx.signal,
    });
    if (result.status === 'not_found') return [];
    if (result.status !== 'ok') {
      throw new UpstreamError(
        `pypi overall stats returned ${result.status}`,
        'pypi',
        null,
        null,
        false,
      );
    }
    return result.data.data
      .filter((point) => point.category === 'without_mirrors')
      .map((point) => ({
        category: point.category,
        date: point.date,
        downloads: point.downloads,
      }))
      .sort((left, right) => left.date.localeCompare(right.date));
  }

  async function fetchMetadata(
    ctx: AdapterContext,
    refs: readonly DiscoveredRef[],
  ): Promise<FetchedItem<PypiRaw>[]> {
    const out: FetchedItem<PypiRaw>[] = [];
    for (const ref of refs) {
      ctx.signal.throwIfAborted();
      const name = canonicalPypiName(ref.externalId);
      const fetchedAt = ctx.now();
      if (name === null) {
        out.push({
          ref,
          raw: { kind: 'metadata', project: null },
          fetchedAt,
          notFound: true,
        });
        continue;
      }
      const etag = config.etags === undefined ? null : await config.etags.get(name);
      const result = await fetchJson({
        url: projectJsonUrl(name),
        schema: PypiProjectSchema,
        bucket: ctx.bucket,
        source: 'pypi',
        endpoint: 'project.get',
        userAgent: config.userAgent,
        etag,
        ...sinkOptions(ctx),
        signal: ctx.signal,
      });
      if (result.status === 'not_modified') {
        out.push({
          ref,
          raw: { kind: 'metadata', project: null },
          fetchedAt,
          notModified: true,
        });
        continue;
      }
      if (result.status === 'not_found') {
        out.push({
          ref,
          raw: { kind: 'metadata', project: null },
          fetchedAt,
          notFound: true,
        });
        continue;
      }
      if (result.etag !== null && config.etags !== undefined) {
        await config.etags.set(name, result.etag);
      }
      out.push({ ref, raw: { kind: 'metadata', project: result.data }, fetchedAt });
    }
    return out;
  }

  async function fetchDaily(
    ctx: AdapterContext,
    refs: readonly DiscoveredRef[],
  ): Promise<FetchedItem<PypiRaw>[]> {
    const expectedDay = lastCompletePypiDay(ctx.now());
    const out: FetchedItem<PypiRaw>[] = [];
    for (const ref of refs) {
      ctx.signal.throwIfAborted();
      const name = canonicalPypiName(ref.externalId);
      const fetchedAt = ctx.now();
      if (name === null) {
        out.push({
          ref,
          raw: { kind: 'downloads', points: [], latestDay: null },
          fetchedAt,
          notFound: true,
        });
        continue;
      }
      const all = await requestOverall(ctx, name, 'stats.overall.daily');
      const latest = latestDay(all);
      const points = latest === null ? [] : windowEndingAt(all, latest, PYPI_DAILY_WINDOW_DAYS);
      out.push({
        ref,
        raw: { kind: 'downloads', points, latestDay: latest },
        fetchedAt,
        ...(isStatsIncomplete(all, expectedDay) ? { dailyIncomplete: true } : {}),
      });
    }
    return out;
  }

  function admitted(project: PypiProject, recent: PypiRecentData | null, now: Date): boolean {
    if (recent !== null && recent.last_week >= minWeeklyDownloads) return true;
    const created = firstReleaseAt(project);
    return created !== null && now.getTime() - created.getTime() <= ADMISSION_WINDOW_MS;
  }

  return {
    source: 'pypi',
    kinds: ['package'],
    /** Spec §5.1: PyPI fetches one project per call. */
    batchSize: 1,

    async *discover(ctx, opts) {
      const limit = Math.max(1, opts.maxItems);
      const now = ctx.now();
      const seedDue = now.getTime() >= nextSeedAt;
      const candidates = new Map<string, NonNullable<DiscoveredRef['hint']>>();
      if (seedDue) {
        for (const [index, name] of seedNames.entries()) {
          candidates.set(name, { reason: 'seed', rank: index });
        }
      }

      for (const feed of [
        { id: 'newest', url: PYPI_FEEDS.newest, endpoint: 'rss.packages' },
        { id: 'updates', url: PYPI_FEEDS.updates, endpoint: 'rss.updates' },
      ]) {
        ctx.signal.throwIfAborted();
        const items = parsePypiRss(await requestRss(ctx, feed.url, feed.endpoint));
        for (const [index, item] of items.entries()) {
          const name = pypiNameFromFeedLink(item.link) ?? pypiNameFromFeedTitle(item.title);
          if (name === null || candidates.has(name)) continue;
          if (!matchesPypiKeywords(name, item.title, item.description)) continue;
          candidates.set(name, { reason: 'rss', query: feed.id, rank: index });
        }
      }

      let attempted = 0;
      let failed = 0;
      let emitted = 0;
      let page: DiscoveredRef[] = [];

      for (const [name, hint] of candidates) {
        if (emitted >= limit) break;
        ctx.signal.throwIfAborted();
        attempted += 1;

        let project: PypiProject | null;
        try {
          project = await requestProject(ctx, name);
        } catch (error) {
          failed += 1;
          ctx.logger.warn({ err: error, externalId: name }, 'pypi discovery metadata failed');
          if (failed * 2 > attempted) throw error;
          continue;
        }
        if (project === null) continue;

        const created = firstReleaseAt(project);
        let recent: PypiRecentData | null = null;
        if (created === null || now.getTime() - created.getTime() > ADMISSION_WINDOW_MS) {
          try {
            recent = await requestRecent(ctx, name);
          } catch (error) {
            failed += 1;
            ctx.logger.warn({ err: error, externalId: name }, 'pypi discovery stats failed');
            if (failed * 2 > attempted) throw error;
            continue;
          }
        }
        if (!admitted(project, recent, now)) continue;

        page.push({
          source: 'pypi',
          kind: 'package',
          externalId: name,
          hint,
          raw: { kind: 'metadata', project },
        });
        emitted += 1;
        if (page.length >= PAGE_SIZE) {
          yield page;
          page = [];
        }
      }
      if (page.length > 0) yield page;
      // Mark the seed sweep complete only after every candidate was processed,
      // so a failed run retries the seeds instead of waiting a day.
      if (seedDue && limit >= seedNames.length) {
        nextSeedAt = now.getTime() + SEED_REFRESH_MS;
      }
    },

    async fetchMetrics(ctx, refs, opts) {
      if (refs.length === 0) return [];
      if ((opts.mode ?? 'snapshot') === 'daily') {
        return fetchDaily(ctx, refs);
      }
      return fetchMetadata(ctx, refs);
    },

    normalize: normalizePypiItem,

    /** Spec §7.3.3: the pypistats series already covers 180 days; keep 60. */
    async backfill(ctx, ref, days) {
      const name = canonicalPypiName(ref.externalId);
      if (name === null) {
        throw new UpstreamError(
          `invalid PyPI project "${ref.externalId}"`,
          'pypi',
          null,
          null,
          false,
        );
      }
      const points = await requestOverall(ctx, name, 'stats.overall.backfill');
      return keepLatestDays(points, Math.min(Math.max(1, days), backfillDays)).map((point) => ({
        metric: 'downloads' as const,
        day: point.date,
        value: point.downloads,
      }));
    },
  };
}
