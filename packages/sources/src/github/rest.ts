/**
 * Spec §7.3.1 — REST search query construction and slicing. Pure functions so
 * the strategy table is unit-testable without any I/O; the adapter performs
 * the calls.
 */

export const GITHUB_SEARCH_STRATEGIES = [
  'new-hot',
  'rising',
  'topics',
  'active-established',
] as const;
export type GitHubSearchStrategy = (typeof GITHUB_SEARCH_STRATEGIES)[number];

/** The spec §7.3.1 topic list for the `topics` strategy. */
export const GITHUB_TOPIC_QUERIES: readonly string[] = [
  'mcp-server',
  'mcp',
  'model-context-protocol',
  'llm',
  'ai-agents',
  'agent',
  'rag',
  'langchain',
  'transformers',
  'diffusion',
  'typescript',
  'rust',
  'nextjs',
  'devtools',
  'cli',
];

export const SEARCH_PAGE_SIZE = 100;
/** Search returns at most 1,000 results → 10 pages of 100. */
export const SEARCH_MAX_PAGE = 10;
/** Spec §7.3.1: slice `created:` ranges at most 4 levels deep when a query tops 1,000. */
export const SEARCH_SLICE_MAX_DEPTH = 4;

const DAY_MS = 86_400_000;

export interface SearchQuery {
  q: string;
  sort: 'stars' | 'updated';
  order: 'desc';
  /** Day-granular `created:` range when the strategy can be sliced. */
  created: { lo: string; hi: string } | null;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/** Spec §7.3.1 discovery strategies → the exact search queries to run. */
export function buildSearchQueries(strategy: GitHubSearchStrategy, now: Date): SearchQuery[] {
  if (strategy === 'new-hot') {
    const created = { lo: isoDay(daysBefore(now, 7)), hi: isoDay(now) };
    return [{ q: createdQuery(created, 'stars:>=20'), sort: 'stars', order: 'desc', created }];
  }
  if (strategy === 'rising') {
    const created = { lo: isoDay(daysBefore(now, 30)), hi: isoDay(now) };
    return [{ q: createdQuery(created, 'stars:>=100'), sort: 'stars', order: 'desc', created }];
  }
  if (strategy === 'topics') {
    const pushed = isoDay(daysBefore(now, 14));
    return GITHUB_TOPIC_QUERIES.map((topic) => ({
      q: `topic:${topic} pushed:>${pushed} stars:>=10`,
      sort: 'stars' as const,
      order: 'desc' as const,
      created: null,
    }));
  }
  // active-established
  const pushed = isoDay(daysBefore(now, 1));
  return [{ q: `stars:>=1000 pushed:>${pushed}`, sort: 'updated', order: 'desc', created: null }];
}

function createdQuery(created: { lo: string; hi: string }, stars: string): string {
  return `created:${created.lo}..${created.hi} ${stars}`;
}

/**
 * Split a day-granular `created:` range in half. Returns `[]` when the range
 * is one day wide (nothing left to split) — the recursion terminates on that
 * or on `SEARCH_SLICE_MAX_DEPTH`.
 */
export function splitCreatedRange(created: {
  lo: string;
  hi: string;
}): { lo: string; hi: string }[] {
  const loMs = Date.parse(`${created.lo}T00:00:00Z`);
  const hiMs = Date.parse(`${created.hi}T00:00:00Z`);
  if (!Number.isFinite(loMs) || !Number.isFinite(hiMs)) return [];
  const spanMs = hiMs - loMs;
  if (spanMs < 2 * DAY_MS) return [];
  const midMs = loMs + Math.floor(spanMs / 2 / DAY_MS) * DAY_MS;
  const mid = isoDay(new Date(midMs));
  const next = isoDay(new Date(midMs + DAY_MS));
  const right = { lo: next, hi: created.hi };
  if (right.lo > right.hi) return [{ lo: created.lo, hi: mid }];
  return [{ lo: created.lo, hi: mid }, right];
}

/** Rebuild a query for a sliced range, keeping the other qualifiers in place. */
export function withCreatedRange(
  query: SearchQuery,
  created: { lo: string; hi: string },
): SearchQuery {
  const qualifiers = query.q
    .split(/\s+/)
    .filter((part) => part !== '')
    .map((part) => (part.startsWith('created:') ? `created:${created.lo}..${created.hi}` : part));
  return { ...query, q: qualifiers.join(' '), created };
}

export { DAY_MS };
