import { eq, inArray, sql } from 'drizzle-orm';
import type { Queue } from 'bullmq';

import {
  jobId,
  METRIC_KIND,
  type IngestJob,
  type Metric,
  type Source,
  type Tier,
} from '@trendr/core';
import { items, type Db } from '@trendr/db';
import type { Logger } from '@trendr/logger';

/**
 * Spec §7.8 — tiering. `retier-items` (daily, `maintenance`) evaluates the
 * tier rules in order (hot → warm → cold → archived), caps the hot set per
 * source and writes only tier changes; the watchlist "instant promotion"
 * (`promoteItemToHot`) sets `tier='hot'` and enqueues `refresh-item`.
 */

/** §7.8 hot cap env settings (`TRACKED_HOT_MAX_{SOURCE}`); absent ⇒ uncapped. */
export type HotMaxBySource = Partial<Record<Source, number>>;

/**
 * Discovery admission minima of §7.3, used by the "created ≤ 7 d ago with
 * primary metric ≥ source admission minimum" hot rule: GitHub new-hot
 * `stars:>=20`; npm `NPM_MIN_WEEKLY_DOWNLOADS` (200); PyPI
 * `PYPI_MIN_WEEKLY_DOWNLOADS` (500); HF newest `likes ≥ 5`. arXiv and MCP have
 * no metric-based admission minimum (arXiv papers are hot by age instead).
 */
export const ADMISSION_MINIMUM: Partial<Record<Source, number>> = {
  github: 20,
  npm: 200,
  pypi: 500,
  huggingface: 5,
};

/** §7.8: rank thresholds per tier. */
const HOT_RANK_MAX = 200;
const WARM_RANK_MAX = 2000;
/** §7.8: "created ≤ 7 d ago" for hot, "≤ 30 d ago" for warm, arXiv ≤ 30 d. */
const HOT_CREATED_DAYS = 7;
const WARM_CREATED_DAYS = 30;

export interface TierCandidate {
  itemId: bigint;
  source: Source;
  tier: Tier;
  /** `items.latest_metrics[primary_metric]`; compared with the admission minimum. */
  primaryMetricValue: number | null;
  /** Whole days since `upstream_created_at` (null when upstream had none). */
  createdDaysAgo: number | null;
  watched: boolean;
  /** Best (smallest) current-run `rank_source` per §8.4 window, null when unscored. */
  rank24: number | null;
  rank7: number | null;
  rank30: number | null;
  /** Best 7d percentile — the §7.8 hot-cap tie-break. */
  pct7: number | null;
  /** `GREATEST(last_snapshot_at, last_seen_at) ≥ now − 90 d`. */
  seen90d: boolean;
  /** Upstream froze the repo/package (`items.is_archived`). */
  upstreamArchived: boolean;
  /** Daily-count metric (npm/PyPI downloads): growth comes from `daily_metrics`. */
  dailyCount: boolean;
  /** §7.8 cold: "any positive 30d delta" (null = no history to tell). */
  delta30Positive: boolean | null;
  /** §7.3.4 HF trending feed rank ≤ 100; false until the HF adapter records it. */
  trendingTop100: boolean;
}

export interface RetierOptions {
  hotMaxBySource?: HotMaxBySource;
  admissionMinimum?: Partial<Record<Source, number>>;
  /** Symmetric `item_aliases` edges: an alias target of a hot item is ≥ warm (§7.8). */
  aliasEdges?: readonly (readonly [bigint, bigint])[];
}

export interface TierChange {
  itemId: bigint;
  from: Tier;
  to: Tier;
}

export interface RetierSummary {
  evaluated: number;
  changed: number;
  /** `${from}->${to}` → rows moved, for logs. */
  transitions: Record<string, number>;
}

/**
 * The §7.8 rules as a pure plan: returns one entry per item whose tier
 * changes. Hot candidates are capped per source with the best-7d-percentile
 * tie-break; watched items are exempt from the cap so a §7.8 instant
 * promotion is never undone by the next retier.
 */
export function planRetierItems(
  candidates: readonly TierCandidate[],
  options: RetierOptions = {},
): TierChange[] {
  const admission = options.admissionMinimum ?? ADMISSION_MINIMUM;

  const wanted: TierCandidate[] = [];
  for (const candidate of candidates) {
    if (isHotCandidate(candidate, admission)) wanted.push(candidate);
  }

  const hotSet = new Set<bigint>();
  const uncappedBySource = new Map<Source, TierCandidate[]>();
  for (const candidate of wanted) {
    if (candidate.watched) {
      hotSet.add(candidate.itemId);
    } else {
      const list = uncappedBySource.get(candidate.source) ?? [];
      list.push(candidate);
      uncappedBySource.set(candidate.source, list);
    }
  }
  for (const [source, list] of uncappedBySource) {
    const max = options.hotMaxBySource?.[source];
    list.sort(compareHotCandidates);
    const take = max === undefined ? list.length : Math.max(0, Math.min(max, list.length));
    for (const candidate of list.slice(0, take)) hotSet.add(candidate.itemId);
  }

  const aliasOfHot = new Set<bigint>();
  for (const [itemA, itemB] of options.aliasEdges ?? []) {
    if (hotSet.has(itemA)) aliasOfHot.add(itemB);
    if (hotSet.has(itemB)) aliasOfHot.add(itemA);
  }

  const changes: TierChange[] = [];
  for (const candidate of candidates) {
    const to = decideTier(
      candidate,
      hotSet.has(candidate.itemId),
      aliasOfHot.has(candidate.itemId),
    );
    if (to !== candidate.tier) {
      changes.push({ itemId: candidate.itemId, from: candidate.tier, to });
    }
  }
  // Deterministic output regardless of input order (logs, tests, diffs).
  changes.sort((a, b) => (a.itemId === b.itemId ? 0 : a.itemId < b.itemId ? -1 : 1));
  return changes;
}

function isHotCandidate(
  candidate: TierCandidate,
  admission: Partial<Record<Source, number>>,
): boolean {
  if (candidate.watched) return true;
  if (
    (candidate.rank24 !== null && candidate.rank24 <= HOT_RANK_MAX) ||
    (candidate.rank7 !== null && candidate.rank7 <= HOT_RANK_MAX) ||
    (candidate.rank30 !== null && candidate.rank30 <= HOT_RANK_MAX)
  ) {
    return true;
  }
  if (candidate.createdDaysAgo !== null && candidate.createdDaysAgo <= HOT_CREATED_DAYS) {
    const minimum = admission[candidate.source];
    if (
      minimum !== undefined &&
      candidate.primaryMetricValue !== null &&
      candidate.primaryMetricValue >= minimum
    ) {
      return true;
    }
  }
  if (
    candidate.source === 'arxiv' &&
    candidate.createdDaysAgo !== null &&
    candidate.createdDaysAgo <= 30
  ) {
    return true;
  }
  return candidate.trendingTop100;
}

function decideTier(candidate: TierCandidate, isHot: boolean, aliasedByHot: boolean): Tier {
  if (isHot) return 'hot';
  const warmRank =
    (candidate.rank7 !== null && candidate.rank7 <= WARM_RANK_MAX) ||
    (candidate.rank30 !== null && candidate.rank30 <= WARM_RANK_MAX);
  if (warmRank || aliasedByHot) return 'warm';
  if (candidate.createdDaysAgo !== null && candidate.createdDaysAgo <= WARM_CREATED_DAYS)
    return 'warm';

  // §7.8 cold, then archived as the fallback of the ordered evaluation. An
  // item the upstream froze stops being polled even if it was seen recently
  // (watched items stay hot above, so user intent still wins).
  const cold = candidate.seen90d || candidate.delta30Positive === true;
  if (cold && !(candidate.upstreamArchived && !candidate.watched)) return 'cold';
  return 'archived';
}

/** §7.8 tie-break: best 7d percentile first, deterministic by id. */
function compareHotCandidates(a: TierCandidate, b: TierCandidate): number {
  const percentileA = a.pct7 ?? Number.NEGATIVE_INFINITY;
  const percentileB = b.pct7 ?? Number.NEGATIVE_INFINITY;
  if (percentileA !== percentileB) return percentileB - percentileA;
  return a.itemId === b.itemId ? 0 : a.itemId < b.itemId ? -1 : 1;
}

export interface RetierDeps {
  db: Db;
  logger?: Logger;
  /** `TRACKED_HOT_MAX_*` (spec §7.8); omitted ⇒ no cap. */
  hotMaxBySource?: HotMaxBySource;
  now?: () => Date;
}

/**
 * Spec §7.8 — evaluate every live item (alias stubs and soft-deleted rows are
 * not tracked) and write the tier changes in one transaction. Aliases are
 * loaded as symmetric edges for the "alias target of a hot item" warm rule.
 */
export async function runRetierItems(deps: RetierDeps): Promise<RetierSummary> {
  const now = deps.now?.() ?? new Date();

  const rows = await loadCandidates(deps.db, now);
  const aliasEdges = await loadAliasEdges(deps.db);
  const changes = planRetierItems(rows, {
    ...(deps.hotMaxBySource === undefined ? {} : { hotMaxBySource: deps.hotMaxBySource }),
    aliasEdges,
  });

  const byTarget = new Map<Tier, bigint[]>();
  const transitions: Record<string, number> = {};
  for (const change of changes) {
    const list = byTarget.get(change.to) ?? [];
    list.push(change.itemId);
    byTarget.set(change.to, list);
    const key = `${change.from}->${change.to}`;
    transitions[key] = (transitions[key] ?? 0) + 1;
  }
  if (changes.length > 0) {
    await deps.db.transaction(async (tx) => {
      for (const [tier, ids] of byTarget) {
        await tx
          .update(items)
          .set({ tier, updatedAt: sql`now()` })
          .where(inArray(items.id, ids));
      }
    });
  }

  const summary: RetierSummary = {
    evaluated: rows.length,
    changed: changes.length,
    transitions,
  };
  deps.logger?.info(summary, 'retier-items finished');
  return summary;
}

async function loadCandidates(db: Db, now: Date): Promise<TierCandidate[]> {
  const h30 = new Date(now.getTime() - 30 * 86_400_000);
  const h90 = new Date(now.getTime() - 90 * 86_400_000);
  const d30 = h30.toISOString().slice(0, 10);

  const result = await db.execute<{
    itemId: string;
    source: Source;
    tier: Tier;
    primaryMetric: Metric;
    metricValue: string | null;
    createdDaysAgo: number | string | null;
    watched: boolean;
    upstreamArchived: boolean;
    seen90d: boolean;
    rank24: number | null;
    rank7: number | null;
    rank30: number | null;
    pct7: number | null;
    vNow: string | null;
    v30: string | null;
    d30: string | null;
    d30Rows: string | null;
    trendingRank: number | string | null;
  }>(sql`
    WITH tracked AS (
      SELECT i.id, i.source, i.tier, i.primary_metric, i.latest_metrics, i.metadata,
             i.upstream_created_at, i.is_archived,
             GREATEST(i.last_seen_at, COALESCE(i.last_snapshot_at, i.last_seen_at)) AS seen_at,
             EXISTS (SELECT 1 FROM watchlist_items w WHERE w.item_id = i.id) AS watched
      FROM items i
      WHERE NOT i.is_deleted AND NOT ('stub' = ANY(i.flags))
    ),
    ranks AS (
      SELECT s.item_id AS id,
             MIN(s.rank_source) FILTER (WHERE s.window = '24h') AS rank24,
             MIN(s.rank_source) FILTER (WHERE s.window = '7d') AS rank7,
             MIN(s.rank_source) FILTER (WHERE s.window = '30d') AS rank30,
             MAX(s.percentile) FILTER (WHERE s.window = '7d') AS pct7
      FROM scores s
      JOIN score_runs_current c
        ON c.source = s.source AND c.window = s.window AND c.run_id = s.run_id
      GROUP BY s.item_id
    ),
    snap_growth AS (
      SELECT t.id,
             (SELECT s.value FROM snapshots s
               WHERE s.item_id = t.id AND s.metric = t.primary_metric
               ORDER BY s.captured_at DESC LIMIT 1) AS v_now,
             (SELECT s.value FROM snapshots s
               WHERE s.item_id = t.id AND s.metric = t.primary_metric AND s.captured_at <= ${h30}
               ORDER BY s.captured_at DESC LIMIT 1) AS v30
      FROM tracked t
    ),
    daily_growth AS (
      SELECT t.id,
             SUM(d.value) FILTER (WHERE d.day >= ${d30}::date) AS d30,
             COUNT(*) FILTER (WHERE d.day >= ${d30}::date) AS d30_rows
      FROM tracked t
      JOIN daily_metrics d ON d.item_id = t.id AND d.metric = t.primary_metric
      GROUP BY t.id
    )
    SELECT t.id::text AS "itemId", t.source, t.tier, t.primary_metric AS "primaryMetric",
           CASE WHEN jsonb_typeof(t.latest_metrics -> t.primary_metric::text) = 'number'
                THEN (t.latest_metrics ->> t.primary_metric::text)::text END AS "metricValue",
           CASE WHEN t.upstream_created_at IS NULL THEN NULL
                ELSE FLOOR(EXTRACT(EPOCH FROM (${now}::timestamptz - t.upstream_created_at)) / 86400)::int
           END AS "createdDaysAgo",
           t.watched, t.is_archived AS "upstreamArchived", (t.seen_at >= ${h90}) AS "seen90d",
           r.rank24, r.rank7, r.rank30, r.pct7,
           sg.v_now::text AS "vNow", sg.v30::text AS "v30",
           dg.d30::text AS "d30", dg.d30_rows::text AS "d30Rows",
           CASE WHEN jsonb_typeof(t.metadata -> 'trendingRank') = 'number'
                THEN FLOOR((t.metadata ->> 'trendingRank')::numeric)::int END AS "trendingRank"
    FROM tracked t
    LEFT JOIN ranks r ON r.id = t.id
    LEFT JOIN snap_growth sg ON sg.id = t.id
    LEFT JOIN daily_growth dg ON dg.id = t.id`);

  return result.rows.map((row) => {
    const dailyCount = METRIC_KIND[row.primaryMetric] === 'daily_count';
    const vNow = toNumber(row.vNow);
    const v30 = toNumber(row.v30);
    const d30 = toNumber(row.d30);
    const d30Rows = toNumber(row.d30Rows) ?? 0;
    const trendingRank = toNumber(row.trendingRank);
    return {
      itemId: BigInt(row.itemId),
      source: row.source,
      tier: row.tier,
      primaryMetricValue: toNumber(row.metricValue),
      createdDaysAgo: toNumber(row.createdDaysAgo),
      watched: row.watched,
      rank24: row.rank24,
      rank7: row.rank7,
      rank30: row.rank30,
      pct7: row.pct7,
      seen90d: row.seen90d,
      upstreamArchived: row.upstreamArchived,
      dailyCount,
      delta30Positive: dailyCount
        ? d30Rows > 0
          ? (d30 ?? 0) > 0
          : null
        : v30 !== null && vNow !== null
          ? vNow > v30
          : null,
      trendingTop100: trendingRank !== null && trendingRank <= 100,
    } satisfies TierCandidate;
  });
}

async function loadAliasEdges(db: Db): Promise<(readonly [bigint, bigint])[]> {
  const result = await db.execute<{ itemId: string; aliasItemId: string }>(sql`
    SELECT item_id::text AS "itemId", alias_item_id::text AS "aliasItemId" FROM item_aliases`);
  return result.rows.map((row) => [BigInt(row.itemId), BigInt(row.aliasItemId)] as const);
}

function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number(value);
}

export interface PromotionDeps {
  db: Db;
  /** The source's `ingest-*` queue: the refresh lands where its adapter lives. */
  ingestQueue: Queue<IngestJob>;
  logger?: Logger;
  now?: () => Date;
}

export type PromotionOutcome = 'promoted' | 'already-hot' | 'item-missing' | 'not-promotable';

/**
 * Spec §7.8 — instant promotion: adding an item to a watchlist sets
 * `tier='hot'` and enqueues `refresh-item` (deduped per item per UTC day).
 * Alias stubs are not promotable: their old slug 301s and redirects are never
 * followed. Returns what happened so callers can log it.
 */
export async function promoteItemToHot(
  deps: PromotionDeps,
  itemId: bigint,
): Promise<PromotionOutcome> {
  const [row] = await deps.db
    .select({ id: items.id, source: items.source, tier: items.tier, flags: items.flags })
    .from(items)
    .where(eq(items.id, itemId));
  if (row === undefined) return 'item-missing';
  if (row.flags.includes('stub')) return 'not-promotable';

  const alreadyHot = row.tier === 'hot';
  if (!alreadyHot) {
    await deps.db
      .update(items)
      .set({ tier: 'hot', updatedAt: sql`now()` })
      .where(eq(items.id, itemId));
  }

  const day = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  await deps.ingestQueue.add(
    'refresh-item',
    { type: 'refresh-item', source: row.source, itemId: itemId.toString(), trigger: 'manual' },
    { jobId: jobId.refreshItem(row.source, itemId.toString(), day) },
  );
  deps.logger?.info(
    { itemId: itemId.toString(), source: row.source, alreadyHot },
    'watchlist promotion: tier hot, refresh enqueued',
  );
  return alreadyHot ? 'already-hot' : 'promoted';
}
