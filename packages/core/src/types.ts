import { z } from 'zod';

/**
 * Spec §5 — the canonical core types. Enums are Zod schemas (runtime and
 * compile-time agree); the plain interfaces mirror §5 one-to-one.
 */

export const SOURCES = ['github', 'npm', 'pypi', 'huggingface', 'arxiv', 'mcp'] as const;
export const SourceSchema = z.enum(SOURCES);
export type Source = z.infer<typeof SourceSchema>;

/** Leaderboard scope: one source or the combined board. */
export const LeaderboardScopeSchema = z.enum(['all', ...SOURCES]);
export type LeaderboardScope = z.infer<typeof LeaderboardScopeSchema>;

export const ITEM_KINDS = [
  'repo',
  'package',
  'model',
  'dataset',
  'space',
  'paper',
  'mcp_server',
] as const;
export const ItemKindSchema = z.enum(ITEM_KINDS);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const WINDOWS = ['24h', '7d', '30d'] as const;
export const WindowSchema = z.enum(WINDOWS);
export type Window = z.infer<typeof WindowSchema>;
export const WINDOW_HOURS: Record<Window, number> = { '24h': 24, '7d': 168, '30d': 720 };
export const WINDOW_DAYS: Record<Window, number> = { '24h': 1, '7d': 7, '30d': 30 };

export const TIERS = ['hot', 'warm', 'cold', 'archived'] as const;
export const TierSchema = z.enum(TIERS);
export type Tier = z.infer<typeof TierSchema>;

/**
 * Metric semantics drive the scoring math:
 *  - cumulative: monotonic-ish counter sampled by snapshots (stars, likes, upvotes, downloads_total)
 *  - daily_count: upstream gives per-day aggregates (npm/PyPI downloads); never diff these
 *  - gauge: point-in-time value with no growth meaning (HF trending_score, open_issues)
 */
export const METRICS = [
  'stars',
  'forks',
  'watchers',
  'open_issues',
  'downloads',
  'downloads_total',
  'likes',
  'upvotes',
  'trending_score',
  'comments',
] as const;
export const MetricSchema = z.enum(METRICS);
export type Metric = z.infer<typeof MetricSchema>;
export type MetricKind = 'cumulative' | 'daily_count' | 'gauge';
export const METRIC_KIND: Record<Metric, MetricKind> = {
  stars: 'cumulative',
  forks: 'cumulative',
  watchers: 'cumulative',
  open_issues: 'gauge',
  downloads: 'daily_count',
  downloads_total: 'cumulative',
  likes: 'cumulative',
  upvotes: 'cumulative',
  trending_score: 'gauge',
  comments: 'cumulative',
};

/** Canonical item as stored in `items`. */
export interface Item {
  id: bigint; // items.id (bigint identity); serialized as string in JSON
  source: Source;
  kind: ItemKind;
  externalId: string; // canonical natural key, see ids.ts (e.g. "vercel/next.js", "@scope/pkg", "2610.21185")
  upstreamId: string | null; // stable upstream id if any (GitHub node_id, HF _id, MCP registry name)
  name: string; // short name ("next.js")
  displayName: string; // "vercel/next.js"
  description: string | null;
  url: string; // canonical upstream URL
  homepage: string | null;
  language: string | null; // GitHub primary language, "python" for PyPI, "javascript" for npm
  license: string | null;
  owner: string | null;
  topics: string[]; // normalized slugs
  primaryMetric: Metric;
  latestMetrics: Partial<Record<Metric, number>>;
  tier: Tier;
  upstreamCreatedAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastSnapshotAt: Date | null;
  isArchived: boolean;
  flags: ItemFlag[];
  metadata: Record<string, unknown>; // source-specific (validated per source by Zod)
}
export type ItemFlag =
  | 'burst_suspected'
  | 'fork'
  | 'deprecated'
  | 'gated'
  | 'yanked'
  | 'manual_hidden'
  /** §5.4/§7.1: alias-target stub kept for rename/alias resolution (never scheduled for refresh). */
  | 'stub';

/** One point of a time series (row in `snapshots`). captured_at is the *bucket start*. */
export interface MetricSnapshot {
  itemId: bigint;
  metric: Metric;
  capturedAt: Date; // date_trunc('hour') for hot/warm, date_trunc('day') for cold
  observedAt: Date; // actual fetch time
  value: number; // stored as bigint; JS number is safe up to 2^53
  runId: bigint | null;
}

/** One day of an aggregate (row in `daily_metrics`). */
export interface DailyMetric {
  itemId: bigint;
  metric: Metric;
  day: string; // 'YYYY-MM-DD' UTC
  value: number; // daily_count: count that day; cumulative: end-of-day level
}

export interface ScoreComponents {
  delta: number; // absolute growth in window
  base: number; // level (cumulative) or prior-period total (daily_count)
  relGrowth: number; // delta / (base + k)
  rawScore: number; // log-damped velocity (Section 8.2)
  ageFactor: number;
  confidence: number; // 0..1 data coverage
  anomalyPenalty: number; // 1 = none, <1 penalized
  finalScore: number; // raw * age * confidence * anomaly
}

export interface Score extends ScoreComponents {
  itemId: bigint;
  source: Source;
  window: Window;
  runId: bigint;
  computedAt: Date;
  zScore: number; // robust z within (source, window)
  percentile: number; // 0..100 within (source, window)
  rankSource: number; // 1-based
  rankAll: number | null; // 1-based rank in combined board (null if not eligible)
  flags: ScoreFlag[];
}
export const ScoreFlagSchema = z.enum([
  'below_threshold',
  'insufficient_data',
  'burst_suspected',
  'new_item',
  'negative_growth',
]);
export type ScoreFlag = z.infer<typeof ScoreFlagSchema>;

/** What a leaderboard row looks like on the wire. */
export interface LeaderboardEntry {
  rank: number;
  item: Pick<
    Item,
    | 'source'
    | 'kind'
    | 'externalId'
    | 'displayName'
    | 'description'
    | 'url'
    | 'language'
    | 'topics'
    | 'primaryMetric'
  > & { id: string };
  window: Window;
  delta: number;
  relGrowth: number;
  score: number; // finalScore for source boards, zScore for 'all'
  percentile: number;
  current: number; // current level of primary metric (or last-day downloads)
  sparkline: number[]; // up to 30 points
  flags: ScoreFlag[];
}
