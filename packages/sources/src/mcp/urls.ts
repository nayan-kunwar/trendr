/**
 * Spec §7.3.6 — every MCP upstream URL and pagination bound lives here.
 * Registry list calls use v0.1 (the stable contract as of 2026-10) and fall
 * back to v0 on 404; detail links use the v0.1 versioned endpoint so a server
 * page keeps resolving after a newer version is published.
 */

export const MCP_REGISTRY_BASE_V01 = 'https://registry.modelcontextprotocol.io/v0.1';
export const MCP_REGISTRY_BASE_V0 = 'https://registry.modelcontextprotocol.io/v0';
export const MCP_PAGE_SIZE = 100;
/**
 * Defensive bound for the weekly full resync. Live acceptance found 48,379
 * latest servers in 484 pages on 2026-10-20, so the bound is 50k / 500 pages
 * (~4 min at 2 req/s). It protects against a runaway cursor; the small
 * headroom is intentional and must be raised if registry growth consumes it.
 */
export const MCP_DISCOVERY_MAX_ITEMS = 50_000;
export const MCP_DISCOVERY_MAX_PAGES = 500;
/** Bound for the GitHub-topic + npm-keyword fallback pass. */
export const MCP_FALLBACK_MAX_ITEMS = 1_000;

export const MCP_GITHUB_MIN_STARS = 5;
export const MCP_GITHUB_PAGE_SIZE = 100;
export const MCP_GITHUB_MAX_PAGES = 5;
export const MCP_GITHUB_QUERIES: readonly string[] = ['topic:mcp-server', 'topic:mcp stars:>=5'];

export const MCP_NPM_MIN_WEEKLY_DOWNLOADS = 50;
export const MCP_NPM_PAGE_SIZE = 250;
export const MCP_NPM_MAX_PAGES = 2;
export const MCP_NPM_KEYWORDS: readonly string[] = ['mcp-server', 'mcp'];

/** Pinned registry schema observed live; a mismatch is logged, not fatal. */
export const MCP_SERVER_SCHEMA_URL =
  'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';

export interface McpServersQuery {
  cursor?: string | null;
  updatedSince?: Date | null;
  limit?: number;
  version?: string;
  includeDeleted?: boolean;
}

export function mcpServersUrl(base: string, query: McpServersQuery = {}): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit ?? MCP_PAGE_SIZE));
  params.set('version', query.version ?? 'latest');
  if (query.cursor !== undefined && query.cursor !== null && query.cursor !== '') {
    params.set('cursor', query.cursor);
  }
  if (query.updatedSince !== undefined && query.updatedSince !== null) {
    params.set('updated_since', query.updatedSince.toISOString());
  }
  if (query.includeDeleted ?? true) params.set('include_deleted', 'true');
  return `${base}/servers?${params.toString()}`;
}

export function mcpServerPageUrl(name: string): string {
  return `${MCP_REGISTRY_BASE_V01}/servers/${encodeURIComponent(name)}/versions/latest`;
}

export function mcpGitHubSearchUrl(query: string, page: number): string {
  const params = new URLSearchParams({
    q: query,
    sort: 'stars',
    order: 'desc',
    per_page: String(MCP_GITHUB_PAGE_SIZE),
    page: String(page),
  });
  return `https://api.github.com/search/repositories?${params.toString()}`;
}

export function mcpNpmSearchUrl(keyword: string, from: number): string {
  const params = new URLSearchParams({
    text: `keywords:${keyword}`,
    size: String(MCP_NPM_PAGE_SIZE),
    from: String(from),
  });
  return `https://registry.npmjs.org/-/v1/search?${params.toString()}`;
}
