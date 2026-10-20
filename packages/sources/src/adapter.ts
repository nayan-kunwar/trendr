import type { Item, ItemKind, Metric, RedisTokenBucket, Source, Tier } from '@trendr/core';
import type { FetchJsonMetricsSink } from '@trendr/core';
import type { Logger } from '@trendr/logger';

/**
 * Spec §5.1 — the `SourceAdapter` contract. Adapters own every piece of
 * source-specific knowledge (URLs, payload schemas, normalization, batching);
 * the worker's ingest processor owns the generic pipeline (§7.1).
 */

/** Lightweight reference to an upstream item, before normalization. */
export interface DiscoveredRef {
  source: Source;
  kind: ItemKind;
  externalId: string; // canonical (see ids.ts)
  hint?: { reason: string; query?: string; rank?: number };
  raw?: unknown; // upstream payload if discovery already returned full data
  /**
   * `items.id` when the ref is already tracked. Optional extension of the
   * spec shape: adapters need it for per-item caches (`etag:github:{itemId}`,
   * §7.3.1) and the processor for 304 continuity writes.
   */
  itemId?: bigint;
}

/** Upstream payload + metrics for one item, as fetched (pre-normalization). */
export interface FetchedItem<TRaw = unknown> {
  ref: DiscoveredRef;
  raw: TRaw; // validated with the adapter's Zod schema
  fetchedAt: Date;
  notModified?: boolean; // conditional request returned 304
  notFound?: boolean; // 404/410: mark item deleted/archived
  /**
   * Additive extension of the spec shape (§7.3.2): the latest expected daily
   * bucket has not landed upstream yet. The item is still persisted with the
   * days that did land, and the run closes `partial` so the 06:00 retry can
   * fill the gap (spec §7.3.2 npm daily).
   */
  dailyIncomplete?: boolean;
}

export interface NormalizedItem {
  item: Omit<
    Item,
    'id' | 'firstSeenAt' | 'lastSeenAt' | 'lastSnapshotAt' | 'tier' | 'flags' | 'latestMetrics'
  > & {
    flags?: Item['flags'];
  };
  /** Cumulative/gauge values observed now → `snapshots`. */
  snapshots: { metric: Metric; value: number }[];
  /** Per-day aggregates (npm/PyPI downloads) → `daily_metrics`. */
  daily: { metric: Metric; day: string; value: number }[];
  /** Cross-source links discovered from metadata → `item_aliases`. */
  aliases: {
    source: Source;
    kind: ItemKind;
    externalId: string;
    relation: AliasRelation;
    confidence: number;
    evidence: string;
  }[];
}

export type AliasRelation =
  | 'same_project'
  | 'package_of'
  | 'mcp_server_of'
  | 'paper_code'
  | 'model_of_paper'
  | 'registry_entry_of';

/** Upstream rate-limit state observed from response headers (spec §7.4, §14.1). */
export interface RateLimitInfo {
  /** `x-ratelimit-resource` — `core`, `search` or `graphql`. */
  resource: string;
  remaining: number;
  resetAt: Date | null;
}

/** Fine-grained PAT expiry (`github-authentication-token-expiration`, GAP-8). */
export interface TokenExpiryInfo {
  tokenIndex: number;
  expiresAt: Date;
}

export interface AdapterContext {
  logger: Logger;
  bucket: RedisTokenBucket; // per-source rate limiter (Section 7.4)
  signal: AbortSignal; // job cancellation / shutdown
  now: () => Date; // injectable clock for tests
  runId: bigint;
  /**
   * §12 observability sink. Additive extension of the spec shape: the worker
   * passes a per-job composite so `ingestion_runs.api_calls` and the
   * `trendr_source_api_*` metrics come from the exact number of HTTP calls.
   */
  metrics?: FetchJsonMetricsSink;
  /** §7.4: last observed rate-limit state (gauge + `rate_limit_remaining` on the run). */
  onRateLimit?: (info: RateLimitInfo) => void;
  /** GAP-8: PAT expiry reported by GitHub responses. */
  onTokenExpiry?: (info: TokenExpiryInfo) => void;
}

export interface DiscoverOptions {
  since?: Date;
  maxItems: number;
  strategy?: string;
}
export interface FetchOptions {
  tier: Tier;
  includeDailyHistoryDays?: number;
  /**
   * Additive extension of the spec shape: the pipeline stage that requested
   * the fetch. Daily jobs only refresh the per-day series, so adapters may
   * skip metadata calls; snapshot/refresh jobs fetch metadata (§7.1 step 4).
   */
  mode?: 'snapshot' | 'daily';
}

export interface SourceAdapter<TRaw = unknown> {
  readonly source: Source;
  readonly kinds: readonly ItemKind[];
  /** Max refs per fetchMetrics() call (GraphQL batch 50, npm bulk 128, HF 1, PyPI 1, arXiv 100). */
  readonly batchSize: number;

  /** Find candidate items to add to (or refresh in) the tracked set. Must be paginated & bounded. */
  discover(ctx: AdapterContext, opts: DiscoverOptions): AsyncIterable<DiscoveredRef[]>;

  /** Fetch current metadata + metrics for a batch of known refs. Never throws for single-item 404s. */
  fetchMetrics(
    ctx: AdapterContext,
    refs: DiscoveredRef[],
    opts: FetchOptions,
  ): Promise<FetchedItem<TRaw>[]>;

  /** Pure function: upstream payload → canonical shape. No I/O. 100% unit-tested with fixtures. */
  normalize(fetched: FetchedItem<TRaw>): NormalizedItem | null;

  /** Optional: historical series for backfill (npm range, pypistats overall, GitHub stargazers). */
  backfill?(
    ctx: AdapterContext,
    ref: DiscoveredRef,
    days: number,
  ): Promise<NormalizedItem['daily']>;
}
