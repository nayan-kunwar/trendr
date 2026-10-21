import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { LeaderboardView } from '@/components/leaderboard-view';
import { SCOPE_LABELS, SOURCE_TAGLINES, WINDOW_LABELS } from '@/lib/constants';
import { loadLeaderboardData } from '@/lib/leaderboard-data';
import {
  isLeaderboardScope,
  parseLeaderboardParams,
  type RawSearchParams,
} from '@/lib/leaderboard';

export const dynamic = 'force-dynamic';

interface ScopePageProps {
  params: Promise<{ scope: string }>;
  searchParams: Promise<RawSearchParams>;
}

export async function generateMetadata({
  params,
  searchParams,
}: ScopePageProps): Promise<Metadata> {
  const { scope } = await params;
  if (!isLeaderboardScope(scope)) return { title: 'Leaderboard not found' };
  const query = await searchParams;
  const { window, lang, topic, kind, newOnly } = parseLeaderboardParams(scope, undefined, query);
  const filters = [
    lang !== undefined ? `${lang} language` : null,
    topic,
    kind,
    newOnly ? 'new' : null,
  ]
    .filter((value): value is string => value !== null)
    .join(', ');
  const title = `${SCOPE_LABELS[scope]} trending ${WINDOW_LABELS[window]}`;
  const description =
    scope === 'all'
      ? 'The combined Trendr leaderboard: GitHub, npm, PyPI, Hugging Face, arXiv and MCP ranked by growth velocity.'
      : `${SOURCE_TAGLINES[scope]}. Updated continuously by Trendr.`;

  return {
    title: filters.length > 0 ? `${title} — ${filters}` : title,
    description,
    alternates: { canonical: `/trending/${scope}/${window}` },
    openGraph: {
      title,
      description,
      type: 'website',
      url: `/trending/${scope}/${window}`,
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
    robots: filters.length > 0 ? { index: false, follow: true } : { index: true, follow: true },
  };
}

export default async function ScopeLeaderboardPage({ params, searchParams }: ScopePageProps) {
  await connection();
  const { scope } = await params;
  if (!isLeaderboardScope(scope)) notFound();
  const query = await searchParams;
  const parsed = parseLeaderboardParams(scope, undefined, query);
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
