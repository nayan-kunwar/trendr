import { authFetch, authFetchVoid } from './auth';
import {
  WatchlistItemWriteResponseSchema,
  WatchlistItemsResponseSchema,
  WatchlistSchema,
  WatchlistsResponseSchema,
  type Watchlist,
  type WatchlistItem,
} from './watchlist-schemas';

/** Client-side watchlist calls; every request carries the in-memory access JWT. */

export async function listWatchlists(): Promise<Watchlist[]> {
  const body = await authFetch('/v1/me/watchlists', WatchlistsResponseSchema);
  return body.watchlists;
}

export function createWatchlist(name: string): Promise<Watchlist> {
  return authFetch('/v1/me/watchlists', WatchlistSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function renameWatchlist(id: string, name: string): Promise<Watchlist> {
  return authFetch(`/v1/me/watchlists/${encodeURIComponent(id)}`, WatchlistSchema, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function deleteWatchlist(id: string): Promise<void> {
  return authFetchVoid(`/v1/me/watchlists/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function getWatchlistItems(id: string): Promise<{
  watchlist: Watchlist;
  items: WatchlistItem[];
}> {
  return authFetch(
    `/v1/me/watchlists/${encodeURIComponent(id)}/items`,
    WatchlistItemsResponseSchema,
  );
}

export function addWatchlistItem(
  watchlistId: string,
  itemId: string,
): Promise<{ added: boolean; watchlist: Watchlist }> {
  return authFetch(
    `/v1/me/watchlists/${encodeURIComponent(watchlistId)}/items/${encodeURIComponent(itemId)}`,
    WatchlistItemWriteResponseSchema,
    { method: 'PUT' },
  );
}

export function removeWatchlistItem(watchlistId: string, itemId: string): Promise<void> {
  return authFetchVoid(
    `/v1/me/watchlists/${encodeURIComponent(watchlistId)}/items/${encodeURIComponent(itemId)}`,
    { method: 'DELETE' },
  );
}

/** First-save UX: create the default list only when the user has none. */
export async function ensureDefaultWatchlist(): Promise<Watchlist> {
  const existing = await listWatchlists();
  if (existing.length > 0) return existing[0];
  return createWatchlist('My Watchlist');
}
