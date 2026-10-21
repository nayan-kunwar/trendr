'use client';

import { Radio } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';

import type { LeaderboardScope, Window } from '@trendr/core';

import { LeaderboardTable, type RankMove } from '@/components/leaderboard-table';
import { apiFetch, streamUrl as defaultStreamUrl } from '@/lib/api';
import { SCOPE_LABELS, WINDOW_LABELS } from '@/lib/constants';
import { formatUtcTime } from '@/lib/format';
import { StreamUpdateSchema, TrendingResponseSchema, type TrendingResponse } from '@/lib/schemas';
import { cn } from '@/lib/utils';

export interface LiveLeaderboardProps {
  initialData: TrendingResponse;
  refreshPath: string;
  scope: LeaderboardScope;
  window: Window;
  streamUrl?: string;
  fetcher?: (path: string) => Promise<TrendingResponse>;
  title?: string;
  subtitle?: string;
}

type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

const DEFAULT_FETCHER = (path: string) => apiFetch(path, TrendingResponseSchema);

export function LiveLeaderboard({
  initialData,
  refreshPath,
  scope,
  window,
  streamUrl,
  fetcher = DEFAULT_FETCHER,
  title,
  subtitle,
}: LiveLeaderboardProps) {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [rankMoves, setRankMoves] = useState<Record<string, RankMove | undefined>>({});
  const previousRanks = useRef(
    new Map(initialData.data.map((entry) => [entry.item.id, entry.rank])),
  );

  const { data, mutate } = useSWR<TrendingResponse>(refreshPath, fetcher, {
    fallbackData: initialData,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    refreshInterval: 0,
    keepPreviousData: true,
  });

  useEffect(() => {
    if (data === undefined) return;
    const moves: Record<string, RankMove | undefined> = {};
    for (const entry of data.data) {
      const previous = previousRanks.current.get(entry.item.id);
      if (previous !== undefined && previous !== entry.rank) {
        moves[entry.item.id] = entry.rank < previous ? 'up' : 'down';
      }
    }
    previousRanks.current = new Map(data.data.map((entry) => [entry.item.id, entry.rank]));
    setRankMoves(moves);
    if (Object.keys(moves).length === 0) return;
    const timer = setTimeout(() => {
      setRankMoves({});
    }, 1100);
    return () => {
      clearTimeout(timer);
    };
  }, [data]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      setStatus('offline');
      return;
    }

    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;
    const url = streamUrl ?? defaultStreamUrl(scope, window);

    const connect = () => {
      if (disposed) return;
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
      source = new EventSource(url);

      source.addEventListener('open', () => {
        attempt = 0;
        setStatus('live');
      });

      source.addEventListener('leaderboard.update', (event) => {
        if (!(event instanceof MessageEvent)) return;
        try {
          const parsed = StreamUpdateSchema.safeParse(JSON.parse(String(event.data)));
          if (!parsed.success) return;
          if (parsed.data.scope !== scope || parsed.data.window !== window) return;
        } catch {
          return;
        }
        void mutate();
      });

      source.addEventListener('error', () => {
        source?.close();
        source = null;
        if (disposed) return;
        setStatus('reconnecting');
        const delay = Math.min(30_000, 1_000 * 2 ** attempt) + Math.random() * 250;
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      });
    };

    connect();

    return () => {
      disposed = true;
      source?.close();
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [mutate, scope, streamUrl, window]);

  const board = data ?? initialData;
  const computedAt = board.computedAt;

  return (
    <section
      aria-labelledby="leaderboard-title"
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3.5">
        <div>
          <h2 id="leaderboard-title" className="text-[15px] font-semibold">
            {title ?? `Trending in ${SCOPE_LABELS[scope]}`}
          </h2>
          <p className="text-xs text-muted-foreground">
            {subtitle ?? `Last ${WINDOW_LABELS[window]} · ranked by velocity`} · updated{' '}
            {formatUtcTime(computedAt)}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5',
              status === 'live'
                ? 'border-emerald-500/30 text-emerald-700 dark:text-emerald-400'
                : 'border-border',
            )}
            title={status === 'live' ? 'Live stream connected' : 'Reconnecting to the live stream'}
          >
            <span className="relative flex size-1.5">
              {status === 'live' && (
                <span className="ping absolute inline-flex size-full rounded-full bg-emerald-500 opacity-75" />
              )}
              <span
                className={cn(
                  'relative inline-flex size-1.5 rounded-full',
                  status === 'live'
                    ? 'bg-emerald-500'
                    : status === 'reconnecting'
                      ? 'bg-amber-500'
                      : 'bg-muted-foreground/50',
                )}
              />
            </span>
            {status === 'live' ? 'Live' : status === 'reconnecting' ? 'Reconnecting' : 'Offline'}
          </span>
          <Radio aria-hidden="true" className="size-3.5 opacity-60" />
        </div>
      </div>
      <LeaderboardTable entries={board.data} scope={scope} window={window} rankMoves={rankMoves} />
      <div className="flex items-center justify-between border-t border-border bg-muted/20 px-4 py-2.5 text-[11px] text-muted-foreground">
        <span>Scores are normalized within each source · run {board.runId.slice(0, 8)}</span>
        <span className="hidden sm:inline">Streaming updates without a refresh</span>
      </div>
    </section>
  );
}
