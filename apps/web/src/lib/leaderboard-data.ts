import { leaderboardPath, safeApiFetch } from '@/lib/api';
import type { LeaderboardParams } from '@/lib/leaderboard';
import {
  LanguagesResponseSchema,
  TopicsResponseSchema,
  TrendingResponseSchema,
  type LanguagesResponse,
  type TopicsResponse,
  type TrendingResponse,
} from '@/lib/schemas';

export interface LeaderboardData {
  board: TrendingResponse | null;
  topics: TopicsResponse['topics'];
  languages: LanguagesResponse['languages'];
}

export async function loadLeaderboardData(
  params: LeaderboardParams,
  limit = 100,
): Promise<LeaderboardData> {
  const [board, topics, languages] = await Promise.all([
    safeApiFetch(
      leaderboardPath({
        scope: params.scope,
        window: params.window,
        lang: params.lang,
        topic: params.topic,
        kind: params.kind,
        newOnly: params.newOnly,
        limit,
      }),
      TrendingResponseSchema,
      { next: { revalidate: 60 } },
    ),
    safeApiFetch('/v1/topics?limit=100', TopicsResponseSchema, { next: { revalidate: 300 } }),
    safeApiFetch('/v1/languages', LanguagesResponseSchema, { next: { revalidate: 300 } }),
  ]);

  return {
    board,
    topics: topics?.topics ?? [],
    languages: languages?.languages ?? [],
  };
}
