import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MetricSchema, SourceSchema } from '@trendr/core';
import { z } from 'zod';

import type { ApiClient } from '../api-client.js';
import { HistoryOutputSchema, type HistoryOutput } from '../schemas.js';
import { formatNumber, formatSigned, markdownLink, truncate } from './markdown.js';
import { READ_ONLY_ANNOTATIONS } from './shared.js';

export const GetItemHistoryInput = z.object({
  id: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  source: SourceSchema.optional(),
  externalId: z.string().trim().min(1).max(255).optional(),
  metric: MetricSchema.optional(),
  days: z.number().int().min(1).max(365).default(30),
  granularity: z.enum(['hour', 'day']).default('day'),
});

export interface HistorySummary {
  first: number;
  last: number;
  delta: number;
  maxDailyGain: number;
}

function maxPositiveDelta(values: readonly number[]): number {
  let max = 0;
  for (let i = 1; i < values.length; i += 1) {
    const previous = values[i - 1];
    const current = values[i];
    if (previous !== undefined && current !== undefined) {
      max = Math.max(max, current - previous);
    }
  }
  return max;
}

/** Last value per UTC day; histories are chronological. */
function dailyClosingValues(points: readonly { t: string; v: number }[]): number[] {
  const byDay = new Map<string, number>();
  for (const point of points) {
    byDay.set(point.t.slice(0, 10), point.v);
  }
  return [...byDay.values()];
}

/**
 * `maxDailyGain` is intentionally metric-aware:
 * - cumulative: largest day-over-day increase (hourly data is rolled up first)
 * - daily_count: largest single-day count
 * - gauge: largest positive point-to-point increase
 */
export function summariseHistory(
  points: readonly { t: string; v: number }[],
  kind: 'cumulative' | 'daily_count' | 'gauge',
  granularity: 'hour' | 'day',
): HistorySummary {
  const first = points[0]?.v ?? 0;
  const last = points.at(-1)?.v ?? 0;
  let maxDailyGain = 0;
  if (kind === 'daily_count') {
    maxDailyGain = points.reduce((max, point) => Math.max(max, point.v), 0);
  } else if (kind === 'cumulative') {
    const values = granularity === 'hour' ? dailyClosingValues(points) : points.map((p) => p.v);
    maxDailyGain = maxPositiveDelta(values);
  } else {
    maxDailyGain = maxPositiveDelta(points.map((p) => p.v));
  }
  return { first, last, delta: last - first, maxDailyGain };
}

function renderHistory(output: HistoryOutput, granularity: 'hour' | 'day'): string {
  const item = output.item;
  const description = item.description ? `\n${truncate(item.description)}` : '';
  if (output.points.length === 0) {
    return `# ${markdownLink(item.name, item.url)}\nNo ${output.metric} points were returned for this range.${description}`;
  }
  const recent = output.points
    .slice(-5)
    .map((point) => `- ${point.t}: ${formatNumber(point.v)}`)
    .join('\n');
  return [
    `# ${markdownLink(item.name, item.url)}`,
    `${item.source}/${item.kind} · ${output.metric} (${output.kind}, ${granularity})`,
    `First ${formatNumber(output.summary.first)} → last ${formatNumber(output.summary.last)} (${formatSigned(output.summary.delta)}); max daily gain ${formatNumber(output.summary.maxDailyGain)}.`,
    recent,
    description.trim(),
  ]
    .filter(Boolean)
    .join('\n');
}

export function registerGetItemHistory(server: McpServer, api: ApiClient): void {
  server.registerTool(
    'get_item_history',
    {
      title: 'Get item metric history',
      description:
        'Get the time series of a metric (stars, downloads, likes, upvotes) for one item.',
      inputSchema: GetItemHistoryInput.shape,
      outputSchema: HistoryOutputSchema.shape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      const args = GetItemHistoryInput.parse(input);
      if (args.id === undefined && (args.source === undefined || args.externalId === undefined)) {
        throw new Error('Provide id, or both source and externalId');
      }
      if (args.granularity === 'hour' && args.days > 14) {
        throw new Error('Hour granularity is limited to 14 days');
      }

      let id = args.id;
      if (id === undefined) {
        if (args.source === undefined || args.externalId === undefined) {
          throw new Error('Provide id, or both source and externalId');
        }
        id = await api.resolveItemId(args.source, args.externalId);
      }

      const to = new Date();
      const from = new Date(to.getTime() - args.days * 86_400_000);
      const [item, history] = await Promise.all([
        api.getItem(id),
        api.getHistory(id, {
          granularity: args.granularity,
          from: from.toISOString(),
          to: to.toISOString(),
          ...(args.metric ? { metric: args.metric } : {}),
        }),
      ]);

      const output: HistoryOutput = {
        item: {
          id: item.id,
          source: item.source,
          kind: item.kind,
          name: item.displayName,
          url: item.url,
          description: item.description,
          primaryMetric: item.primaryMetric,
          current: item.latestMetrics[item.primaryMetric] ?? null,
          score7d: item.scores['7d']?.finalScore ?? null,
        },
        metric: history.metric,
        kind: history.kind,
        points: history.points,
        summary: summariseHistory(history.points, history.kind, history.granularity),
      };
      return {
        content: [{ type: 'text', text: renderHistory(output, history.granularity) }],
        structuredContent: output,
      };
    },
  );
}
