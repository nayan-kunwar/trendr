import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ApiClient } from './api-client.js';
import { registerCompareItems } from './tools/compare-items.js';
import { registerGetItemHistory } from './tools/get-item-history.js';
import { registerGetTrending } from './tools/get-trending.js';
import { registerSearchItems } from './tools/search-items.js';
import { registerWhatsNewInMcp } from './tools/whats-new-in-mcp.js';

const INSTRUCTIONS = [
  'Trendr exposes read-only trend data across GitHub, npm, PyPI, Hugging Face, arXiv and the MCP registry.',
  'Use get_trending for "what\'s hot" questions, search_items to find a specific item, get_item_history for a trend over time, compare_items for side-by-side analysis, and whats_new_in_mcp for new or rising MCP servers.',
  'All tools query the public Trendr API and never mutate user or catalog state.',
].join(' ');

/** Build a fully registered MCP server; transports own its lifecycle. */
export function createTrendrMcpServer(api: ApiClient): McpServer {
  const server = new McpServer(
    { name: 'trendr', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  );
  registerGetTrending(server, api);
  registerSearchItems(server, api);
  registerGetItemHistory(server, api);
  registerCompareItems(server, api);
  registerWhatsNewInMcp(server, api);
  return server;
}
