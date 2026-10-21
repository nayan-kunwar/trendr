import { ArrowUpRight, GitCompare, Info } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { Window } from '@trendr/core';

import { CompareChart } from '@/components/charts/compare-chart';
import { ComparePicker, type CompareCandidate } from '@/components/compare-picker';
import { SourceBadge } from '@/components/source-badge';
import { buildQuery, leaderboardPath, safeApiFetch } from '@/lib/api';
import { METRIC_LABELS, WINDOW_LABELS } from '@/lib/constants';
import { formatDecimal, formatGrowth, formatRelGrowth, itemHref } from '@/lib/format';
import { isItemId } from '@/lib/item-data';
import { isWindow } from '@/lib/leaderboard';
import { CompareResponseSchema, TrendingResponseSchema, type CompareResponse } from '@/lib/schemas';
import type { Metric } from '@trendr/core';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Compare items',
  description: 'Put two to five Trendr items side by side and compare growth trajectories.',
  robots: { index: false, follow: true },
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isMetric(value: string | undefined): value is Metric {
  return value !== undefined && Object.hasOwn(METRIC_LABELS, value);
}

interface ComparePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ComparePage({ searchParams }: ComparePageProps) {
  const query = await searchParams;
  const rawIds = (first(query.ids) ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const uniqueIds = [...new Set(rawIds)];
  const idsValid =
    uniqueIds.length >= 2 && uniqueIds.length <= 5 && uniqueIds.every((id) => isItemId(id));
  const window: Window = (() => {
    const value = first(query.window);
    return value !== undefined && isWindow(value) ? value : '7d';
  })();
  const rawMetric = first(query.metric);
  const metric = isMetric(rawMetric) ? rawMetric : undefined;

  const [compare, board] = await Promise.all([
    idsValid
      ? safeApiFetch(
          `/v1/compare${buildQuery({ ids: uniqueIds.join(','), window, metric })}`,
          CompareResponseSchema,
          { next: { revalidate: 60 } },
        )
      : Promise.resolve(null),
    safeApiFetch(
      leaderboardPath({ scope: 'all', window: '7d', limit: 12 }),
      TrendingResponseSchema,
      { next: { revalidate: 60 } },
    ),
  ]);

  const candidates = new Map<string, CompareCandidate>();
  for (const entry of board?.data ?? []) {
    candidates.set(entry.item.id, {
      id: entry.item.id,
      displayName: entry.item.displayName,
      source: entry.item.source,
    });
  }
  for (const item of compare?.items ?? []) {
    if (!candidates.has(item.id)) {
      candidates.set(item.id, {
        id: item.id,
        displayName: item.displayName,
        source: item.source,
      });
    }
  }

  return (
    <main className="mx-auto max-w-[1150px] px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground">
            <GitCompare aria-hidden="true" className="size-3" />
            Side by side
          </span>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
            Compare growth trajectories
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Pick two to five items. The chart indexes each series to its first observed value, so a
            package and a repository can share a scale without pretending their metrics are equal.
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-[11px] text-muted-foreground shadow-sm">
          Window: <span className="font-medium text-foreground">{WINDOW_LABELS[window]}</span>
        </div>
      </div>

      <div className="mt-6 grid gap-5 xl:grid-cols-[400px_minmax(0,1fr)]">
        <div className="space-y-4">
          <ComparePicker
            candidates={[...candidates.values()]}
            selected={uniqueIds}
            window={window}
          />
          {!idsValid && uniqueIds.length > 0 && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-[11px] text-rose-700 dark:text-rose-300">
              Choose between 2 and 5 valid numeric item IDs. Duplicates are ignored.
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-5">
          {!idsValid ? (
            <div className="flex min-h-[360px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 px-6 text-center">
              <GitCompare aria-hidden="true" className="size-7 text-muted-foreground/60" />
              <p className="mt-3 text-sm font-medium">Nothing selected yet</p>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                Tick at least two items on the left, then choose a window and press Compare.
              </p>
            </div>
          ) : compare === null ? (
            <div className="flex min-h-[360px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 px-6 text-center">
              <p className="text-sm font-medium">Comparison unavailable</p>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                The API could not build a comparison for these IDs in this window.
              </p>
            </div>
          ) : (
            <>
              <CompareChart compare={compare} />
              <CompareTable compare={compare} />
            </>
          )}

          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-[10.5px] text-muted-foreground">
            <Info aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
            <p>
              Growth is not additive across sources. Use the raw toggle for same-source comparisons
              and the indexed view for mixed sources. Percentiles are always within the item&apos;s
              own source window.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

function CompareTable({ compare }: { compare: CompareResponse }) {
  return (
    <section
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
      aria-labelledby="compare-table-title"
    >
      <div className="border-b border-border px-4 py-3">
        <h2 id="compare-table-title" className="text-sm font-semibold">
          Current standing
        </h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Scores and ranks come from the {compare.window} run.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-[11.5px]">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-4 py-2 font-medium">
                Item
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                Delta
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                Relative
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                Percentile
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                Source rank
              </th>
              <th scope="col" className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {compare.items.map((item) => (
              <tr key={item.id} className="hover:bg-accent/40">
                <td className="max-w-[280px] px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <SourceBadge source={item.source} />
                    <Link
                      href={itemHref({ id: item.id, displayName: item.displayName })}
                      className="truncate font-medium hover:underline"
                    >
                      {item.displayName}
                    </Link>
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {item.kind.replaceAll('_', ' ')}
                  </span>
                </td>
                <td
                  className={
                    item.delta !== null && item.delta < 0
                      ? 'px-2 py-2.5 text-right font-mono text-rose-600 tabular-nums dark:text-rose-400'
                      : 'px-2 py-2.5 text-right font-mono text-emerald-600 tabular-nums dark:text-emerald-400'
                  }
                >
                  {item.delta === null ? '—' : formatGrowth(item.delta)}
                </td>
                <td className="px-2 py-2.5 text-right font-mono tabular-nums">
                  {item.relGrowth === null ? '—' : formatRelGrowth(item.relGrowth)}
                </td>
                <td className="px-2 py-2.5 text-right font-mono tabular-nums">
                  {item.percentile === null ? '—' : `p${formatDecimal(item.percentile)}`}
                </td>
                <td className="px-2 py-2.5 text-right font-mono tabular-nums">
                  {item.rankSource === null ? '—' : `#${item.rankSource}`}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label={`Open ${item.displayName} on the source`}
                    className="inline-flex text-muted-foreground hover:text-foreground"
                  >
                    <ArrowUpRight aria-hidden="true" className="size-3.5" />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
