import { normalizePyPiName } from '@trendr/core';

/**
 * Spec §7.3.3 — the pure PyPI URL/date/name maths. The adapter speaks three
 * hosts: `pypi.org` (RSS + project JSON), `pypistats.org` (downloads) and the
 * PEP 503 namespace, which is why every project name goes through
 * `normalizePyPiName` before it reaches a URL or a Set.
 */

export const PYPI_BASE = 'https://pypi.org';
export const PYPI_STATS_BASE = 'https://pypistats.org';

/** Spec §7.3.3: the series already covers 180 days; keep 60 on admission. */
export const PYPI_BACKFILL_DAYS = 60;
/** The daily job writes D-2 … D (late-data safety). */
export const PYPI_DAILY_WINDOW_DAYS = 3;

export const PYPI_FEEDS = {
  newest: `${PYPI_BASE}/rss/packages.xml`,
  updates: `${PYPI_BASE}/rss/updates.xml`,
} as const;

/** Spec §7.3.3 discovery filter, applied to the name, title and summary. */
export const PYPI_RSS_KEYWORDS = [
  'llm',
  'agent',
  'mcp',
  'rag',
  'langchain',
  'transformer',
  'diffusion',
  'embedding',
  'openai',
  'anthropic',
  'torch',
  'jax',
] as const;

const DAY_MS = 86_400_000;
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const ESCAPED_KEYWORDS = PYPI_RSS_KEYWORDS.map((keyword) =>
  keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
).join('|');
const KEYWORD_PATTERN = new RegExp(
  `(?:^|[^a-z0-9])(?:${ESCAPED_KEYWORDS})(?:s)?(?:[^a-z0-9]|$)`,
  'i',
);

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid UTC day "${day}"`);
  date.setUTCDate(date.getUTCDate() + delta);
  return isoDay(date);
}

/** pypistats publishes complete UTC days; the newest expected bucket is yesterday. */
export function lastCompletePypiDay(now: Date): string {
  return isoDay(new Date(now.getTime() - DAY_MS));
}

/** PEP 503 canonical form, or null when the name cannot be a PyPI project. */
export function canonicalPypiName(raw: string): string | null {
  const canonical = normalizePyPiName(raw);
  return NAME_PATTERN.test(canonical) ? canonical : null;
}

export function isValidPypiName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

export function projectJsonUrl(name: string): string {
  return `${PYPI_BASE}/pypi/${encodeURIComponent(normalizePyPiName(name))}/json`;
}

export function overallStatsUrl(name: string): string {
  return `${PYPI_STATS_BASE}/api/packages/${encodeURIComponent(normalizePyPiName(name))}/overall?mirrors=false`;
}

export function recentStatsUrl(name: string): string {
  return `${PYPI_STATS_BASE}/api/packages/${encodeURIComponent(normalizePyPiName(name))}/recent`;
}

export function projectPageUrl(name: string): string {
  return `${PYPI_BASE}/project/${encodeURIComponent(normalizePyPiName(name))}/`;
}

/**
 * RSS item links are `https://pypi.org/project/{name}/` (newest) or
 * `https://pypi.org/project/{name}/{version}/` (updates). Reading the path is
 * safer than parsing the title, which adds " added to PyPI" or a version.
 */
export function pypiNameFromFeedLink(link: string): string | null {
  try {
    const url = new URL(link);
    if (url.hostname !== 'pypi.org' && url.hostname !== 'www.pypi.org') return null;
    const parts = url.pathname.split('/').filter((part) => part !== '');
    if (parts[0] !== 'project' || parts[1] === undefined) return null;
    return canonicalPypiName(decodeURIComponent(parts[1]));
  } catch {
    return null;
  }
}

/** Fallback for a malformed/missing link: the first whitespace-delimited token. */
export function pypiNameFromFeedTitle(title: string): string | null {
  const cleaned = title.replace(/\s+added to pypi$/i, '').trim();
  const first = cleaned.split(/\s+/)[0];
  return first === undefined ? null : canonicalPypiName(first);
}

export function matchesPypiKeywords(...texts: readonly (string | null | undefined)[]): boolean {
  return texts.some((text) => text !== null && text !== undefined && KEYWORD_PATTERN.test(text));
}

/** Sorted download points ending at the latest available day, inclusive. */
export function windowEndingAt<T extends { date: string }>(
  points: readonly T[],
  end: string,
  days: number,
): T[] {
  if (points.length === 0 || days <= 0) return [];
  const start = addDays(end, -(days - 1));
  return points
    .filter((point) => point.date >= start && point.date <= end)
    .sort((left, right) => left.date.localeCompare(right.date));
}

/** The newest day present in a stats series (pypistats returns ascending data). */
export function latestDay(points: readonly { date: string }[]): string | null {
  let latest: string | null = null;
  for (const point of points) {
    if (latest === null || point.date > latest) latest = point.date;
  }
  return latest;
}

/** True when the expected last complete day has not landed upstream yet. */
export function isStatsIncomplete(
  points: readonly { date: string }[],
  expectedDay: string,
): boolean {
  const latest = latestDay(points);
  return latest !== null && latest < expectedDay;
}

/** Keep the newest `days` rows; the pypistats response is already 180 days. */
export function keepLatestDays<T extends { date: string }>(
  points: readonly T[],
  days: number,
): T[] {
  return [...points]
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-Math.max(0, days));
}
