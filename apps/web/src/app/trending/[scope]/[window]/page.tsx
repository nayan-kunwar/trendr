import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { LeaderboardView } from '@/components/leaderboard-view';
import { SCOPE_LABELS, SOURCE_TAGLINES, WINDOW_LABELS } from '@/lib/constants';
import { loadLeaderboardData } from '@/lib/leaderboard-data';
import {
  isLeaderboardScope,
  isWindow,
  parseLeaderboardParams,
  type RawSearchParams,
} from '@/lib/leaderboard';

export const dynamic = 'force-dynamic';

interface WindowPageProps {
  params: Promise<{ scope: string; window: string }>;
  searchParams: Promise<RawSearchParams>;
}

export async function generateMetadata({
  params,
  searchParams,
}: WindowPageProps): Promise<Metadata> {
  const { scope, window } = await params;
  if (!isLeaderboardScope(scope) || !isWindow(window)) {
    return { title: 'Leaderboard not found' };
  }
  const query = await searchParams;
  const filters = parseLeaderboardParams(scope, window, query);
  const activeFilters = [
    filters.lang !== undefined ? `${filters.lang} language` : null,
    filters.topic,
    filters.kind,
    filters.newOnly ? 'new' : null,
  ]
    .filter((value): value is string => value !== null)
    .join(', ');
  const title = `${SCOPE_LABELS[scope]} trending — ${WINDOW_LABELS[window]}`;
  const description =
    scope === 'all'
      ? `The combined Trendr leaderboard over the last ${WINDOW_LABELS[window]}, ranked by cross-source velocity z-score.`
      : `${SOURCE_TAGLINES[scope]} over the last ${WINDOW_LABELS[window]}.`;
  const canonical = `/trending/${scope}/${window}`;

  return {
    title: activeFilters.length > 0 ? `${title} — ${activeFilters}` : title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      type: 'website',
      url: canonical,
      images: [
        {
          url: `/trending/${scope}/opengraph-image`,
          width: 1200,
          height: 630,
          alt: `${SCOPE_LABELS[scope]} trending on Trendr`,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [`/trending/${scope}/opengraph-image`],
    },
    robots:
      activeFilters.length > 0 ? { index: false, follow: true } : { index: true, follow: true },
  };
}

export default async function WindowLeaderboardPage({ params, searchParams }: WindowPageProps) {
  await connection();
  const { scope, window } = await params;
  if (!isLeaderboardScope(scope) || !isWindow(window)) notFound();
  const query = await searchParams;
  const parsed = parseLeaderboardParams(scope, window, query);
  const data = await loadLeaderboardData(parsed);

  return (
    <LeaderboardView
      params={parsed}
      board={data.board}
      topics={data.topics}
      languages={data.languages}
    />
  );
}
