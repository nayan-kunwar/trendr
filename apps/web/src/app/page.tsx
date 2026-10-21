import { Activity, ArrowRight, Clock3, Database, Globe2, Sparkles } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { FilterBar } from '@/components/filter-bar';
import { JsonLd } from '@/components/json-ld';
import { LiveLeaderboard } from '@/components/live-leaderboard';
import { MiniBoard } from '@/components/mini-board';
import { Button } from '@/components/ui/button';
import { leaderboardPath, safeApiFetch } from '@/lib/api';
import { formatInteger, formatUtcDate, formatUtcTime } from '@/lib/format';
import { SITE_URL } from '@/lib/site';
import {
  LanguagesResponseSchema,
  StatsResponseSchema,
  TopicsResponseSchema,
  TrendingResponseSchema,
} from '@/lib/schemas';

// The web image is built before the API container exists, so data pages render
// on request instead of prerendering an empty board. API-side Redis caching is
// the read cache; the fetch hints keep the spec's 60 s freshness intent.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Trendr — What developers are building right now',
  description:
    'The cross-source leaderboard for GitHub repos, npm and PyPI packages, Hugging Face models, arXiv papers and MCP servers — ranked by growth velocity.',
  alternates: { canonical: '/' },
};

export default async function HomePage() {
  const allPath = leaderboardPath({ scope: 'all', window: '24h', limit: 12 });
  const [board, mcp, huggingface, arxiv, stats, topics, languages] = await Promise.all([
    safeApiFetch(allPath, TrendingResponseSchema, { next: { revalidate: 60 } }),
    safeApiFetch(
      leaderboardPath({ scope: 'mcp', window: '7d', limit: 5 }),
      TrendingResponseSchema,
      {
        next: { revalidate: 60 },
      },
    ),
    safeApiFetch(
      leaderboardPath({ scope: 'huggingface', window: '24h', limit: 5 }),
      TrendingResponseSchema,
      { next: { revalidate: 60 } },
    ),
    safeApiFetch(
      leaderboardPath({ scope: 'arxiv', window: '7d', limit: 5 }),
      TrendingResponseSchema,
      { next: { revalidate: 60 } },
    ),
    safeApiFetch('/v1/stats', StatsResponseSchema, { next: { revalidate: 60 } }),
    safeApiFetch('/v1/topics?limit=100', TopicsResponseSchema, { next: { revalidate: 300 } }),
    safeApiFetch('/v1/languages', LanguagesResponseSchema, { next: { revalidate: 300 } }),
  ]);

  const totalItems =
    stats === null ? null : Object.values(stats.items).reduce((sum, n) => sum + n, 0);
  const lastRun = stats?.runs
    .map((run) => run.lastSuccessAt)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];

  const websiteJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Trendr',
    url: SITE_URL,
    description: 'Cross-source growth rankings for GitHub, npm, PyPI, Hugging Face, arXiv and MCP.',
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${SITE_URL}/search?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  };

  return (
    <main>
      <JsonLd data={websiteJsonLd} />
      <section className="relative overflow-hidden border-b border-border">
        <div
          className="pointer-events-none absolute inset-0 bg-grid opacity-60"
          aria-hidden="true"
        />
        <div className="pointer-events-none absolute top-0 left-1/2 h-48 w-[42rem] -translate-x-1/2 rounded-full bg-emerald-500/10 blur-3xl" />
        <div className="relative mx-auto max-w-[1400px] px-4 pt-10 pb-8 sm:px-6 sm:pt-14">
          <div className="flex max-w-3xl flex-col items-start">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/8 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
              <Sparkles aria-hidden="true" className="size-3" />
              Cross-source growth index
            </span>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
              What developers are building right now.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              One leaderboard for GitHub, npm, PyPI, Hugging Face, arXiv and the MCP registry.
              Ranked by acceleration — not raw stars, downloads or likes.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <Button asChild>
                <Link href="/trending/all/24h">
                  Explore the full leaderboard
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/new">See what&apos;s new</Link>
              </Button>
            </div>
          </div>

          <dl className="mt-8 grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              icon={<Database aria-hidden="true" className="size-3.5" />}
              label="Items tracked"
              value={totalItems === null ? '—' : formatInteger(totalItems)}
            />
            <Stat
              icon={<Globe2 aria-hidden="true" className="size-3.5" />}
              label="Live sources"
              value="6"
            />
            <Stat
              icon={<Clock3 aria-hidden="true" className="size-3.5" />}
              label="Last scoring run"
              value={lastRun === undefined ? '—' : formatUtcTime(lastRun)}
            />
            <Stat
              icon={<Activity aria-hidden="true" className="size-3.5" />}
              label="Windows"
              value="24h · 7d · 30d"
            />
          </dl>
        </div>
      </section>

      <section className="mx-auto mt-6 max-w-[1400px] px-4 sm:px-6">
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <FilterBar
            scope="all"
            window="24h"
            newOnly={false}
            languages={languages?.languages ?? []}
            topics={topics?.topics ?? []}
          />
          {board === null ? (
            <div className="px-6 py-16 text-center">
              <p className="text-sm font-medium">The leaderboard is warming up</p>
              <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
                The web app cannot reach the API right now. Start the compose stack and seed the
                database to see live rankings.
              </p>
            </div>
          ) : (
            <div className="p-3 sm:p-4">
              <LiveLeaderboard
                initialData={board}
                refreshPath={allPath}
                scope="all"
                window="24h"
                title="Trending across all sources"
                subtitle="Last 24 hours · ranked by velocity z-score (cross-source normalized)"
              />
            </div>
          )}
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_348px]">
          <section
            id="about-score"
            className="rounded-xl border border-border bg-card p-5 shadow-sm"
          >
            <h2 className="text-sm font-semibold">Why this is not another star counter</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <ExplainStep
                number="01"
                title="Measure velocity"
                body="Growth is measured over the selected window using the metric that actually moves each source."
              />
              <ExplainStep
                number="02"
                title="Normalize within a source"
                body="A fast-moving npm package is not compared to a GitHub repo by raw counts. Source scores are robust z-scores."
              />
              <ExplainStep
                number="03"
                title="Combine the winners"
                body="The All board ranks cross-source z-scores, so every ecosystem can put an item on the main stage."
              />
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5">
                Signed-out view
              </span>
              <span>Accounts add watchlists, alerts and digests in the next phase.</span>
            </div>
          </section>

          <aside
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1"
            aria-label="Source spotlights"
          >
            <MiniBoard board={mcp} scope="mcp" window="7d" title="Rising in MCP" />
            <MiniBoard
              board={huggingface}
              scope="huggingface"
              window="24h"
              title="Models heating up"
            />
            <MiniBoard board={arxiv} scope="arxiv" window="7d" title="Papers gaining traction" />
            {lastRun !== undefined && (
              <p className="px-1 text-[10.5px] text-muted-foreground">
                Last successful run {formatUtcDate(lastRun)} on a public source feed.
              </p>
            )}
          </aside>
        </div>
      </section>
    </main>
  );
}

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card/70 px-3 py-2.5 backdrop-blur">
      <dt className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 font-mono text-sm font-semibold tracking-tight">{value}</dd>
    </div>
  );
}

function ExplainStep({ number, title, body }: { number: string; title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <span className="font-mono text-[10px] text-emerald-600 dark:text-emerald-400">{number}</span>
      <h3 className="mt-1 text-xs font-semibold">{title}</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}
