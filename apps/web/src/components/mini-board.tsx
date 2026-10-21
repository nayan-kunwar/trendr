import { ArrowRight, ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import type { LeaderboardScope, Window } from '@trendr/core';

import { ScopeBadge } from '@/components/source-badge';
import { Sparkline } from '@/components/sparkline';
import { SCOPE_LABELS, WINDOW_SHORT_LABELS } from '@/lib/constants';
import { formatGrowth, itemHref, truncate } from '@/lib/format';
import type { TrendingResponse } from '@/lib/schemas';
import { cn } from '@/lib/utils';

export function MiniBoard({
  board,
  scope,
  window,
  title,
  className,
}: {
  board: TrendingResponse | null;
  scope: LeaderboardScope;
  window: Window;
  title: string;
  className?: string;
}) {
  return (
    <section className={cn('rounded-xl border border-border bg-card shadow-sm', className)}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-[13px] font-semibold">{title}</h2>
          <p className="text-[11px] text-muted-foreground">
            {SCOPE_LABELS[scope]} · {WINDOW_SHORT_LABELS[window]}
          </p>
        </div>
        <Link
          href={`/trending/${scope}/${window}`}
          aria-label={`Open the ${SCOPE_LABELS[scope]} leaderboard`}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      </div>
      {board === null || board.data.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-muted-foreground">
          No live board for this source yet.
        </p>
      ) : (
        <ol className="divide-y divide-border">
          {board.data.slice(0, 5).map((entry) => (
            <li key={entry.item.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-4 shrink-0 font-mono text-[11px] font-semibold text-muted-foreground">
                {String(entry.rank).padStart(2, '0')}
              </span>
              <div className="min-w-0 flex-1">
                <Link
                  href={itemHref({ id: entry.item.id, displayName: entry.item.displayName })}
                  className="block truncate text-xs font-medium hover:underline"
                  title={entry.item.displayName}
                >
                  {truncate(entry.item.displayName, 34)}
                </Link>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <ScopeBadge scope={entry.item.source} className="px-1 py-0 text-[9px]" />
                  <span className="truncate text-[10px] text-muted-foreground">
                    {entry.item.language ?? entry.item.kind.replaceAll('_', ' ')}
                  </span>
                </div>
              </div>
              <Sparkline values={entry.sparkline} width={46} height={18} showArea={false} />
              <span
                className={cn(
                  'w-12 shrink-0 text-right font-mono text-[10.5px] font-medium tabular-nums',
                  entry.delta >= 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-rose-600 dark:text-rose-400',
                )}
              >
                {formatGrowth(entry.delta)}
              </span>
            </li>
          ))}
        </ol>
      )}
      <Link
        href={`/trending/${scope}/${window}`}
        className="flex items-center justify-center gap-1 border-t border-border px-4 py-2 text-[11px] font-medium text-muted-foreground hover:text-foreground"
      >
        Full board <ArrowUpRight aria-hidden="true" className="size-3" />
      </Link>
    </section>
  );
}
