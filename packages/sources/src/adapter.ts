import type { Item, ItemKind, Metric, RedisTokenBucket, Source, Tier } from '@trendr/core';
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
}

/** Upstream payload + metrics for one item, as fetched (pre-normalization). */
export interface FetchedItem<TRaw = unknown> {
  ref: DiscoveredRef;
  raw: TRaw; // validated with the adapter's Zod schema
  fetchedAt: Date;
  notModified?: boolean; // conditional request returned 304
  notFound?: boolean; // 404/410: mark item deleted/archived
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

export interface AdapterContext {
  logger: Logger;
  bucket: RedisTokenBucket; // per-source rate limiter (Section 7.4)
  signal: AbortSignal; // job cancellation / shutdown
  now: () => Date; // injectable clock for tests
  runId: bigint;
}

export interface DiscoverOptions {
  since?: Date;
  maxItems: number;
  strategy?: string;
}
export interface FetchOptions {
  tier: Tier;
  includeDailyHistoryDays?: number;
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
