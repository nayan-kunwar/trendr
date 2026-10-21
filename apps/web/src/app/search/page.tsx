import { Search, SlidersHorizontal, Sparkles } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ItemKind, Source } from '@trendr/core';

import { ItemSummaryRow } from '@/components/item-summary-row';
import { SourceBadge } from '@/components/source-badge';
import { Button } from '@/components/ui/button';
import { buildQuery, safeApiFetch } from '@/lib/api';
import { topicLabel } from '@/lib/format';
import { KIND_OPTIONS, SCOPE_LABELS, SOURCES } from '@/lib/constants';
import { SearchResponseSchema, TopicsResponseSchema } from '@/lib/schemas';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Search',
  description: 'Search every GitHub repo, package, model, paper and MCP server indexed by Trendr.',
  robots: { index: false, follow: true },
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

interface SearchPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const query = await searchParams;
  const q = first(query.q)?.trim() ?? '';
  const rawSource = first(query.source)?.toLowerCase();
  const source = isSource(rawSource) ? rawSource : undefined;
  const rawKind = first(query.kind);
  const kind = isKind(rawKind) ? rawKind : undefined;
  const cursor = first(query.cursor);
  const canSearch = q.length >= 2 && q.length <= 100;

  const [results, topics] = await Promise.all([
    canSearch
      ? safeApiFetch(
          `/v1/search${buildQuery({ q, source, kind, limit: 30, cursor })}`,
          SearchResponseSchema,
          { next: { revalidate: 60 } },
        )
      : Promise.resolve(null),
    safeApiFetch('/v1/topics?limit=18', TopicsResponseSchema, {
      next: { revalidate: 300 },
    }),
  ]);

  return (
    <main className="mx-auto max-w-[1050px] px-4 py-8 sm:px-6">
      <div className="flex flex-col items-start gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground">
          <Search aria-hidden="true" className="size-3" />
          Search the index
        </span>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Find anything in the ecosystem
        </h1>
        <p className="max-w-xl text-sm text-muted-foreground">
          Full-text and fuzzy search across all six sources. Open a result for metric history, rank
          and score breakdown.
        </p>
      </div>

      <form
        action="/search"
        className="mt-6 rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4"
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="relative block flex-1">
            <span className="sr-only">Search query</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              name="q"
              defaultValue={q}
              minLength={2}
              maxLength={100}
              required
              autoFocus={q.length === 0}
              placeholder="Search repos, packages, models, papers…"
              className="h-10 w-full rounded-md border border-border bg-background pr-3 pl-9 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
            />
          </label>
          <div className="flex gap-2">
            <label className="sr-only" htmlFor="search-source">
              Source
            </label>
            <select
              id="search-source"
              name="source"
              defaultValue={source ?? ''}
              className="h-10 min-w-[120px] rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">All sources</option>
              {SOURCES.map((item) => (
                <option key={item} value={item}>
                  {SCOPE_LABELS[item]}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="search-kind">
              Kind
            </label>
            <select
              id="search-kind"
              name="kind"
              defaultValue={kind ?? ''}
              className="h-10 min-w-[110px] rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">All kinds</option>
              {KIND_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
            <Button type="submit" className="h-10">
              <Search aria-hidden="true" />
              Search
            </Button>
          </div>
        </div>
        {(source !== undefined || kind !== undefined) && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            <SlidersHorizontal aria-hidden="true" className="size-3" />
            Filtered by {source !== undefined ? SCOPE_LABELS[source] : 'all sources'}
            {kind !== undefined ? ` · ${kind.replaceAll('_', ' ')}` : ''}
            <Link
              href={`/search?q=${encodeURIComponent(q)}`}
              className="underline-offset-2 hover:underline"
            >
              Clear filters
            </Link>
          </div>
        )}
      </form>

      {!canSearch ? (
        <section className="mt-6 rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <Sparkles aria-hidden="true" className="size-4 text-emerald-500" />
            <h2 className="text-sm font-semibold">Try one of the fast-moving topics</h2>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {(topics?.topics ?? []).map((topic) => (
              <Link
                key={topic.slug}
                href={`/topics/${topic.slug}`}
                className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                {topicLabel(topic.slug)}
                <span className="ml-1 font-mono text-[10px] opacity-60">{topic.itemCount}</span>
              </Link>
            ))}
          </div>
          <p className="mt-4 text-[11px] text-muted-foreground">
            Queries need at least two characters. Search falls back to fuzzy matching when exact
            terms are sparse.
          </p>
        </section>
      ) : results === null ? (
        <div className="mt-6 rounded-xl border border-dashed border-border px-6 py-12 text-center">
          <p className="text-sm font-medium">Search is unavailable</p>
          <p className="mt-1 text-xs text-muted-foreground">The API did not answer this query.</p>
        </div>
      ) : (
        <section className="mt-6" aria-labelledby="results-title">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="results-title" className="text-sm font-semibold">
              {results.items.length === 0 ? 'No results' : `${results.items.length} results`}
              <span className="ml-2 font-normal text-muted-foreground">for “{q}”</span>
            </h2>
            <span className="text-[11px] text-muted-foreground">
              {results.page.nextCursor === null ? 'end of results' : 'more available'}
            </span>
          </div>
          {results.items.length === 0 ? (
            <div className="mt-3 rounded-xl border border-border bg-card px-6 py-12 text-center shadow-sm">
              <p className="text-sm font-medium">Nothing matched that query</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Try a shorter term, drop the filters, or search by the project&apos;s package name.
              </p>
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              {SOURCES.map((groupSource) => {
                const items = results.items.filter((item) => item.source === groupSource);
                if (items.length === 0) return null;
                return (
                  <section
                    key={groupSource}
                    className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
                    aria-labelledby={`search-group-${groupSource}`}
                  >
                    <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/25 px-4 py-2">
                      <h3
                        id={`search-group-${groupSource}`}
                        className="flex items-center gap-2 text-xs font-semibold"
                      >
                        <SourceBadge source={groupSource} />
                      </h3>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {items.length} {items.length === 1 ? 'match' : 'matches'}
                      </span>
                    </div>
                    <ul className="divide-y divide-border">
                      {items.map((item) => (
                        <ItemSummaryRow key={item.id} item={item} />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
          {results.page.nextCursor !== null && (
            <div className="mt-4 flex justify-center">
              <Button asChild variant="outline" size="sm">
                <Link
                  href={`/search${buildQuery({ q, source, kind, cursor: results.page.nextCursor })}`}
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
