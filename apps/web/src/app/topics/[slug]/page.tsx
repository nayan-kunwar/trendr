import { Hash } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { FilterBar } from '@/components/filter-bar';
import { LiveLeaderboard } from '@/components/live-leaderboard';
import { leaderboardPath } from '@/lib/api';
import { WINDOW_LABELS } from '@/lib/constants';
import { loadLeaderboardData } from '@/lib/leaderboard-data';
import { parseLeaderboardParams, type RawSearchParams } from '@/lib/leaderboard';
import { topicLabel } from '@/lib/format';

export const dynamic = 'force-dynamic';

const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

interface TopicPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<RawSearchParams>;
}

export async function generateMetadata({
  params,
  searchParams,
}: TopicPageProps): Promise<Metadata> {
  const { slug } = await params;
  if (!TOPIC_RE.test(slug)) return { title: 'Topic not found' };
  const query = await searchParams;
  const parsed = parseLeaderboardParams('all', undefined, query);
  const name = topicLabel(slug);
  const activeFilters =
    parsed.lang !== undefined ||
    parsed.kind !== undefined ||
    parsed.newOnly ||
    parsed.window !== '24h';
  return {
    title: `${name} projects`,
    description: `Trending ${name} repositories, packages, models and papers ranked by growth velocity on Trendr.`,
    alternates: { canonical: `/topics/${slug}` },
    robots: activeFilters ? { index: false, follow: true } : { index: true, follow: true },
    openGraph: {
      title: `${name} projects`,
      description: `Trending ${name} projects ranked by growth velocity.`,
      url: `/topics/${slug}`,
      images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: 'Trendr' }],
    },
  };
}

export default async function TopicPage({ params, searchParams }: TopicPageProps) {
  const { slug } = await params;
  if (!TOPIC_RE.test(slug)) notFound();
  const query = await searchParams;
  const parsed = parseLeaderboardParams('all', undefined, query);
  const data = await loadLeaderboardData({ ...parsed, topic: slug });
  const topic = data.topics.find((item) => item.slug === slug);
  const name = topicLabel(slug);
  const topicOptions =
    topic === undefined ? [{ slug, name, itemCount: 0 }, ...data.topics] : data.topics;
  const related = data.topics.filter((item) => item.slug !== slug).slice(0, 12);

  return (
    <main className="mx-auto max-w-[1200px] px-4 py-6 sm:px-6 sm:py-8">
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1 text-[11px] text-muted-foreground"
      >
        <Link href="/" className="hover:text-foreground">
          Home
        </Link>
        <span aria-hidden="true">/</span>
        <span>Topics</span>
        <span aria-hidden="true">/</span>
        <span className="text-foreground">{name}</span>
      </nav>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground">
            <Hash aria-hidden="true" className="size-3" />
            Topic
          </span>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
            {name} projects
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {topic === undefined
              ? 'Items tagged with this topic across every source.'
              : `${topic.itemCount.toLocaleString('en-US')} items tagged with this topic. Ranked over the last ${WINDOW_LABELS[parsed.window]}.`}
          </p>
        </div>
        <Link
          href={`/trending/all/${parsed.window}?topic=${slug}`}
          className="text-[11px] font-medium text-emerald-600 hover:underline dark:text-emerald-400"
        >
          Open as a leaderboard →
        </Link>
      </div>

      <div className="mt-5 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <FilterBar
          scope="all"
          window={parsed.window}
          lang={parsed.lang}
          topic={slug}
          kind={parsed.kind}
          newOnly={parsed.newOnly}
          languages={data.languages}
          topics={topicOptions}
        />
        {data.board === null ? (
          <div className="px-6 py-16 text-center">
            <p className="text-sm font-medium">This topic board is unavailable</p>
            <p className="mt-1 text-xs text-muted-foreground">The API did not respond.</p>
          </div>
        ) : (
          <div className="p-3 sm:p-4">
            <LiveLeaderboard
              initialData={data.board}
              refreshPath={leaderboardPath({
                ...parsed,
                scope: 'all',
                window: parsed.window,
                topic: slug,
                limit: 100,
              })}
              scope="all"
              window={parsed.window}
              title={`${name} · ${WINDOW_LABELS[parsed.window]}`}
              subtitle={`${topic?.itemCount ?? 0} items tagged ${name} across all sources`}
            />
          </div>
        )}
      </div>

      {related.length > 0 && (
        <section className="mt-6" aria-labelledby="related-topics-title">
          <h2 id="related-topics-title" className="text-sm font-semibold">
            Related topics
          </h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {related.map((item) => (
              <Link
                key={item.slug}
                href={`/topics/${item.slug}`}
                className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                {item.name}
                <span className="ml-1 font-mono text-[10px] opacity-60">{item.itemCount}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
