import { normalizeTopicSlugs, safeHttpUrl } from '@trendr/core';

import type { FetchedItem, NormalizedItem } from '../adapter.js';
import { parseGitHubRepositoryUrl } from '../npm/downloads.js';
import type { ArxivEntry } from './atom.js';
import type { HfPaper } from './schemas.js';
import { arxivAbstractUrl, canonicalArxivId } from './urls.js';

/**
 * Spec §7.3.5 — pure normalization. Discovery payloads are full arXiv Atom
 * entries; snapshot payloads are HF paper records that carry the only
 * popularity signal (`upvotes`) and, when known, the linked code repo.
 */

export type ArxivRaw =
  | { kind: 'atom'; entry: ArxivEntry }
  | { kind: 'hf-daily'; paper: HfPaper | null }
  | { kind: 'hf-detail'; paper: HfPaper | null };

/** Spec §7.1 step 5 category mapping, exactly the four discovery categories. */
const CATEGORY_TOPICS: Readonly<Record<string, string>> = {
  'cs.ai': 'ai',
  'cs.cl': 'nlp',
  'cs.cv': 'computer-vision',
  'cs.lg': 'machine-learning',
};

function cleanString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned === '' ? null : cleaned;
}

function topicsFor(categories: readonly string[]): string[] {
  return normalizeTopicSlugs(
    categories.map((category) => CATEGORY_TOPICS[category.toLowerCase()] ?? category),
  );
}

function metadataForEntry(entry: ArxivEntry): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    categories: entry.categories,
    abstract: entry.summary,
    abstractUrl: entry.abstractUrl,
    pdfUrl: entry.pdfUrl,
  };
  if (entry.authors.length > 0) metadata.authors = entry.authors;
  if (entry.primaryCategory !== null) metadata.primaryCategory = entry.primaryCategory;
  if (entry.comment !== null) metadata.comment = entry.comment;
  if (entry.doi !== null) metadata.doi = entry.doi;
  if (entry.journalRef !== null) metadata.journalRef = entry.journalRef;
  if (entry.updatedAt !== null) metadata.updatedAt = entry.updatedAt.toISOString();
  return metadata;
}

function metadataForPaper(paper: HfPaper): Record<string, unknown> {
  const metadata: Record<string, unknown> = { hfPaperId: paper.id };
  const authors = (paper.authors ?? [])
    .map((author) => cleanString(author.name))
    .filter((name): name is string => name !== null);
  if (authors.length > 0) metadata.authors = authors;
  const summary = cleanString(paper.summary);
  if (summary !== null) metadata.abstract = summary;
  const githubRepo = cleanString(paper.githubRepo);
  if (githubRepo !== null) metadata.githubRepo = githubRepo;
  if (paper.githubStars !== null && paper.githubStars !== undefined) {
    metadata.githubStars = paper.githubStars;
  }
  if (paper.organization !== null && paper.organization !== undefined) {
    const organization = cleanString(paper.organization.name ?? paper.organization.fullname);
    if (organization !== null) metadata.organization = organization;
  }
  for (const key of ['numTotalModels', 'numTotalDatasets', 'numTotalSpaces'] as const) {
    const value = paper[key];
    if (value !== null && value !== undefined) metadata[key] = value;
  }
  return metadata;
}

function paperAliases(paper: HfPaper): NormalizedItem['aliases'] {
  const repository = parseGitHubRepositoryUrl(paper.githubRepo);
  if (repository === null) return [];
  return [
    {
      source: 'github',
      kind: 'repo',
      externalId: repository,
      relation: 'paper_code',
      confidence: 0.9,
      evidence: 'hf.paper.githubRepo',
    },
  ];
}

function normalizeEntry(refExternalId: string, entry: ArxivEntry): NormalizedItem | null {
  const externalId = canonicalArxivId(entry.externalId) ?? canonicalArxivId(refExternalId);
  if (externalId === null) return null;

  return {
    item: {
      source: 'arxiv',
      kind: 'paper',
      externalId,
      upstreamId: null,
      name: externalId,
      displayName: entry.title,
      description: entry.summary === null ? null : entry.summary.slice(0, 1_000),
      url: arxivAbstractUrl(externalId),
      homepage: null,
      language: null,
      license: null,
      owner: null,
      topics: topicsFor(entry.categories),
      primaryMetric: 'upvotes',
      upstreamCreatedAt: entry.publishedAt,
      isArchived: false,
      metadata: metadataForEntry(entry),
    },
    snapshots: [],
    daily: [],
    aliases: [],
  };
}

function normalizePaper(refExternalId: string, paper: HfPaper): NormalizedItem | null {
  const externalId = canonicalArxivId(paper.id) ?? canonicalArxivId(refExternalId);
  if (externalId === null) return null;

  const summary = cleanString(paper.summary);
  const title = cleanString(paper.title) ?? externalId;
  const publishedAt =
    paper.publishedAt === null || paper.publishedAt === undefined
      ? null
      : new Date(paper.publishedAt);
  const upstreamCreatedAt =
    publishedAt === null || Number.isNaN(publishedAt.getTime()) ? null : publishedAt;

  return {
    item: {
      source: 'arxiv',
      kind: 'paper',
      externalId,
      upstreamId: null,
      name: externalId,
      displayName: title,
      description: summary === null ? null : summary.slice(0, 1_000),
      url: arxivAbstractUrl(externalId),
      homepage: safeHttpUrl(paper.projectPage),
      language: null,
      license: null,
      owner: null,
      topics: [],
      primaryMetric: 'upvotes',
      upstreamCreatedAt,
      isArchived: false,
      metadata: metadataForPaper(paper),
    },
    snapshots:
      paper.upvotes === null || paper.upvotes === undefined
        ? []
        : [{ metric: 'upvotes', value: paper.upvotes }],
    daily: [],
    aliases: paperAliases(paper),
  };
}

/** Spec §5.1 `normalize` — pure payload → canonical shape (fixture-tested). */
export function normalizeArxivItem(fetched: FetchedItem<ArxivRaw>): NormalizedItem | null {
  if (fetched.notFound === true || fetched.notModified === true) return null;
  const raw = fetched.raw;
  switch (raw.kind) {
    case 'atom':
      return normalizeEntry(fetched.ref.externalId, raw.entry);
    case 'hf-daily':
    case 'hf-detail':
      return raw.paper === null ? null : normalizePaper(fetched.ref.externalId, raw.paper);
  }
}
