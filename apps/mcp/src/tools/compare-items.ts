import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MetricSchema, WindowSchema } from '@trendr/core';
import { z } from 'zod';

import type { ApiClient } from '../api-client.js';
import { CompareOutputSchema, type CompareOutput } from '../schemas.js';
import { escapeMarkdown, formatRelativeGrowth, formatSigned } from './markdown.js';
import { READ_ONLY_ANNOTATIONS } from './shared.js';

export const CompareItemsInput = z.object({
  ids: z
    .array(z.string().regex(/^\d{1,19}$/))
    .min(2)
    .max(5),
  window: WindowSchema.default('30d'),
  metric: MetricSchema.optional(),
});

function renderCompare(output: CompareOutput): string {
  const rows = output.items.map((item) => {
    const rank = item.rankSource === null ? '—' : String(item.rankSource);
    const delta = item.delta === null ? '—' : formatSigned(item.delta);
    const percentile = item.percentile === null ? '—' : `p${item.percentile}`;
    return `| ${escapeMarkdown(item.name)} | ${delta} | ${formatRelativeGrowth(item.relGrowth)} | ${percentile} | ${rank} |`;
  });
  const counts = Object.entries(output.series)
    .map(([id, points]) => `${id}: ${points.length} points`)
    .join(', ');
  return [
    `# Compare items (${output.window})`,
    '',
    '| Item | Delta | Relative growth | Percentile | Rank |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...rows,
    counts ? `Series — ${counts}` : 'No series returned.',
  ].join('\n');
}

export function registerCompareItems(server: McpServer, api: ApiClient): void {
  server.registerTool(
    'compare_items',
    {
      title: 'Compare items',
      description: "Compare 2–5 items' growth side by side over a window.",
      inputSchema: CompareItemsInput.shape,
      outputSchema: CompareOutputSchema.shape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      const args = CompareItemsInput.parse(input);
      if (new Set(args.ids).size !== args.ids.length) {
        throw new Error('ids must be unique');
      }
      const response = await api.compare({
        ids: args.ids,
        window: args.window,
        ...(args.metric ? { metric: args.metric } : {}),
      });
      const output: CompareOutput = {
        window: response.window,
        items: response.items.map((item) => ({
          id: item.id,
          source: item.source,
          name: item.displayName,
          delta: item.delta,
          relGrowth: item.relGrowth,
          percentile: item.percentile,
          rankSource: item.rankSource,
        })),
        series: response.series,
      };
      return {
        content: [{ type: 'text', text: renderCompare(output) }],
        structuredContent: output,
      };
    },
  );
}
