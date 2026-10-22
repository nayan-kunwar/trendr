import { and, asc, count, desc, eq } from 'drizzle-orm';

import type { DbExecutor } from '../client.js';
import { items } from '../schema/items.js';
import { watchlistItems, watchlists } from '../schema/engagement.js';

/**
 * Spec §6.2/§10.5 — per-user watchlists. Every lookup is scoped by `user_id`
 * so a caller can never distinguish another user's watchlist from a missing
 * one (task 7.2's IDOR requirement).
 */

export type WatchlistRecord = typeof watchlists.$inferSelect;
export type WatchlistItemRecord = typeof watchlistItems.$inferSelect;

export interface WatchlistSummary {
  id: string;
  userId: string;
  name: string;
  isDefault: boolean;
  createdAt: Date;
  itemCount: number;
}

const summaryColumns = {
  id: watchlists.id,
  userId: watchlists.userId,
  name: watchlists.name,
  isDefault: watchlists.isDefault,
  createdAt: watchlists.createdAt,
};

export async function listWatchlists(db: DbExecutor, userId: string): Promise<WatchlistSummary[]> {
  const rows = await db
    .select({
      ...summaryColumns,
      itemCount: count(watchlistItems.itemId).mapWith(Number),
    })
    .from(watchlists)
    .leftJoin(watchlistItems, eq(watchlistItems.watchlistId, watchlists.id))
    .where(eq(watchlists.userId, userId))
    .groupBy(watchlists.id)
    .orderBy(desc(watchlists.isDefault), asc(watchlists.createdAt));

  return rows;
}

export async function getWatchlistForUser(
  db: DbExecutor,
  userId: string,
  watchlistId: string,
): Promise<WatchlistRecord | null> {
  const [row] = await db
    .select()
    .from(watchlists)
    .where(and(eq(watchlists.id, watchlistId), eq(watchlists.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function getWatchlistSummaryForUser(
  db: DbExecutor,
  userId: string,
  watchlistId: string,
): Promise<WatchlistSummary | null> {
  const rows = await db
    .select({
      ...summaryColumns,
      itemCount: count(watchlistItems.itemId).mapWith(Number),
    })
    .from(watchlists)
    .leftJoin(watchlistItems, eq(watchlistItems.watchlistId, watchlists.id))
    .where(and(eq(watchlists.id, watchlistId), eq(watchlists.userId, userId)))
    .groupBy(watchlists.id)
    .limit(1);
  return rows[0] ?? null;
}

export async function findDefaultWatchlist(
  db: DbExecutor,
  userId: string,
): Promise<WatchlistRecord | null> {
  const [row] = await db
    .select()
    .from(watchlists)
    .where(and(eq(watchlists.userId, userId), eq(watchlists.isDefault, true)))
    .limit(1);
  return row ?? null;
}

export async function countWatchlists(db: DbExecutor, userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count().mapWith(Number) })
    .from(watchlists)
    .where(eq(watchlists.userId, userId));
  return row?.value ?? 0;
}

export async function createWatchlist(
  db: DbExecutor,
  input: { userId: string; name: string; isDefault: boolean },
): Promise<WatchlistRecord> {
  const [row] = await db.insert(watchlists).values(input).returning();
  if (row === undefined) throw new Error('createWatchlist: insert returned no row');
  return row;
}

export async function renameWatchlist(
  db: DbExecutor,
  userId: string,
  watchlistId: string,
  name: string,
): Promise<WatchlistRecord | null> {
  const [row] = await db
    .update(watchlists)
    .set({ name })
    .where(and(eq(watchlists.id, watchlistId), eq(watchlists.userId, userId)))
    .returning();
  return row ?? null;
}

export async function deleteWatchlist(
  db: DbExecutor,
  userId: string,
  watchlistId: string,
): Promise<boolean> {
  const rows = await db
    .delete(watchlists)
    .where(and(eq(watchlists.id, watchlistId), eq(watchlists.userId, userId)))
    .returning({ id: watchlists.id });
  return rows.length > 0;
}

export async function countWatchlistItems(db: DbExecutor, watchlistId: string): Promise<number> {
  const [row] = await db
    .select({ value: count().mapWith(Number) })
    .from(watchlistItems)
    .where(eq(watchlistItems.watchlistId, watchlistId));
  return row?.value ?? 0;
}

/** `true` when the row was new; re-adding an existing item is a no-op. */
export async function addWatchlistItem(
  db: DbExecutor,
  watchlistId: string,
  itemId: bigint,
  addedAt: Date,
): Promise<boolean> {
  const rows = await db
    .insert(watchlistItems)
    .values({ watchlistId, itemId, addedAt })
    .onConflictDoNothing()
    .returning({ itemId: watchlistItems.itemId });
  return rows.length > 0;
}

export async function removeWatchlistItem(
  db: DbExecutor,
  watchlistId: string,
  itemId: bigint,
): Promise<boolean> {
  const rows = await db
    .delete(watchlistItems)
    .where(and(eq(watchlistItems.watchlistId, watchlistId), eq(watchlistItems.itemId, itemId)))
    .returning({ itemId: watchlistItems.itemId });
  return rows.length > 0;
}

export interface WatchlistItemRef {
  itemId: bigint;
  addedAt: Date;
}

/** Live watchlist members, newest first (soft-deleted items are omitted). */
export async function listWatchlistItemRefs(
  db: DbExecutor,
  watchlistId: string,
): Promise<WatchlistItemRef[]> {
  return db
    .select({ itemId: watchlistItems.itemId, addedAt: watchlistItems.addedAt })
    .from(watchlistItems)
    .innerJoin(items, eq(items.id, watchlistItems.itemId))
    .where(and(eq(watchlistItems.watchlistId, watchlistId), eq(items.isDeleted, false)))
    .orderBy(desc(watchlistItems.addedAt), asc(watchlistItems.itemId));
}

/** IDs of every watchlist owned by `userId` that contains `itemId` (UI state). */
export async function findWatchlistsContainingItem(
  db: DbExecutor,
  userId: string,
  itemId: bigint,
): Promise<string[]> {
  const rows = await db
    .select({ id: watchlists.id })
    .from(watchlists)
    .innerJoin(watchlistItems, eq(watchlistItems.watchlistId, watchlists.id))
    .where(and(eq(watchlists.userId, userId), eq(watchlistItems.itemId, itemId)));
  return rows.map((row) => row.id);
}

/**
 * Postgres unique-violation detector for the name/default constraints.
 * Drizzle may wrap the driver error, so inspect the cause chain.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
