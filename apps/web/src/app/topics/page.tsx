import { Hash, Search, Tags } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { safeApiFetch } from '@/lib/api';
import { topicLabel } from '@/lib/format';
import { TopicsResponseSchema } from '@/lib/schemas';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Topics',
  description:
    'Browse trending projects by topic across GitHub, npm, PyPI, Hugging Face, arXiv and MCP.',
  alternates: { canonical: '/topics' },
};

export default async function TopicsPage() {
  const data = await safeApiFetch('/v1/topics?limit=100', TopicsResponseSchema, {
    next: { revalidate: 300 },
  });
  const topics = data?.topics ?? [];
  const total = topics.reduce((sum, topic) => sum + topic.itemCount, 0);

  return (
    <main className="mx-auto max-w-[1050px] px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground">
            <Tags aria-hidden="true" className="size-3" />
            Topic index
          </span>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
            Browse by topic
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Tags are collected from every source and normalized into one vocabulary. Open a topic
            for a cross-source leaderboard ranked by growth velocity.
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-[11px] text-muted-foreground shadow-sm">
          <span className="font-mono text-sm font-semibold text-foreground">
            {topics.length.toLocaleString('en-US')}
          </span>{' '}
          topics · {total.toLocaleString('en-US')} item links
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 shadow-sm">
        <form action="/search" className="relative min-w-[220px] flex-1">
          <label className="sr-only" htmlFor="topic-search">
            Search all items
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            id="topic-search"
            type="search"
            name="q"
            minLength={2}
            placeholder="Search items instead…"
            className="h-9 w-full rounded-md border border-border bg-background pr-3 pl-8 text-xs outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
          />
        </form>
        <Button asChild variant="outline" size="sm">
          <Link href="/trending/all/24h">Open leaderboard</Link>
        </Button>
      </div>

      {data === null ? (
        <div className="mt-5 rounded-xl border border-dashed border-border px-6 py-12 text-center">
          <p className="text-sm font-medium">Topics are unavailable</p>
          <p className="mt-1 text-xs text-muted-foreground">The API did not answer.</p>
        </div>
      ) : topics.length === 0 ? (
        <div className="mt-5 rounded-xl border border-border bg-card px-6 py-12 text-center shadow-sm">
          <p className="text-sm font-medium">No topics yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Topics appear as soon as ingestion stores item tags.
          </p>
        </div>
      ) : (
        <ul className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {topics.map((topic) => (
            <li key={topic.slug}>
              <Link
                href={`/topics/${topic.slug}`}
                className="group flex h-full flex-col justify-between gap-3 rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-emerald-500/40 hover:bg-accent/30"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                    <Hash aria-hidden="true" className="size-3.5 shrink-0 text-emerald-500" />
                    <span className="truncate">{topicLabel(topic.slug)}</span>
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {topic.itemCount.toLocaleString('en-US')}
                  </span>
                </div>
                <span className="text-[10.5px] text-muted-foreground group-hover:text-foreground">
                  {topic.slug} · view topic board →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
