import {
  ConflictError,
  NotFoundError,
  jobId,
  type ItemKind,
  type Metric,
  type Source,
} from '@trendr/core';
import {
  addWatchlistItem,
  countWatchlistItems,
  countWatchlists,
  createWatchlist,
  deleteWatchlist,
  getItemById,
  getWatchlistSummaryForUser,
  isUniqueViolation,
  listWatchlistItemRefs,
  listWatchlists,
  loadCardItems,
  loadCardSeries,
  loadCurrentScoresForItems,
  markItemHot,
  removeWatchlistItem,
  renameWatchlist,
  type CurrentScoreFields,
  type Db,
  type WatchlistRecord,
  type WatchlistSummary,
} from '@trendr/db';

import type { ApiQueues } from '../queues.js';

/**
 * Spec §10.5 / task 7.2 — watchlist CRUD and membership. Per-user caps are
 * 20 watchlists and 500 items; every operation is scoped by `user_id` so a
 * foreign id is indistinguishable from a missing one (404).
 */

export const MAX_WATCHLISTS_PER_USER = 20;
export const MAX_ITEMS_PER_WATCHLIST = 500;

export interface WatchlistServiceDeps {
  db: Db;
  /** Absent in tooling/unit contexts: adding still promotes, but no refresh job. */
  queues?: ApiQueues;
  now?: () => Date;
}

export interface WatchlistView {
  id: string;
  name: string;
  isDefault: boolean;
  itemCount: number;
  createdAt: string;
}

export interface WatchlistScoreView {
  delta: number;
  relGrowth: number;
  percentile: number;
  rankSource: number | null;
}

export interface WatchlistItemView {
  id: string;
  source: Source;
  kind: ItemKind;
  displayName: string;
  description: string | null;
  url: string;
  language: string | null;
  primaryMetric: Metric;
  topics: string[];
  current: number | null;
  sparkline: number[];
  addedAt: string;
  scores: { '24h': WatchlistScoreView | null; '7d': WatchlistScoreView | null };
}

export interface WatchlistContents {
  watchlist: WatchlistView;
  items: WatchlistItemView[];
}

function toView(row: WatchlistSummary): WatchlistView {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    itemCount: row.itemCount,
    createdAt: row.createdAt.toISOString(),
  };
}

function toScore(fields: CurrentScoreFields | undefined): WatchlistScoreView | null {
  if (fields === undefined) return null;
  return {
    delta: fields.delta,
    relGrowth: fields.relGrowth,
    percentile: fields.percentile,
    rankSource: fields.rankSource,
  };
}

export async function listWatchlistsForUser(
  deps: WatchlistServiceDeps,
  userId: string,
): Promise<WatchlistView[]> {
  return (await listWatchlists(deps.db, userId)).map(toView);
}

export async function createWatchlistForUser(
  deps: WatchlistServiceDeps,
  userId: string,
  name: string,
): Promise<WatchlistView> {
  const existing = await countWatchlists(deps.db, userId);
  if (existing >= MAX_WATCHLISTS_PER_USER) {
    throw new ConflictError(`watchlist limit reached (${MAX_WATCHLISTS_PER_USER})`);
  }

  // The first watchlist is the default one; auto-provisioning on first save is
  // a UX decision recorded in SPEC_REVIEW, the schema still enforces one each.
  const isDefault = existing === 0;
  try {
    return toNewView(await createWatchlist(deps.db, { userId, name, isDefault }));
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    if (isDefault) {
      // A concurrent request won the default slot; retry as a normal list.
      try {
        return toNewView(await createWatchlist(deps.db, { userId, name, isDefault: false }));
      } catch (retryError) {
        if (isUniqueViolation(retryError)) {
          throw new ConflictError('a watchlist with that name already exists');
        }
        throw retryError;
      }
    }
    throw new ConflictError('a watchlist with that name already exists');
  }
}

function toNewView(row: WatchlistRecord): WatchlistView {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    itemCount: 0,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function renameWatchlistForUser(
  deps: WatchlistServiceDeps,
  userId: string,
  watchlistId: string,
  name: string,
): Promise<WatchlistView> {
  await requireOwnedWatchlist(deps, userId, watchlistId);
  try {
    const renamed = await renameWatchlist(deps.db, userId, watchlistId, name);
    if (renamed === null) throw new NotFoundError('watchlist not found');
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError('a watchlist with that name already exists');
    }
    throw error;
  }
  const summary = await getWatchlistSummaryForUser(deps.db, userId, watchlistId);
  if (summary === null) throw new NotFoundError('watchlist not found');
  return toView(summary);
}

export async function deleteWatchlistForUser(
  deps: WatchlistServiceDeps,
  userId: string,
  watchlistId: string,
): Promise<void> {
  const deleted = await deleteWatchlist(deps.db, userId, watchlistId);
  if (!deleted) throw new NotFoundError('watchlist not found');
}

export async function getWatchlistContents(
  deps: WatchlistServiceDeps,
  userId: string,
  watchlistId: string,
): Promise<WatchlistContents> {
  const summary = await getWatchlistSummaryForUser(deps.db, userId, watchlistId);
  if (summary === null) throw new NotFoundError('watchlist not found');

  const refs = await listWatchlistItemRefs(deps.db, watchlistId);
  const ids = refs.map((ref) => ref.itemId);
  const now = deps.now?.() ?? new Date();

  const cards = await loadCardItems(deps.db, ids);
  const series = await loadCardSeries(deps.db, cards, now);
  const [dayScores, weekScores] = await Promise.all([
    loadCurrentScoresForItems(deps.db, ids, '24h'),
    loadCurrentScoresForItems(deps.db, ids, '7d'),
  ]);

  const items: WatchlistItemView[] = [];
  for (const ref of refs) {
    const card = cards.get(ref.itemId);
    if (card === undefined) continue;
    const spark = series.get(ref.itemId);
    items.push({
      id: card.id.toString(),
      source: card.source,
      kind: card.kind,
      displayName: card.displayName,
      description: card.description,
      url: card.url,
      language: card.language,
      primaryMetric: card.primaryMetric,
      topics: card.topics,
      current: spark?.current ?? null,
      sparkline: spark?.sparkline ?? [],
      addedAt: ref.addedAt.toISOString(),
      scores: {
        '24h': toScore(dayScores.get(ref.itemId)),
        '7d': toScore(weekScores.get(ref.itemId)),
      },
    });
  }

  return { watchlist: toView(summary), items };
}

export async function addItemToWatchlistForUser(
  deps: WatchlistServiceDeps,
  userId: string,
  watchlistId: string,
  itemId: bigint,
): Promise<{ added: boolean; watchlist: WatchlistView }> {
  await requireOwnedWatchlist(deps, userId, watchlistId);

  const item = await getItemById(deps.db, itemId);
  if (item === null) throw new NotFoundError('item not found');

  const count = await countWatchlistItems(deps.db, watchlistId);
  if (count >= MAX_ITEMS_PER_WATCHLIST) {
    throw new ConflictError(`watchlist item limit reached (${MAX_ITEMS_PER_WATCHLIST})`);
  }

  const now = deps.now?.() ?? new Date();
  const added = await addWatchlistItem(deps.db, watchlistId, itemId, now);
  if (added && !item.flags.includes('stub')) {
    if (item.tier !== 'hot') await markItemHot(deps.db, itemId, now);

    // Spec §7.8: promote immediately and schedule a refresh (deduped per UTC day).
    if (deps.queues !== undefined) {
      const day = now.toISOString().slice(0, 10);
      try {
        await deps.queues.ingest[item.source].add(
          'refresh-item',
          {
            type: 'refresh-item',
            source: item.source,
            itemId: itemId.toString(),
            trigger: 'manual',
          },
          { jobId: jobId.refreshItem(item.source, itemId.toString(), day) },
        );
      } catch {
        // The watchlist write is authoritative; a transient queue outage must
        // not fail it. The scheduler's next ingest pass still refreshes hot items.
      }
    }
  }

  const summary = await getWatchlistSummaryForUser(deps.db, userId, watchlistId);
  if (summary === null) throw new NotFoundError('watchlist not found');
  return { added, watchlist: toView(summary) };
}

export async function removeItemFromWatchlistForUser(
  deps: WatchlistServiceDeps,
  userId: string,
  watchlistId: string,
  itemId: bigint,
): Promise<void> {
  await requireOwnedWatchlist(deps, userId, watchlistId);
  await removeWatchlistItem(deps.db, watchlistId, itemId);
}

async function requireOwnedWatchlist(
  deps: WatchlistServiceDeps,
  userId: string,
  watchlistId: string,
): Promise<void> {
  const summary = await getWatchlistSummaryForUser(deps.db, userId, watchlistId);
  if (summary === null) throw new NotFoundError('watchlist not found');
}
