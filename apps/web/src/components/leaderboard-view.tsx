import { ChevronRight, ExternalLink } from 'lucide-react';
import Link from 'next/link';

import { FilterBar } from '@/components/filter-bar';
import { JsonLd } from '@/components/json-ld';
import { LiveLeaderboard } from '@/components/live-leaderboard';
import { SourceBadge } from '@/components/source-badge';
import { leaderboardPath } from '@/lib/api';
import { itemHref } from '@/lib/format';
import { absoluteUrl } from '@/lib/site';
import { SCOPE_LABELS, SCOPES, SOURCE_TAGLINES, WINDOW_LABELS } from '@/lib/constants';
import type { LeaderboardParams } from '@/lib/leaderboard';
import type { LanguagesResponse, TopicsResponse, TrendingResponse } from '@/lib/schemas';

export function LeaderboardView({
  params,
  board,
  topics,
  languages,
}: {
  params: LeaderboardParams;
  board: TrendingResponse | null;
  topics: TopicsResponse['topics'];
  languages: LanguagesResponse['languages'];
}) {
  const { scope, window, lang, topic, kind, newOnly } = params;
  const refreshPath = leaderboardPath({
    scope,
    window,
    lang,
    topic,
    kind,
    newOnly,
    limit: 100,
  });

  const languageOptions =
    lang !== undefined && !languages.some((item) => item.slug === lang)
      ? [{ language: lang, slug: lang, itemCount: 0 }, ...languages]
      : languages;
  const topicOptions =
    topic !== undefined && !topics.some((item) => item.slug === topic)
      ? [{ slug: topic, name: topic, itemCount: 0 }, ...topics]
      : topics;

  const subtitle =
    scope === 'all'
      ? 'Cross-source velocity z-score · normalized within each source'
      : SOURCE_TAGLINES[scope];

  const listJsonLd =
    board === null
      ? null
      : {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          name: `${SCOPE_LABELS[scope]} trending — ${WINDOW_LABELS[window]}`,
          url: absoluteUrl(`/trending/${scope}/${window}`),
          numberOfItems: board.data.length,
          itemListElement: board.data.map((entry) => ({
            '@type': 'ListItem',
            position: entry.rank,
            name: entry.item.displayName,
            url: absoluteUrl(itemHref({ id: entry.item.id, displayName: entry.item.displayName })),
          })),
        };

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 sm:py-8">
      {listJsonLd !== null && <JsonLd data={listJsonLd} />}
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1 text-[11px] text-muted-foreground"
      >
        <Link href="/" className="hover:text-foreground">
          Home
        </Link>
        <ChevronRight aria-hidden="true" className="size-3" />
        <Link href="/trending/all/24h" className="hover:text-foreground">
          Leaderboards
        </Link>
        <ChevronRight aria-hidden="true" className="size-3" />
        <span className="text-foreground">{SCOPE_LABELS[scope]}</span>
      </nav>

      <div className="mt-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {scope === 'all' ? 'All sources' : SCOPE_LABELS[scope]} leaderboard
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="rounded-full border border-border bg-card px-2 py-1">
            Window: {WINDOW_LABELS[window]}
          </span>
          {lang !== undefined && (
            <span className="rounded-full border border-border bg-card px-2 py-1">lang:{lang}</span>
          )}
          {topic !== undefined && (
            <span className="rounded-full border border-border bg-card px-2 py-1">
              topic:{topic}
            </span>
          )}
          {kind !== undefined && (
            <span className="rounded-full border border-border bg-card px-2 py-1">
              {kind.replaceAll('_', ' ')}
            </span>
          )}
          {newOnly && (
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-400">
              new only
            </span>
          )}
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_288px]">
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <FilterBar
            scope={scope}
            window={window}
            lang={lang}
            topic={topic}
            kind={kind}
            newOnly={newOnly}
            languages={languageOptions}
            topics={topicOptions}
          />
          {board === null ? (
            <div className="px-6 py-16 text-center">
              <p className="text-sm font-medium">This board is unavailable</p>
              <p className="mt-1 text-xs text-muted-foreground">
                The API did not respond. Try again in a moment.
              </p>
            </div>
          ) : (
            <div className="p-3 sm:p-4">
              <LiveLeaderboard
                initialData={board}
                refreshPath={refreshPath}
                scope={scope}
                window={window}
                title={`${SCOPE_LABELS[scope]} · ${WINDOW_LABELS[window]}`}
                subtitle={subtitle}
              />
            </div>
          )}
        </div>

        <aside className="space-y-4">
          <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h2 className="text-xs font-semibold">Other boards</h2>
            <ul className="mt-3 space-y-1.5">
              {SCOPES.filter((item) => item !== scope).map((item) => (
                <li key={item}>
                  <Link
                    href={`/trending/${item}/${window}`}
                    className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <span className="flex items-center gap-2">
                      {item === 'all' ? (
                        <span className="size-1.5 rounded-full bg-emerald-500" />
                      ) : (
                        <SourceBadge source={item} className="px-1 py-0 text-[9px]" />
                      )}
                      {SCOPE_LABELS[item]}
                    </span>
                    <span className="font-mono text-[10px]">{window}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h2 className="text-xs font-semibold">How this board is ordered</h2>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              {scope === 'all'
                ? 'Each item keeps its source-normalized z-score. The combined board ranks that z-score, so a small ecosystem can outrank a large one when its growth is statistically exceptional.'
                : 'The board ranks final velocity scores within this source for the selected window. Raw totals are shown for context, not used as the ranking.'}
            </p>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              Percentiles are computed against every eligible item in the same source and window.
            </p>
          </section>

          <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h2 className="text-xs font-semibold">Search this data</h2>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              Use search for a project that is not on the board, or open an item to inspect its
              metric history and score breakdown.
            </p>
            <Link
              href="/search"
              className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 hover:underline dark:text-emerald-400"
            >
              Search all items <ExternalLink aria-hidden="true" className="size-3" />
            </Link>
          </section>
        </aside>
      </div>
    </main>
  );
}
