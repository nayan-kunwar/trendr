import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';
import { z } from 'zod';

import { fetchJson, redisKeys, UpstreamError, type RedisTokenBucket } from '@trendr/core';

import type { AdapterContext, DiscoveredRef, FetchedItem, SourceAdapter } from '../adapter.js';
import { hfRateLimitDelayMs } from '../huggingface/urls.js';
import { parseArxivAtom } from './atom.js';
import { normalizeArxivItem, type ArxivRaw } from './normalize.js';
import { HfDailyPapersSchema, HfPaperSchema, type HfPaper } from './schemas.js';
import {
  ARXIV_DETAIL_BUDGET_PER_HOUR,
  ARXIV_DISCOVERY_DAYS,
  ARXIV_MAX_PAGES,
  ARXIV_PAGE_SIZE,
  HF_DAILY_PAPERS_CACHE_MS,
  HF_DAILY_PAPERS_LIMIT,
  arxivQueryUrl,
  canonicalArxivId,
  hfDailyPapersUrl,
  hfPaperUrl,
  shiftUtcDay,
  utcDay,
} from './urls.js';

/**
 * Spec §7.3.5 — arXiv adapter. Discovery walks the Atom API (one request per
 * 3 s, one connection at a time across workers); the hourly snapshot uses the
 * HF daily-paper feed for today/yesterday and falls back to one paper lookup
 * per tracked paper, charged to the HF bucket.
 */

export type ArxivBucketLike = Pick<RedisTokenBucket, 'take' | 'pauseUntil'>;

/**
 * Cross-worker `lock:arxiv:conn` mutex. `run` must hold the lock for exactly
 * one HTTP request; the adapter never retries inside the lock because the
 * request timeout plus a 3 s bucket wait must fit the 30 s TTL.
 */
export interface ArxivConnectionLock {
  run<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T>;
}

export interface ArxivLockOptions {
  key?: string;
  ttlMs?: number;
  retryMs?: number;
  acquireTimeoutMs?: number;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal.reason);
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(1, ms),
    );
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/**
 * Spec §7.3.5 — Redis `SET NX PX 30000` mutex, shared by every worker. A
 * release only deletes the lock if its random token still matches, so an
 * expired lock cannot be deleted by the previous holder.
 */
export function createRedisArxivConnectionLock(
  redis: Redis,
  options: ArxivLockOptions = {},
): ArxivConnectionLock {
  const key = options.key ?? redisKeys.arxivConnectionLock();
  const ttlMs = Math.max(1_000, options.ttlMs ?? 30_000);
  const retryMs = Math.max(10, options.retryMs ?? 100);
  const acquireTimeoutMs = Math.max(retryMs, options.acquireTimeoutMs ?? 60_000);

  return {
    async run<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
      const token = randomUUID();
      const deadline = Date.now() + acquireTimeoutMs;
      for (;;) {
        signal.throwIfAborted();
        const claimed = await redis.set(key, token, 'PX', ttlMs, 'NX');
        if (claimed === 'OK') break;
        if (Date.now() >= deadline) {
          throw new UpstreamError(
            'timed out waiting for the arXiv single-connection lock',
            'arxiv',
            null,
            retryMs,
            true,
          );
        }
        await delay(Math.min(retryMs, Math.max(1, deadline - Date.now())), signal);
      }

      try {
        return await fn();
      } finally {
        try {
          await redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token);
        } catch {
          // The 30 s TTL is the safety net; never mask the request error.
        }
      }
    },
  };
}

/** Process-local fallback used by fixture tests; production passes Redis. */
export function createLocalArxivConnectionLock(): ArxivConnectionLock {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      const next = tail.then(fn, fn);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

export interface ArxivAdapterConfig {
  /** `HTTP_USER_AGENT`. */
  userAgent: string;
  /** Shared `rl:huggingface:api` bucket (spec §7.3.5). */
  hfBucket: ArxivBucketLike;
  /** `HF_TOKEN`; optional, never logged. */
  hfToken?: string;
  /** Production passes the Redis mutex; tests may omit it. */
  connectionLock?: ArxivConnectionLock;
  /** Page size override for tests (default 200, capped at the ToU 2,000). */
  pageSize?: number;
  /** Defensive page cap (default 15). */
  maxPages?: number;
  /** HF daily feed limit (default 100). */
  dailyFeedLimit?: number;
  /** Detail fallback budget per UTC hour (default 300). */
  detailBudgetPerHour?: number;
  /** In-process daily-feed cache lifetime (default one hour). */
  feedCacheTtlMs?: number;
}

const HOUR_MS = 3_600_000;
const MISSING_TTL_MS = 24 * HOUR_MS;
const ARXIV_XML_SCHEMA = z.string().min(1);

function positive(
  value: number | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function authHeaders(token: string | undefined): Record<string, string> {
  const trimmed = token?.trim() ?? '';
  return trimmed === '' ? {} : { authorization: `Bearer ${trimmed}` };
}

function sinkOptions(ctx: AdapterContext): { metrics?: NonNullable<AdapterContext['metrics']> } {
  return ctx.metrics === undefined ? {} : { metrics: ctx.metrics };
}

interface FeedCacheEntry {
  fetchedAt: number;
  papers: Map<string, HfPaper>;
}

export function createArxivAdapter(config: ArxivAdapterConfig): SourceAdapter<ArxivRaw> {
  const pageSize = positive(config.pageSize, ARXIV_PAGE_SIZE, 2_000);
  const maxPages = positive(config.maxPages, ARXIV_MAX_PAGES);
  const dailyFeedLimit = positive(config.dailyFeedLimit, HF_DAILY_PAPERS_LIMIT);
  const detailBudgetPerHour = Math.max(
    0,
    Math.floor(config.detailBudgetPerHour ?? ARXIV_DETAIL_BUDGET_PER_HOUR),
  );
  const feedCacheTtlMs = Math.max(0, config.feedCacheTtlMs ?? HF_DAILY_PAPERS_CACHE_MS);
  const lock = config.connectionLock ?? createLocalArxivConnectionLock();
  const headers = authHeaders(config.hfToken);

  const feedCache = new Map<string, FeedCacheEntry>();
  /** Papers HF did not know about; avoid spending the fallback budget on 404s. */
  const missingUntil = new Map<string, number>();
  let detailHour = -1;
  let detailCalls = 0;

  function reserveDetailCall(now: Date): boolean {
    const hour = Math.floor(now.getTime() / HOUR_MS);
    if (hour !== detailHour) {
      detailHour = hour;
      detailCalls = 0;
    }
    if (detailCalls >= detailBudgetPerHour) return false;
    detailCalls += 1;
    return true;
  }

  async function fetchDailyPapers(ctx: AdapterContext, day: string): Promise<Map<string, HfPaper>> {
    const cached = feedCache.get(day);
    const fetchedAt = ctx.now().getTime();
    if (cached !== undefined && fetchedAt - cached.fetchedAt < feedCacheTtlMs) {
      return cached.papers;
    }

    const result = await fetchJson({
      url: hfDailyPapersUrl(day, dailyFeedLimit),
      schema: HfDailyPapersSchema,
      bucket: config.hfBucket,
      source: 'huggingface',
      endpoint: 'papers.daily',
      userAgent: config.userAgent,
      headers,
      rateLimitDelayMs: hfRateLimitDelayMs,
      ...sinkOptions(ctx),
      signal: ctx.signal,
    });
    if (result.status !== 'ok') {
      throw new UpstreamError(
        `huggingface daily papers (${day}) returned ${result.status}`,
        'huggingface',
        null,
        null,
        false,
      );
    }

    const papers = new Map<string, HfPaper>();
    for (const entry of result.data) {
      const id = canonicalArxivId(entry.paper.id);
      if (id !== null && !papers.has(id)) papers.set(id, entry.paper);
    }
    feedCache.set(day, { fetchedAt, papers });

    if (feedCache.size > 4) {
      const oldest = [...feedCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0];
      if (oldest !== undefined) feedCache.delete(oldest[0]);
    }
    return papers;
  }

  async function loadDailyFeeds(ctx: AdapterContext): Promise<Map<string, HfPaper>> {
    const now = ctx.now();
    const today = utcDay(now);
    const yesterday = utcDay(shiftUtcDay(now, -1));
    const merged = new Map<string, HfPaper>();
    for (const day of [today, yesterday]) {
      const papers = await fetchDailyPapers(ctx, day);
      for (const [id, paper] of papers) merged.set(id, paper);
    }
    return merged;
  }

  async function fetchPaper(ctx: AdapterContext, id: string): Promise<HfPaper | null> {
    const result = await fetchJson({
      url: hfPaperUrl(id),
      schema: HfPaperSchema,
      bucket: config.hfBucket,
      source: 'huggingface',
      endpoint: 'papers.detail',
      userAgent: config.userAgent,
      headers,
      rateLimitDelayMs: hfRateLimitDelayMs,
      ...sinkOptions(ctx),
      signal: ctx.signal,
    });
    return result.status === 'ok' ? result.data : null;
  }

  async function requestAtom(ctx: AdapterContext, url: string): Promise<string> {
    return lock.run(ctx.signal, async () => {
      const result = await fetchJson({
        url,
        schema: ARXIV_XML_SCHEMA,
        bucket: ctx.bucket,
        source: 'arxiv',
        endpoint: 'api.query',
        userAgent: config.userAgent,
        headers: { accept: 'application/atom+xml, application/xml;q=0.9, text/xml;q=0.8' },
        responseType: 'text',
        // One connection at a time: BullMQ retries the whole job later rather
        // than holding the Redis mutex across an in-process retry window.
        maxAttempts: 1,
        ...sinkOptions(ctx),
        signal: ctx.signal,
      });
      if (result.status !== 'ok') {
        throw new UpstreamError(
          `arXiv query returned ${result.status}`,
          'arxiv',
          null,
          null,
          false,
        );
      }
      return result.data;
    });
  }

  return {
    source: 'arxiv',
    kinds: ['paper'],
    /** Spec §5.1: up to 100 tracked papers per snapshot batch. */
    batchSize: 100,

    async *discover(ctx, opts) {
      const strategy = opts.strategy ?? 'new-listings';
      if (strategy !== 'new-listings') {
        throw new UpstreamError(
          `unsupported arXiv discovery strategy "${strategy}"`,
          'arxiv',
          null,
          null,
          false,
        );
      }

      const limit = Math.max(1, opts.maxItems);
      const cutoff =
        opts.since?.getTime() ?? ctx.now().getTime() - ARXIV_DISCOVERY_DAYS * 86_400_000;
      const seen = new Set<string>();
      let emitted = 0;
      let start = 0;

      for (let page = 0; page < maxPages && emitted < limit; page += 1) {
        ctx.signal.throwIfAborted();
        const xml = await requestAtom(ctx, arxivQueryUrl(start, pageSize));
        const entries = parseArxivAtom(xml);
        if (entries.length === 0) return;

        const refs: DiscoveredRef[] = [];
        let reachedCutoff = false;
        for (const [index, entry] of entries.entries()) {
          if (entry.publishedAt !== null && entry.publishedAt.getTime() < cutoff) {
            reachedCutoff = true;
            break;
          }
          if (seen.has(entry.externalId)) continue;
          seen.add(entry.externalId);
          refs.push({
            source: 'arxiv',
            kind: 'paper',
            externalId: entry.externalId,
            hint: {
              reason: 'new-listings',
              query: 'cat:cs.AI OR cat:cs.CL OR cat:cs.LG OR cat:cs.CV',
              rank: start + index,
            },
            raw: { kind: 'atom', entry } satisfies ArxivRaw,
          });
        }

        const slice = refs.slice(0, Math.max(0, limit - emitted));
        if (slice.length > 0) {
          emitted += slice.length;
          yield slice;
        }

        if (reachedCutoff || emitted >= limit || entries.length < pageSize) return;
        start += pageSize;
      }

      ctx.logger.warn(
        { emitted, limit, pages: maxPages },
        'arXiv discovery reached the defensive page cap',
      );
    },

    async fetchMetrics(ctx, refs, opts) {
      if (opts.mode === 'daily') return [];
      const out: FetchedItem<ArxivRaw>[] = [];
      const daily = await loadDailyFeeds(ctx);

      for (const ref of refs) {
        ctx.signal.throwIfAborted();
        const id = canonicalArxivId(ref.externalId);
        if (id === null) {
          out.push({
            ref,
            raw: { kind: 'hf-detail', paper: null },
            fetchedAt: ctx.now(),
            notFound: true,
          });
          continue;
        }

        const fromFeed = daily.get(id);
        if (fromFeed !== undefined) {
          out.push({
            ref,
            raw: { kind: 'hf-daily', paper: fromFeed },
            fetchedAt: ctx.now(),
          });
          continue;
        }

        const missingAt = missingUntil.get(id);
        if (missingAt !== undefined && missingAt > ctx.now().getTime()) continue;

        if (!reserveDetailCall(ctx.now())) {
          // The hourly budget is exhausted: skip the upstream call and reuse
          // the stored value through the processor's continuity path.
          out.push({
            ref,
            raw: { kind: 'hf-detail', paper: null },
            fetchedAt: ctx.now(),
            notModified: true,
          });
          continue;
        }

        const paper = await fetchPaper(ctx, id);
        if (paper === null) {
          // No HF entry: the paper stays tracked. Remember the 404 so the
          // hourly fallback budget goes to papers that do have HF data.
          missingUntil.set(id, ctx.now().getTime() + MISSING_TTL_MS);
          if (missingUntil.size > 5_000) {
            const oldest = missingUntil.keys().next().value;
            if (oldest !== undefined) missingUntil.delete(oldest);
          }
          continue;
        }
        missingUntil.delete(id);
        out.push({
          ref,
          raw: { kind: 'hf-detail', paper },
          fetchedAt: ctx.now(),
        });
      }
      return out;
    },

    normalize: normalizeArxivItem,
  };
}
