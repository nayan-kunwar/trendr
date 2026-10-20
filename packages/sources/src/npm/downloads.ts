import { normalizeGitHubRepo, normalizeNpmPackage } from '@trendr/core';

/**
 * Spec §7.3.2 — the pure npm URL/date maths: the last complete UTC day, the
 * three-day late-data window, scoped-name encoding (`@scope%2Fname`), bulk
 * chunking (≤ 128, unscoped only) and `repository` URL → GitHub alias parsing.
 */

export const NPM_REGISTRY = 'https://registry.npmjs.org';
export const NPM_DOWNLOADS = 'https://api.npmjs.org';

/** Spec §7.3.2 documented bulk limit. */
export const NPM_BULK_MAX = 128;
/** `range/{D-2}:{D}` — three days absorb late-landing data. */
export const NPM_DAILY_WINDOW_DAYS = 3;
/** `range/{D-60}:{D}` on first admission (spec §7.3.2). */
export const NPM_BACKFILL_DAYS = 60;

/** Search: `size` max 250, `from` documented up to 1,000 (spec §7.3.2). */
export const NPM_SEARCH_PAGE_SIZE = 250;
export const NPM_SEARCH_MAX_FROM = 1_000;

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid UTC day "${day}"`);
  date.setUTCDate(date.getUTCDate() + delta);
  return isoDay(date);
}

/**
 * Spec §7.3.2: download counts are computed once per day, soon after UTC
 * midnight, and `last-day` is the last *available* day — i.e. yesterday, not
 * today. `range` responses include today with `downloads: 0`; anchoring on
 * yesterday keeps a partial current day out of the series.
 */
export function lastCompleteNpmDay(now: Date): string {
  return addDays(isoDay(now), -1);
}

export interface NpmDailyWindow {
  /** First day of the window (inclusive). */
  start: string;
  /** Last complete day (inclusive). */
  end: string;
  /** Every day in the window, oldest first. */
  days: string[];
}

export function npmDailyWindow(now: Date): NpmDailyWindow {
  return npmWindowEndingAt(lastCompleteNpmDay(now));
}

/** The same three-day window ending at an upstream-reported available day. */
export function npmWindowEndingAt(end: string): NpmDailyWindow {
  const start = addDays(end, -(NPM_DAILY_WINDOW_DAYS - 1));
  return {
    start,
    end,
    days: Array.from({ length: NPM_DAILY_WINDOW_DAYS }, (_, index) => addDays(start, index)),
  };
}

/** npm names are lowercase-only; canonicalize before any comparison. */
export function isScopedNpmName(name: string): boolean {
  return normalizeNpmPackage(name).startsWith('@');
}

/**
 * Spec §7.3.2: scoped names are encoded `@scope%2Fname` in registry and
 * downloads paths. `encodeURIComponent` would also escape the `@`; npm accepts
 * both, but the documented form (and the acceptance criterion) keeps it.
 */
export function encodeNpmName(name: string): string {
  const canonical = normalizeNpmPackage(name);
  return canonical.replace('/', '%2F');
}

export function chunkNpmNames(names: readonly string[], size = NPM_BULK_MAX): string[][] {
  const chunks: string[][] = [];
  const limit = Math.max(1, size);
  for (let offset = 0; offset < names.length; offset += limit) {
    chunks.push(names.slice(offset, offset + limit));
  }
  return chunks;
}

export function searchUrl(keyword: string, from: number): string {
  const params = new URLSearchParams({
    text: `keywords:${keyword}`,
    size: String(NPM_SEARCH_PAGE_SIZE),
    from: String(from),
  });
  return `${NPM_REGISTRY}/-/v1/search?${params.toString()}`;
}

export function packumentUrl(name: string): string {
  return `${NPM_REGISTRY}/${encodeNpmName(name)}`;
}

/** One bulk request for ≤ 128 unscoped packages (scoped names are not supported). */
export function bulkRangeUrl(start: string, end: string, names: readonly string[]): string {
  return `${NPM_DOWNLOADS}/downloads/range/${start}:${end}/${names.join(',')}`;
}

/** One request per scoped package (single queries allow up to 18 months). */
export function singleRangeUrl(start: string, end: string, name: string): string {
  return `${NPM_DOWNLOADS}/downloads/range/${start}:${end}/${encodeNpmName(name)}`;
}

/**
 * `last-day` watermark probe. A range request fills a not-yet-computed day
 * with `0`, so daily anchoring must use the day npm itself reports as
 * available, not "UTC yesterday" (observed: at 03:09Z, `last-day` was D-2 and
 * the range carried D-1 as 0). One probe per cache window serves every
 * package chunk of the run.
 */
export function lastDayPointUrl(name: string): string {
  return `${NPM_DOWNLOADS}/downloads/point/last-day/${encodeNpmName(name)}`;
}

/** `true` when the expected last complete day is absent from a range reply. */
export function missingDailyBucket(range: { downloads: { day: string }[] }, day: string): boolean {
  return !range.downloads.some((point) => point.day === day);
}

const GITHUB_REPOSITORY_PATTERNS: readonly RegExp[] = [
  // git+https://github.com/o/r.git, git://github.com/o/r, ssh://git@github.com/o/r
  /^(?:git\+)?(?:https?|git|ssh):\/\/(?:git@)?(?:www\.)?github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i,
  // git@github.com:o/r.git (scp shorthand)
  /^(?:git@)?(?:www\.)?github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i,
  // github:o/r
  /^github:([^/]+)\/([^/#?]+?)(?:\.git)?(?:#.*)?$/i,
];

/**
 * Spec §7.3.2 — `repository` → GitHub alias. Accepts the URL forms npm
 * actually publishes (`git+https://…`, `git://…`, `git@github.com:…`,
 * `github:o/r`, plain `https://github.com/o/r/tree/main/…`) and ignores
 * non-GitHub hosts. The repository *directory* is deliberately irrelevant:
 * the package belongs to the repo, even when it lives in a monorepo.
 */
export function parseGitHubRepositoryUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim();
  if (value === '') return null;
  for (const pattern of GITHUB_REPOSITORY_PATTERNS) {
    const match = pattern.exec(value);
    const owner = match?.[1];
    const repo = match?.[2];
    if (owner === undefined || repo === undefined) continue;
    try {
      return normalizeGitHubRepo(`${owner}/${repo}`);
    } catch {
      return null;
    }
  }
  return null;
}

/** npm `repository` may be a string or `{ url, directory }`; normalize to a URL. */
export function repositoryUrl(
  value: string | { url?: string | undefined } | null | undefined,
): string | null {
  if (typeof value === 'string') return value;
  if (value !== null && value !== undefined && typeof value.url === 'string') return value.url;
  return null;
}
