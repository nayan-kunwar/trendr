import { XMLParser } from 'fast-xml-parser';

import { UpstreamError } from '@trendr/core';

import { ArxivFeedSchema, type RawArxivEntry } from './schemas.js';
import { arxivAbstractUrl, arxivPdfUrl, canonicalArxivId } from './urls.js';

/**
 * Spec §7.3.5 — Atom 1.0 parser. `fast-xml-parser` collapses one entry/author/
 * category/link into an object and several into arrays, so every repeated node
 * goes through `asArray`. An API error is also a valid feed (one entry titled
 * "Error"); it must fail the job non-retryably instead of becoming an item.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

export interface ArxivEntry {
  externalId: string;
  title: string;
  summary: string | null;
  authors: string[];
  categories: string[];
  primaryCategory: string | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
  abstractUrl: string;
  pdfUrl: string;
  comment: string | null;
  doi: string | null;
  journalRef: string | null;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanInline(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned === '' ? null : cleaned;
}

function parseDate(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function uniqueTerms(primary: string | null, categories: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of [primary, ...categories]) {
    if (term === null || term === '') continue;
    if (seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}

function toEntry(raw: RawArxivEntry): ArxivEntry | null {
  const externalId = canonicalArxivId(raw.id);
  if (externalId === null) return null;

  const primaryCategory = cleanInline(raw.primary_category?.['@_term']);
  const categories = asArray(raw.category)
    .map((category) => cleanInline(category['@_term']))
    .filter((term): term is string => term !== null);
  const authors = asArray(raw.author)
    .map((author) => cleanInline(author.name))
    .filter((name): name is string => name !== null);

  return {
    externalId,
    title: cleanInline(raw.title) ?? externalId,
    summary: cleanInline(raw.summary),
    authors,
    categories: uniqueTerms(primaryCategory, categories),
    primaryCategory,
    publishedAt: parseDate(raw.published) ?? parseDate(raw.updated),
    updatedAt: parseDate(raw.updated),
    // Keep the public links unversioned; PDFs are never downloaded.
    abstractUrl: arxivAbstractUrl(externalId),
    pdfUrl: arxivPdfUrl(externalId),
    comment: cleanInline(raw.comment),
    doi: cleanInline(raw.doi),
    journalRef: cleanInline(raw.journal_ref),
  };
}

/** Parse an arXiv Atom response; throws a non-retryable `UpstreamError` on errors. */
export function parseArxivAtom(xml: string): ArxivEntry[] {
  let parsed: unknown;
  try {
    parsed = parser.parse(xml) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UpstreamError(`invalid arXiv Atom XML: ${detail}`, 'arxiv', null, null, false);
  }

  const result = ArxivFeedSchema.safeParse(parsed);
  if (!result.success) {
    throw new UpstreamError(
      `arXiv Atom schema mismatch: ${result.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
      'arxiv',
      null,
      null,
      false,
    );
  }

  const rawEntries = asArray(result.data.feed.entry);
  for (const entry of rawEntries) {
    if (entry.title.trim().toLowerCase() === 'error' || entry.id.includes('/api/errors')) {
      const detail = cleanInline(entry.summary) ?? cleanInline(entry.title) ?? 'unknown API error';
      throw new UpstreamError(`arXiv API error feed: ${detail}`, 'arxiv', null, null, false);
    }
  }

  const entries: ArxivEntry[] = [];
  const seen = new Set<string>();
  for (const raw of rawEntries) {
    const entry = toEntry(raw);
    if (entry === null || seen.has(entry.externalId)) continue;
    seen.add(entry.externalId);
    entries.push(entry);
  }
  return entries;
}
