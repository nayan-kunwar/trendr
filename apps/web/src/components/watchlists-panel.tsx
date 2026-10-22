'use client';

import { ArrowUpRight, FolderPlus, Loader2, Pencil, Star, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type SyntheticEvent } from 'react';

import { useAuth } from '@/components/auth-provider';
import { SourceBadge } from '@/components/source-badge';
import { Sparkline } from '@/components/sparkline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authErrorMessage } from '@/lib/auth';
import { formatCompact, formatGrowth, itemHref } from '@/lib/format';
import {
  createWatchlist,
  deleteWatchlist,
  getWatchlistItems,
  listWatchlists,
  removeWatchlistItem,
  renameWatchlist,
} from '@/lib/watchlists';
import type { Watchlist, WatchlistItem } from '@/lib/watchlist-schemas';

export function WatchlistsPanel() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [rename, setRename] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!authLoading && user === null) router.replace('/login');
  }, [authLoading, router, user]);

  useEffect(() => {
    if (user === null) return;
    let active = true;
    setLoading(true);
    void listWatchlists()
      .then((rows) => {
        if (!active) return;
        setWatchlists(rows);
        setSelectedId((current) => current ?? (rows.length > 0 ? rows[0].id : null));
      })
      .catch((cause: unknown) => {
        if (active) setError(authErrorMessage(cause, 'Could not load your watchlists.'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user]);

  const selected = watchlists.find((watchlist) => watchlist.id === selectedId) ?? null;

  useEffect(() => {
    if (selected === null) {
      setItems([]);
      setRename('');
      return;
    }
    setRename(selected.name);
    let active = true;
    setItemsLoading(true);
    void getWatchlistItems(selected.id)
      .then((body) => {
        if (active) setItems(body.items);
      })
      .catch((cause: unknown) => {
        if (active) setError(authErrorMessage(cause, 'Could not load watchlist items.'));
      })
      .finally(() => {
        if (active) setItemsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selected]);

  async function onCreate(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newName.trim();
    if (name.length === 0 || creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createWatchlist(name);
      setWatchlists((rows) => [...rows, created]);
      setSelectedId(created.id);
      setNewName('');
    } catch (cause) {
      setError(authErrorMessage(cause, 'Could not create that watchlist.'));
    } finally {
      setCreating(false);
    }
  }

  async function onRename(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selected === null) return;
    const name = rename.trim();
    if (name.length === 0 || renaming) return;
    setRenaming(true);
    setError(null);
    try {
      const updated = await renameWatchlist(selected.id, name);
      setWatchlists((rows) =>
        rows.map((row) => (row.id === updated.id ? { ...row, name: updated.name } : row)),
      );
    } catch (cause) {
      setError(authErrorMessage(cause, 'Could not rename that watchlist.'));
    } finally {
      setRenaming(false);
    }
  }

  async function onDelete() {
    if (selected === null || deleting) return;
    if (!window.confirm(`Delete “${selected.name}” and all of its items?`)) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteWatchlist(selected.id);
      setWatchlists((rows) => {
        const remaining = rows.filter((row) => row.id !== selected.id);
        setSelectedId(remaining[0]?.id ?? null);
        return remaining;
      });
    } catch (cause) {
      setError(authErrorMessage(cause, 'Could not delete that watchlist.'));
    } finally {
      setDeleting(false);
    }
  }

  async function onRemove(item: WatchlistItem) {
    if (selected === null) return;
    setError(null);
    try {
      await removeWatchlistItem(selected.id, item.id);
      setItems((rows) => rows.filter((row) => row.id !== item.id));
      setWatchlists((rows) =>
        rows.map((row) =>
          row.id === selected.id ? { ...row, itemCount: Math.max(0, row.itemCount - 1) } : row,
        ),
      );
    } catch (cause) {
      setError(authErrorMessage(cause, 'Could not remove that item.'));
    }
  }

  if (authLoading || (loading && user !== null)) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-border bg-card p-10 text-sm text-muted-foreground">
        <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" />
        Loading watchlists…
      </div>
    );
  }

  if (user === null) return null;

  return (
    <section className="rounded-xl border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Star aria-hidden="true" className="size-4 text-emerald-500" />
            Watchlists
          </h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Up to 20 lists and 500 items per list. Adding an item refreshes it immediately.
          </p>
        </div>
        <Badge variant="outline">{watchlists.length}/20</Badge>
      </div>

      {error !== null ? (
        <p
          role="alert"
          className="border-b border-rose-500/20 bg-rose-500/5 px-5 py-2 text-xs text-rose-600 dark:text-rose-400"
        >
          {error}
        </p>
      ) : null}

      <div className="grid gap-0 md:grid-cols-[240px_1fr]">
        <div className="border-b border-border p-3 md:border-b-0 md:border-r">
          <form
            onSubmit={(event) => {
              void onCreate(event);
            }}
            className="flex gap-1.5"
          >
            <Input
              value={newName}
              onChange={(event) => {
                setNewName(event.target.value);
              }}
              placeholder="New watchlist"
              maxLength={80}
              aria-label="New watchlist name"
              className="h-8 text-xs"
              disabled={creating}
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              className="h-8 shrink-0 px-2"
              disabled={creating || newName.trim().length === 0}
              aria-label="Create watchlist"
            >
              {creating ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <FolderPlus aria-hidden="true" />
              )}
            </Button>
          </form>

          <ul className="mt-2 space-y-0.5" aria-label="Your watchlists">
            {watchlists.map((watchlist) => (
              <li key={watchlist.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(watchlist.id);
                  }}
                  aria-current={watchlist.id === selectedId ? 'true' : undefined}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                    watchlist.id === selectedId
                      ? 'bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-300'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{watchlist.name}</span>
                  {watchlist.isDefault ? <Badge variant="success">Default</Badge> : null}
                  <span className="tabular-nums text-[10px] opacity-70">{watchlist.itemCount}</span>
                </button>
              </li>
            ))}
            {watchlists.length === 0 ? (
              <li className="px-2 py-4 text-center text-[11px] text-muted-foreground">
                No lists yet. Create one above, or press Watch on any item.
              </li>
            ) : null}
          </ul>
        </div>

        <div className="min-w-0">
          {selected === null ? (
            <div className="flex h-full min-h-48 flex-col items-center justify-center p-8 text-center">
              <Star aria-hidden="true" className="size-6 text-muted-foreground/50" />
              <p className="mt-2 text-sm font-medium">Nothing selected</p>
              <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                Create a watchlist or add items from their detail pages.
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                <form
                  onSubmit={(event) => {
                    void onRename(event);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-1.5"
                >
                  <Input
                    value={rename}
                    onChange={(event) => {
                      setRename(event.target.value);
                    }}
                    maxLength={80}
                    aria-label="Watchlist name"
                    className="h-8 max-w-64 text-xs font-medium"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="ghost"
                    className="h-8 px-2"
                    disabled={renaming || rename.trim().length === 0}
                    aria-label="Rename watchlist"
                  >
                    {renaming ? (
                      <Loader2 aria-hidden="true" className="animate-spin" />
                    ) : (
                      <Pencil aria-hidden="true" />
                    )}
                  </Button>
                </form>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2 text-rose-500 hover:text-rose-600"
                  onClick={() => {
                    void onDelete();
                  }}
                  disabled={deleting}
                  aria-label="Delete watchlist"
                >
                  {deleting ? (
                    <Loader2 aria-hidden="true" className="animate-spin" />
                  ) : (
                    <Trash2 aria-hidden="true" />
                  )}
                </Button>
              </div>

              {itemsLoading ? (
                <div className="flex items-center justify-center p-10 text-xs text-muted-foreground">
                  <Loader2 aria-hidden="true" className="mr-2 size-3.5 animate-spin" />
                  Loading items…
                </div>
              ) : items.length === 0 ? (
                <div className="p-8 text-center">
                  <p className="text-sm font-medium">This list is empty</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Open any item and choose Watch to save it here.
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {items.map((item) => (
                    <li key={item.id} className="flex items-start gap-3 px-4 py-3">
                      <SourceBadge source={item.source} className="mt-0.5 hidden sm:inline-flex" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={itemHref({ id: item.id, displayName: item.displayName })}
                            className="truncate text-sm font-semibold hover:underline"
                          >
                            {item.displayName}
                          </Link>
                          <SourceBadge source={item.source} className="sm:hidden" />
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground">
                          {item.current !== null ? (
                            <span>{formatCompact(item.current)} now</span>
                          ) : null}
                          {item.scores['24h'] !== null ? (
                            <span className="text-emerald-600 dark:text-emerald-400">
                              24h {formatGrowth(item.scores['24h'].delta)}
                            </span>
                          ) : null}
                          {item.scores['7d'] !== null ? (
                            <span>7d {formatGrowth(item.scores['7d'].delta)}</span>
                          ) : null}
                        </div>
                      </div>
                      {item.sparkline.length > 1 ? (
                        <Sparkline
                          values={item.sparkline}
                          width={72}
                          height={22}
                          className="mt-1 hidden sm:block"
                        />
                      ) : null}
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        aria-label={`Open ${item.displayName} on the source`}
                        className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground"
                      >
                        <ArrowUpRight aria-hidden="true" className="size-3.5" />
                      </a>
                      <button
                        type="button"
                        onClick={() => {
                          void onRemove(item);
                        }}
                        aria-label={`Remove ${item.displayName}`}
                        className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-rose-500"
                      >
                        <Trash2 aria-hidden="true" className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
