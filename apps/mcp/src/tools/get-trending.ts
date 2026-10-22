import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LeaderboardScopeSchema, WindowSchema } from '@trendr/core';
import { z } from 'zod';

import type { ApiClient } from '../api-client.js';
import { TrendingOutputSchema, type TrendingItem, type TrendingOutput } from '../schemas.js';
import {
  formatNumber,
  formatRelativeGrowth,
  formatSigned,
  markdownLink,
  truncate,
} from './markdown.js';
import { READ_ONLY_ANNOTATIONS } from './shared.js';

export const GetTrendingInput = z.object({
  source: LeaderboardScopeSchema.default('all'),
  window: WindowSchema.default('7d'),
  language: z.string().trim().toLowerCase().max(40).optional(),
  topic: z.string().trim().toLowerCase().max(50).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

function renderTrending(output: TrendingOutput): string {
  const header = `# Trending (${output.window})\nComputed ${output.computedAt}.`;
  if (output.items.length === 0) {
    return `${header}\n\nNo items matched this board.`;
  }
  const lines = output.items.map((item: TrendingItem) => {
    const growth = `Δ ${formatSigned(item.delta)} (${formatRelativeGrowth(item.relGrowth)})`;
    const description = item.description ? ` — ${truncate(item.description)}` : '';
    return `${item.rank}. ${markdownLink(item.name, item.url)} (${item.source}) — ${growth}, ${formatNumber(item.current)} current, p${formatNumber(item.percentile)}${description}`;
  });
  return `${header}\n\n${lines.join('\n')}`;
}

export function registerGetTrending(server: McpServer, api: ApiClient): void {
  server.registerTool(
    'get_trending',
    {
      title: 'Get trending items',
      description:
        "Get the fastest-growing developer/AI projects by velocity. Use for 'what's trending in X'.",
      inputSchema: GetTrendingInput.shape,
      outputSchema: TrendingOutputSchema.shape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      const args = GetTrendingInput.parse(input);
      const response = await api.trending({
        source: args.source,
        window: args.window,
        limit: args.limit,
        ...(args.language ? { lang: args.language } : {}),
        ...(args.topic ? { topic: args.topic } : {}),
      });
      const output: TrendingOutput = {
        window: response.window,
        computedAt: response.computedAt,
        items: response.data.map((entry) => ({
          rank: entry.rank,
          id: entry.item.id,
          source: entry.item.source,
          name: entry.item.displayName,
          url: entry.item.url,
          description: entry.item.description,
          current: entry.current,
          delta: entry.delta,
          relGrowth: entry.relGrowth,
          percentile: entry.percentile,
          flags: entry.flags,
        })),
      };
      return {
        content: [{ type: 'text', text: renderTrending(output) }],
        structuredContent: output,
      };
    },
  );
}
