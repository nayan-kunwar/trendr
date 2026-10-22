import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ItemKindSchema, SourceSchema } from '@trendr/core';
import { z } from 'zod';

import type { ApiClient } from '../api-client.js';
import { SearchOutputSchema, type SearchItem } from '../schemas.js';
import { formatNumber, markdownLink, truncate } from './markdown.js';
import { READ_ONLY_ANNOTATIONS } from './shared.js';

export const SearchItemsInput = z.object({
  query: z.string().trim().min(2).max(100),
  source: SourceSchema.optional(),
  kind: ItemKindSchema.optional(),
  limit: z.number().int().min(1).max(25).default(10),
});

function renderSearch(query: string, items: SearchItem[]): string {
  const header = `# Search: ${query}`;
  if (items.length === 0) {
    return `${header}\n\nNo matching items.`;
  }
  const lines = items.map((item) => {
    const description = item.description ? ` — ${truncate(item.description)}` : '';
    const current =
      item.current === null ? 'no metric yet' : `${formatNumber(item.current)} current`;
    const score = item.score7d === null ? 'unscored' : `${formatNumber(item.score7d)} 7d score`;
    return `- ${markdownLink(item.name, item.url)} (${item.source}/${item.kind}) — ${current}, ${score}${description}`;
  });
  return `${header}\n\n${lines.join('\n')}`;
}

export function registerSearchItems(server: McpServer, api: ApiClient): void {
  server.registerTool(
    'search_items',
    {
      title: 'Search Trendr',
      description:
        'Search tracked repos, packages, models, papers and MCP servers by name or description.',
      inputSchema: SearchItemsInput.shape,
      outputSchema: SearchOutputSchema.shape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      const args = SearchItemsInput.parse(input);
      const response = await api.search({
        q: args.query,
        limit: args.limit,
        ...(args.source ? { source: args.source } : {}),
        ...(args.kind ? { kind: args.kind } : {}),
      });
      const output = {
        items: response.items.map((item) => ({
          id: item.id,
          source: item.source,
          kind: item.kind,
          name: item.name,
          description: item.description,
          current: item.current,
          score7d: item.score7d,
          url: item.url,
        })),
      };
      return {
        content: [{ type: 'text', text: renderSearch(args.query, output.items) }],
        structuredContent: output,
      };
    },
  );
}
