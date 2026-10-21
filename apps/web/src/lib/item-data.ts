import { cache } from 'react';
import type { Window } from '@trendr/core';

import { buildQuery, safeApiFetch } from '@/lib/api';
import {
  HistoryResponseSchema,
  ItemAliasesResponseSchema,
  ItemDetailSchema,
  ScoreExplainResponseSchema,
  ScoresResponseSchema,
  type HistoryResponse,
  type ItemAliasesResponse,
  type ItemDetail,
  type ScoreExplain,
  type ScoresResponse,
} from '@/lib/schemas';

export function isItemId(value: string): boolean {
  return /^\d{1,19}$/.test(value);
}

/** Request-scoped cache: `generateMetadata` and the page share one detail fetch. */
export const getItemDetail = cache(async (id: string): Promise<ItemDetail | null> =>
  safeApiFetch(`/v1/items/${id}`, ItemDetailSchema, { next: { revalidate: 120 } }),
);

export interface ItemActivity {
  history: HistoryResponse | null;
  scores: Record<Window, ScoresResponse | null>;
  explain: ScoreExplain | null;
  aliases: ItemAliasesResponse | null;
}

/**
 * The item page needs a year of daily history for the range switcher and 30
 * days of score history per scoring window (spec §12.3). Everything is fetched
 * in parallel and validated before it reaches the charts.
 */
export async function loadItemActivity(
  id: string,
  primaryMetric: ItemDetail['primaryMetric'],
): Promise<ItemActivity> {
  const now = new Date();
  const from = new Date(now.getTime() - 365 * 86_400_000);
  const historyPath = `/v1/items/${id}/history${buildQuery({
    metric: primaryMetric,
    from: from.toISOString(),
    to: now.toISOString(),
    granularity: 'day',
  })}`;
  const scoresPath = (window: Window) =>
    `/v1/items/${id}/scores${buildQuery({ window, granularity: 'day', days: 30 })}`;

  const [history, scores24h, scores7d, scores30d, explain, aliases] = await Promise.all([
    safeApiFetch(historyPath, HistoryResponseSchema, { next: { revalidate: 120 } }),
    safeApiFetch(scoresPath('24h'), ScoresResponseSchema, { next: { revalidate: 120 } }),
    safeApiFetch(scoresPath('7d'), ScoresResponseSchema, { next: { revalidate: 120 } }),
    safeApiFetch(scoresPath('30d'), ScoresResponseSchema, { next: { revalidate: 120 } }),
    safeApiFetch(`/v1/items/${id}/score-explain?window=24h`, ScoreExplainResponseSchema, {
      next: { revalidate: 120 },
    }),
    safeApiFetch(`/v1/items/${id}/aliases`, ItemAliasesResponseSchema, {
      next: { revalidate: 300 },
    }),
  ]);

  return {
    history,
    scores: { '24h': scores24h, '7d': scores7d, '30d': scores30d },
    explain,
    aliases,
  };
}
