import { ArrowDownRight, ArrowUpRight, Star } from 'lucide-react';
import Link from 'next/link';

import type { LeaderboardScope, Window } from '@trendr/core';

import { SourceBadge } from '@/components/source-badge';
import { Sparkline } from '@/components/sparkline';
import { Badge } from '@/components/ui/badge';
import { METRIC_LABELS, WINDOW_SHORT_LABELS } from '@/lib/constants';
import {
  formatCompact,
  formatGrowth,
  formatPercent,
  formatRelGrowth,
  formatScore,
  itemHref,
} from '@/lib/format';
import type { LeaderboardEntry } from '@/lib/schemas';
import { cn } from '@/lib/utils';

export type RankMove = 'up' | 'down';

export interface LeaderboardTableProps {
  entries: LeaderboardEntry[];
  scope: LeaderboardScope;
  window: Window;
  rankMoves?: Readonly<Record<string, RankMove | undefined>>;
  emptyMessage?: string;
}

function rankClass(rank: number): string {
  if (rank === 1) return 'text-amber-500 dark:text-amber-400';
  if (rank === 2) return 'text-zinc-500 dark:text-zinc-300';
  if (rank === 3) return 'text-orange-700 dark:text-orange-400';
  return 'text-muted-foreground';
}

export function LeaderboardTable({
  entries,
  scope,
  window,
  rankMoves = {},
  emptyMessage = 'No items match these filters yet.',
}: LeaderboardTableProps) {
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
        <p className="text-sm font-medium">Nothing on this board yet</p>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">{emptyMessage}</p>
        <Link
          href="/trending/all/24h"
          className="mt-4 text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400"
        >
          Reset to the combined board
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div
        className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border bg-muted/30 px-4 py-2 text-[10px] font-medium tracking-wider text-muted-foreground uppercase sm:grid-cols-[48px_minmax(0,1fr)_88px_112px_40px] md:grid-cols-[52px_minmax(0,1fr)_92px_116px_104px_96px_40px]"
        aria-hidden="true"
      >
        <span>Rank</span>
        <span>Project</span>
        <span className="hidden text-right sm:block">Total</span>
        <span className="text-right">Δ {WINDOW_SHORT_LABELS[window]}</span>
        <span className="hidden text-center md:block">Trend 30d</span>
        <span className="hidden sm:block">Velocity</span>
        <span className="hidden text-right md:block">Watch</span>
      </div>
      <ol>
        {entries.map((entry) => {
          const move = rankMoves[entry.item.id];
          const isNew = entry.flags.includes('new_item');
          const burst = entry.flags.includes('burst_suspected');
          const positive = entry.delta >= 0;
          return (
            <li
              key={entry.item.id}
              data-testid="leaderboard-row"
              data-item-id={entry.item.id}
              className={cn(
                'group grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border px-4 py-3.5 transition-colors first:border-t-0 hover:bg-accent/60 sm:grid-cols-[48px_minmax(0,1fr)_88px_112px_40px] md:grid-cols-[52px_minmax(0,1fr)_92px_116px_104px_96px_40px]',
                move === 'up' && 'rank-up',
                move === 'down' && 'rank-down',
              )}
            >
              <div className="flex flex-col items-start gap-0.5">
                <span
                  className={cn(
                    'font-mono text-[15px] font-semibold tabular-nums',
                    rankClass(entry.rank),
                  )}
                >
                  {String(entry.rank).padStart(2, '0')}
                </span>
                {isNew ? (
                  <span className="rounded bg-sky-500/15 px-1 text-[9px] font-semibold tracking-wide text-sky-600 uppercase dark:text-sky-400">
                    new
                  </span>
                ) : move !== undefined ? (
                  <span
                    className={cn(
                      'inline-flex items-center text-[10px] font-medium',
                      move === 'up'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-rose-600 dark:text-rose-400',
                    )}
                  >
                    {move === 'up' ? (
                      <ArrowUpRight aria-hidden="true" className="size-2.5" />
                    ) : (
                      <ArrowDownRight aria-hidden="true" className="size-2.5" />
                    )}
                  </span>
                ) : null}
              </div>

              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <SourceBadge source={entry.item.source} className="hidden sm:inline-flex" />
                  <Link
                    href={itemHref({ id: entry.item.id, displayName: entry.item.displayName })}
                    className="min-w-0 truncate font-semibold text-foreground hover:underline"
                  >
                    {entry.item.displayName}
                  </Link>
                  {burst && (
                    <Badge variant="amber" className="hidden shrink-0 sm:inline-flex">
                      burst
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                  {entry.item.description ??
                    `${entry.item.kind.replaceAll('_', ' ')} on ${entry.item.source}`}
                </p>
                <div className="mt-1.5 flex items-center gap-1.5 overflow-hidden">
                  {entry.item.language !== null && (
                    <span className="mr-0.5 inline-flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="size-2 rounded-full bg-muted-foreground/50" />
                      {entry.item.language}
                    </span>
                  )}
                  {entry.item.topics.slice(0, 2).map((topic) => (
                    <span
                      key={topic}
                      className="hidden shrink-0 rounded-full border border-border bg-muted/60 px-2 py-px text-[10.5px] text-muted-foreground sm:inline"
                    >
                      {topic}
                    </span>
                  ))}
                  <span className="truncate text-[10.5px] text-muted-foreground sm:hidden">
                    {entry.item.source}
                  </span>
                </div>
              </div>

              <div className="hidden text-right sm:block">
                <div className="font-mono text-[13px] font-medium tabular-nums">
                  {formatCompact(entry.current)}
                </div>
                <div className="text-[10.5px] text-muted-foreground">
                  {METRIC_LABELS[entry.item.primaryMetric].toLowerCase()}
                </div>
              </div>

              <div className="text-right">
                <div
                  className={cn(
                    'font-mono text-[13px] font-semibold tabular-nums',
                    positive
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-rose-600 dark:text-rose-400',
                  )}
                >
                  {formatGrowth(entry.delta)}
                </div>
                <div className="text-[10.5px] text-muted-foreground">
                  <span className={positive ? 'text-emerald-600/90 dark:text-emerald-400/90' : ''}>
                    {formatRelGrowth(entry.relGrowth)}
                  </span>{' '}
                  / {WINDOW_SHORT_LABELS[window]}
                </div>
              </div>

              <div className="hidden justify-center md:flex">
                <Sparkline values={entry.sparkline} />
              </div>

              <div className="hidden sm:block">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[13px] font-semibold tabular-nums">
                    {formatScore(entry.score)}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    p{formatPercent(entry.percentile / 100).replace('%', '')}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-lime-400"
                    style={{ width: `${Math.max(2, Math.min(100, entry.percentile))}%` }}
                  />
                </div>
              </div>

              <div className="hidden justify-end md:flex">
                <button
                  type="button"
                  disabled
                  aria-label={`Watch ${entry.item.displayName} (available with accounts)`}
                  title="Watchlists arrive with accounts"
                  className="inline-flex size-8 cursor-not-allowed items-center justify-center rounded-md border border-border text-muted-foreground opacity-60"
                >
                  <Star aria-hidden="true" className="size-4" />
                </button>
              </div>
              <span className="sr-only">{scope !== 'all' ? scope : 'all sources'}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
