import { normalizeArxivId } from '@trendr/core';

/**
 * Spec §7.3.5 — arXiv URL/id maths. The export API and the abstract pages use
 * different hosts: `export.arxiv.org` is the only API host on the worker
 * allowlist, while public links always point at `arxiv.org/abs/{id}`. PDF
 * links are metadata only; the adapter never downloads them.
 */

export const ARXIV_EXPORT_BASE = 'https://export.arxiv.org';
export const ARXIV_API_QUERY = `${ARXIV_EXPORT_BASE}/api/query`;
export const ARXIV_WEB_BASE = 'https://arxiv.org';

/** Spec §7.3.5 discovery categories. */
export const ARXIV_CATEGORIES = ['cs.AI', 'cs.CL', 'cs.LG', 'cs.CV'] as const;

/** Terms of Use: one 200-item page keeps discovery to a handful of calls. */
export const ARXIV_PAGE_SIZE = 200;
/** Discovery stops at `published < now − 3 days` (spec §7.3.5). */
export const ARXIV_DISCOVERY_DAYS = 3;
/** Defensive cap; the 3-day window normally needs 1–15 pages. */
export const ARXIV_MAX_PAGES = 15;
/** One daily discovery pass (15 pages) covers the 3-day window. */
export const ARXIV_DISCOVERY_MAX_ITEMS = 3_000;
/** Keep /api/papers fallback calls under the §7.3.5 hourly budget. */
export const ARXIV_DETAIL_BUDGET_PER_HOUR = 300;
/** HF daily-paper feed: one request per UTC day (spec §7.3.5). */
export const HF_DAILY_PAPERS_LIMIT = 100;
export const HF_DAILY_PAPERS_CACHE_MS = 3_600_000;
export const HF_PAPERS_API = 'https://huggingface.co/api';

const DAY_MS = 86_400_000;
const NEW_ARXIV_ID = /^\d{4}\.\d{4,5}$/;
const OLD_ARXIV_ID = /^[a-z][a-z-]*(?:\.[a-z]{2})?\/\d{7}$/i;

/** `GET /api/query?...&start={n}&max_results=200` (spec §7.3.5). */
export function arxivQueryUrl(start: number, maxResults = ARXIV_PAGE_SIZE): string {
  const query = ARXIV_CATEGORIES.map((category) => `cat:${category}`).join('+OR+');
  return (
    `${ARXIV_API_QUERY}?search_query=${query}` +
    `&sortBy=submittedDate&sortOrder=descending&start=${Math.max(0, Math.floor(start))}` +
    `&max_results=${Math.max(1, Math.floor(maxResults))}`
  );
}

/** `2610.21185v2` / `http://arxiv.org/abs/2610.21185v2` → `2610.21185`. */
export function canonicalArxivId(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return null;

  let candidate = value.replace(/^arxiv:/i, '');
  try {
    const url = new URL(candidate);
    if (url.hostname !== 'arxiv.org' && url.hostname !== 'export.arxiv.org') return null;
    const parts = url.pathname.split('/').filter((part) => part !== '');
    if (parts[0] !== 'abs' && parts[0] !== 'pdf') return null;
    candidate = parts
      .slice(1)
      .join('/')
      .replace(/\.pdf$/i, '');
  } catch {
    // Not a URL: accept the bare id form (`2610.21185v3`).
  }

  const id = normalizeArxivId(candidate.replace(/^\/+|\/+$/g, ''));
  return NEW_ARXIV_ID.test(id) || OLD_ARXIV_ID.test(id) ? id : null;
}

function encodedArxivPath(id: string): string {
  return id
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** Canonical abstract page (never the versioned URL). */
export function arxivAbstractUrl(id: string): string {
  return `${ARXIV_WEB_BASE}/abs/${encodedArxivPath(id)}`;
}

/** PDF link kept in metadata only (spec §7.3.5: never store/serve the file). */
export function arxivPdfUrl(id: string): string {
  return `${ARXIV_WEB_BASE}/pdf/${encodedArxivPath(id)}`;
}

/** UTC calendar day used by the HF daily-paper feed (`YYYY-MM-DD`). */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function shiftUtcDay(date: Date, deltaDays: number): Date {
  return new Date(date.getTime() + deltaDays * DAY_MS);
}

/** `GET https://huggingface.co/api/daily_papers?date=YYYY-MM-DD&limit=100`. */
export function hfDailyPapersUrl(day: string, limit = HF_DAILY_PAPERS_LIMIT): string {
  const params = new URLSearchParams({
    date: day,
    limit: String(Math.max(1, Math.floor(limit))),
  });
  return `${HF_PAPERS_API}/daily_papers?${params.toString()}`;
}

/** `GET https://huggingface.co/api/papers/{arxivId}`. */
export function hfPaperUrl(id: string): string {
  return `${HF_PAPERS_API}/papers/${encodedArxivPath(id)}`;
}
