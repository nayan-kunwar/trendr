import type { MetadataRoute } from 'next';

import { leaderboardPath, safeApiFetch } from '@/lib/api';
import { SCOPES, WINDOWS } from '@/lib/constants';
import { itemHref } from '@/lib/format';
import { absoluteUrl } from '@/lib/site';
import { TopicsResponseSchema, TrendingResponseSchema } from '@/lib/schemas';

// The API is not available while the Docker image is built, so the sitemap is
// generated on request and cached by the CDN instead of being prebuilt empty.
export const dynamic = 'force-dynamic';

/**
 * Top boards are capped at 100 rows by the public API. Fetching the combined and
 * each source board yields up to 700 high-signal item URLs, which is ample for
 * crawl discovery; the full corpus is reachable through search and topic pages.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const boards = await Promise.all([
    safeApiFetch(
      leaderboardPath({ scope: 'all', window: '7d', limit: 100 }),
      TrendingResponseSchema,
      { next: { revalidate: 3600 } },
    ),
    ...SCOPES.filter((scope) => scope !== 'all').map((scope) =>
      safeApiFetch(leaderboardPath({ scope, window: '24h', limit: 100 }), TrendingResponseSchema, {
        next: { revalidate: 3600 },
      }),
    ),
    safeApiFetch('/v1/topics?limit=100', TopicsResponseSchema, {
      next: { revalidate: 3600 },
    }),
  ]);

  const [allBoard, ...rest] = boards;
  const topicResponse = rest.pop();
  const sourceBoards = rest as (typeof allBoard)[];
  const topics =
    topicResponse !== null && topicResponse !== undefined && 'topics' in topicResponse
      ? topicResponse.topics
      : [];
  const lastModified = allBoard === null ? new Date() : new Date(allBoard.computedAt);

  const routes: MetadataRoute.Sitemap = [
    {
      url: absoluteUrl('/'),
      lastModified,
      changeFrequency: 'hourly',
      priority: 1,
    },
    {
      url: absoluteUrl('/new'),
      lastModified,
      changeFrequency: 'hourly',
      priority: 0.8,
    },
    {
      url: absoluteUrl('/topics'),
      lastModified,
      changeFrequency: 'daily',
      priority: 0.7,
    },
  ];

  for (const scope of SCOPES) {
    for (const window of WINDOWS) {
      routes.push({
        url: absoluteUrl(`/trending/${scope}/${window}`),
        lastModified,
        changeFrequency: window === '24h' ? 'hourly' : 'daily',
        priority: scope === 'all' && window === '24h' ? 0.9 : 0.6,
      });
    }
  }

  for (const topic of topics) {
    routes.push({
      url: absoluteUrl(`/topics/${topic.slug}`),
      lastModified,
      changeFrequency: 'daily',
      priority: 0.5,
    });
  }

  const seen = new Set<string>();
  for (const board of [allBoard, ...sourceBoards]) {
    if (board === null) continue;
    for (const entry of board.data) {
      const url = absoluteUrl(itemHref({ id: entry.item.id, displayName: entry.item.displayName }));
      if (seen.has(url)) continue;
      seen.add(url);
      routes.push({
        url,
        lastModified: new Date(board.computedAt),
        changeFrequency: 'daily',
        priority: 0.7,
      });
    }
  }

  return routes;
}
