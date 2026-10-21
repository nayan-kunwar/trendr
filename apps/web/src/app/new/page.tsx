import { CalendarClock, Rocket } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ItemKind, Source } from '@trendr/core';

import { ItemSummaryRow } from '@/components/item-summary-row';
import { Button } from '@/components/ui/button';
import { buildQuery, safeApiFetch } from '@/lib/api';
import { formatUtcDate, itemHref } from '@/lib/format';
import { KIND_OPTIONS, SCOPE_LABELS, SOURCES } from '@/lib/constants';
import { NewResponseSchema } from '@/lib/schemas';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'New this week',
  description:
    'The newest projects, packages, models, papers and MCP servers discovered by Trendr.',
  alternates: { canonical: '/new' },
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isSource(value: string | undefined): value is Source {
  return value !== undefined && (SOURCES as readonly string[]).includes(value);
}

function isKind(value: string | undefined): value is ItemKind {
  return KIND_OPTIONS.some((option) => option.value === value);
}

interface NewPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function NewPage({ searchParams }: NewPageProps) {
  const query = await searchParams;
  const rawSource = first(query.source)?.toLowerCase();
  const source = isSource(rawSource) ? rawSource : undefined;
  const rawKind = first(query.kind);
  const kind = isKind(rawKind) ? rawKind : undefined;
  const rawDays = Number(first(query.days) ?? 7);
  const days = Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= 30 ? rawDays : 7;
  const cursor = first(query.cursor);

  const [results, mcpNew] = await Promise.all([
    safeApiFetch(`/v1/new${buildQuery({ source, kind, days, cursor })}`, NewResponseSchema, {
      next: { revalidate: 60 },
    }),
    source === undefined
      ? safeApiFetch(`/v1/new${buildQuery({ source: 'mcp', days, limit: 6 })}`, NewResponseSchema, {
          next: { revalidate: 60 },
        })
      : Promise.resolve(null),
  ]);

  return (
    <main className="mx-auto max-w-[1050px] px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/8 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
            <Rocket aria-hidden="true" className="size-3" />
            Fresh discoveries
          </span>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
            New in the last {days} {days === 1 ? 'day' : 'days'}
          </h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Items whose upstream creation date falls inside the window, newest first. A new item can
            be small — that is the point.
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-[11px] text-muted-foreground shadow-sm">
          <span className="flex items-center gap-1.5">
            <CalendarClock aria-hidden="true" className="size-3" />
            Fixed 50-item pages
          </span>
        </div>
      </div>

      <nav aria-label="New-item filters" className="mt-5 flex flex-wrap items-center gap-1">
        <Link
          href={`/new${buildQuery({ days, kind })}`}
          aria-current={source === undefined ? 'page' : undefined}
          className={
            source === undefined
              ? 'rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium text-foreground'
              : 'rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground'
          }
        >
          All sources
        </Link>
        {SOURCES.map((item) => (
          <Link
            key={item}
            href={`/new${buildQuery({ source: item, days, kind })}`}
            aria-current={source === item ? 'page' : undefined}
            className={
              source === item
                ? 'rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium text-foreground'
                : 'rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground'
            }
          >
            {SCOPE_LABELS[item]}
          </Link>
        ))}
      </nav>

      <form
        action="/new"
        className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-3 shadow-sm"
      >
        <label className="text-[10.5px] text-muted-foreground">
          <span className="mb-1 block">Window</span>
          <select
            name="days"
            defaultValue={days}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
          >
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
          </select>
        </label>
        <label className="text-[10.5px] text-muted-foreground">
          <span className="mb-1 block">Kind</span>
          <select
            name="kind"
            defaultValue={kind ?? ''}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All kinds</option>
            {KIND_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {source !== undefined && <input type="hidden" name="source" value={source} />}
        <Button type="submit" variant="outline" size="sm">
          Apply
        </Button>
      </form>

      {source === undefined && mcpNew !== null && mcpNew.items.length > 0 && (
        <section
          className="mt-5 overflow-hidden rounded-xl border border-violet-500/25 bg-card shadow-sm"
          aria-labelledby="new-mcp-title"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-violet-500/5 px-4 py-3">
            <div>
              <h2 id="new-mcp-title" className="flex items-center gap-1.5 text-sm font-semibold">
                <Rocket aria-hidden="true" className="size-3.5 text-violet-500" />
                New in MCP
              </h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Registry servers discovered in the last {days} {days === 1 ? 'day' : 'days'}.
              </p>
            </div>
            <Link
              href={`/new${buildQuery({ source: 'mcp', days })}`}
              className="text-[11px] font-medium text-violet-600 hover:underline dark:text-violet-400"
            >
              See all MCP arrivals →
            </Link>
          </div>
          <ul className="grid divide-y divide-border sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-3">
            {mcpNew.items.slice(0, 6).map((item) => (
              <li key={item.id} className="border-b border-border p-3 last:border-b-0">
                <Link
                  href={itemHref({ id: item.id, displayName: item.name })}
                  className="text-xs font-semibold hover:underline"
                >
                  {item.name}
                </Link>
                <p className="mt-1 line-clamp-2 text-[10.5px] leading-relaxed text-muted-foreground">
                  {item.description ?? 'No description provided.'}
                </p>
                <p className="mt-1.5 font-mono text-[9.5px] text-muted-foreground">
                  {item.kind.replaceAll('_', ' ')}
                  {item.upstreamCreatedAt === null
                    ? ''
                    : ` · ${formatUtcDate(item.upstreamCreatedAt)}`}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {results === null ? (
        <div className="mt-5 rounded-xl border border-dashed border-border px-6 py-12 text-center">
          <p className="text-sm font-medium">The new-items feed is unavailable</p>
          <p className="mt-1 text-xs text-muted-foreground">Try again in a moment.</p>
        </div>
      ) : results.items.length === 0 ? (
        <div className="mt-5 rounded-xl border border-border bg-card px-6 py-12 text-center shadow-sm">
          <p className="text-sm font-medium">No discoveries in this window</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Try a longer window or remove the kind filter.
          </p>
        </div>
      ) : (
        <section className="mt-5" aria-labelledby="new-results-title">
          <div className="flex items-baseline justify-between">
            <h2 id="new-results-title" className="text-sm font-semibold">
              {results.items.length} recent items
            </h2>
            <span className="text-[11px] text-muted-foreground">
              {results.page.nextCursor === null ? 'end of results' : 'more available'}
            </span>
          </div>
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            {results.items.map((item) => (
              <ItemSummaryRow key={item.id} item={item} />
            ))}
          </ul>
          {results.page.nextCursor !== null && (
            <div className="mt-4 flex justify-center">
              <Button asChild variant="outline" size="sm">
                <Link
                  href={`/new${buildQuery({
                    source,
                    kind,
                    days,
                    cursor: results.page.nextCursor,
                  })}`}
                >
                  Next page
                </Link>
              </Button>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
