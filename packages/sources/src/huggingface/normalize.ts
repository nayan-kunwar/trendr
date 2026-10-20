import { normalizeTopicSlugs, type HuggingFaceRepoKind } from '@trendr/core';

import type { FetchedItem, NormalizedItem } from '../adapter.js';
import type { HfRepoPayload } from './schemas.js';
import { arxivTagId, hfRepoUrl, huggingFaceExternalId } from './urls.js';

/**
 * Spec §7.3.4 — pure HF payload → canonical item. The list and detail
 * responses share one shape; the only difference is which `expand[]` fields
 * the endpoint allows. `downloads` is the rolling ~30-day count and is written
 * only to `latest_metrics`; `downloadsAllTime` is the cumulative snapshot.
 */

export type HfRepo = HfRepoPayload;

export type HfRaw = { kind: 'list'; repo: HfRepo } | { kind: 'detail'; repo: HfRepo | null };

/** SPDX casing for the license tags HF returns in lowercase. */
const LICENSE_CASE: Readonly<Record<string, string>> = {
  'apache-2.0': 'Apache-2.0',
  'artistic-2.0': 'Artistic-2.0',
  'bsd-2-clause': 'BSD-2-Clause',
  'bsd-3-clause': 'BSD-3-Clause',
  'cc-by-4.0': 'CC-BY-4.0',
  'cc-by-nc-4.0': 'CC-BY-NC-4.0',
  'cc-by-nc-sa-4.0': 'CC-BY-NC-SA-4.0',
  'cc-by-sa-4.0': 'CC-BY-SA-4.0',
  'cc0-1.0': 'CC0-1.0',
  'epl-2.0': 'EPL-2.0',
  'eupl-1.2': 'EUPL-1.2',
  'gpl-2.0': 'GPL-2.0',
  'gpl-3.0': 'GPL-3.0',
  isc: 'ISC',
  'lgpl-2.1': 'LGPL-2.1',
  'lgpl-3.0': 'LGPL-3.0',
  mit: 'MIT',
  'mpl-2.0': 'MPL-2.0',
  unlicense: 'Unlicense',
  wtfpl: 'WTFPL',
};

function cleanString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function metadataRecord(
  entries: Record<string, string | null | undefined>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    const cleaned = cleanString(value);
    if (cleaned !== null) out[key] = cleaned;
  }
  return out;
}

function licenseFromTags(tags: readonly string[]): string | null {
  for (const tag of tags) {
    const match = /^license:(.+)$/i.exec(tag.trim());
    if (match?.[1] === undefined) continue;
    const value = match[1].trim();
    if (value === '') continue;
    return LICENSE_CASE[value.toLowerCase()] ?? value;
  }
  return null;
}

function topicsFor(kind: HuggingFaceRepoKind, repo: HfRepo): string[] {
  const tags = (repo.tags ?? []).filter((tag) => !tag.includes(':'));
  return normalizeTopicSlugs([
    repo.pipeline_tag ?? '',
    repo.library_name ?? '',
    kind === 'space' ? (repo.sdk ?? '') : '',
    ...tags,
  ]);
}

function createdAtFor(repo: HfRepo): Date | null {
  if (repo.createdAt === null || repo.createdAt === undefined) return null;
  const date = new Date(repo.createdAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

function arxivAliases(repo: HfRepo): NormalizedItem['aliases'] {
  const aliases: NormalizedItem['aliases'] = [];
  const seen = new Set<string>();
  for (const tag of repo.tags ?? []) {
    const arxivId = arxivTagId(tag);
    if (arxivId === null || seen.has(arxivId)) continue;
    seen.add(arxivId);
    aliases.push({
      source: 'arxiv',
      kind: 'paper',
      externalId: arxivId,
      relation: 'model_of_paper',
      confidence: 0.9,
      evidence: 'huggingface.tags.arxiv',
    });
  }
  return aliases;
}

function snapshotsFor(repo: HfRepo): NormalizedItem['snapshots'] {
  const snapshots: NormalizedItem['snapshots'] = [];
  if (typeof repo.likes === 'number' && Number.isFinite(repo.likes)) {
    snapshots.push({ metric: 'likes', value: repo.likes });
  }
  if (typeof repo.downloadsAllTime === 'number' && Number.isFinite(repo.downloadsAllTime)) {
    snapshots.push({ metric: 'downloads_total', value: repo.downloadsAllTime });
  }
  if (typeof repo.trendingScore === 'number' && Number.isFinite(repo.trendingScore)) {
    // `snapshots.value` is bigint (spec §5.2), while Hub trending scores can be
    // fractional (e.g. 1.5 or 14.4). Preserve the display/tie-break value at the
    // nearest integer instead of failing the whole page's snapshot insert.
    snapshots.push({ metric: 'trending_score', value: Math.round(repo.trendingScore) });
  }
  return snapshots;
}

/** Spec §5.1 `normalize` — pure payload → canonical shape (fixture-tested). */
export function normalizeHuggingFaceItem(fetched: FetchedItem<HfRaw>): NormalizedItem | null {
  if (fetched.notFound === true || fetched.notModified === true) return null;
  const repo = fetched.raw.repo;
  if (repo === null) return null;

  const kind = fetched.ref.kind;
  if (kind !== 'model' && kind !== 'dataset' && kind !== 'space') return null;

  const repoId = cleanString(repo.id);
  if (repoId === null) return null;
  const externalId = huggingFaceExternalId(kind, repoId);
  const slash = repoId.indexOf('/');
  const name = slash === -1 ? repoId : repoId.slice(slash + 1);
  const owner = slash === -1 ? null : repoId.slice(0, slash);
  const tags = repo.tags ?? [];
  const description = cleanString(repo.description);
  const gated = repo.gated !== null && repo.gated !== undefined && repo.gated !== false;
  const flags = gated ? (['gated'] as const) : undefined;

  return {
    item: {
      source: 'huggingface',
      kind,
      externalId,
      upstreamId: cleanString(repo._id),
      name,
      displayName: repoId,
      description: description === null ? null : description.slice(0, 1_000),
      url: hfRepoUrl(kind, repoId),
      homepage: null,
      language: null,
      license: licenseFromTags(tags),
      owner,
      topics: topicsFor(kind, repo),
      primaryMetric: 'likes',
      upstreamCreatedAt: createdAtFor(repo),
      isArchived: repo.disabled === true,
      ...(flags === undefined ? {} : { flags: [...flags] }),
      metadata: metadataRecord({
        pipelineTag: repo.pipeline_tag,
        libraryName: repo.library_name,
        sdk: repo.sdk,
        author: repo.author,
      }),
    },
    snapshots: snapshotsFor(repo),
    ...(typeof repo.downloads === 'number' && Number.isFinite(repo.downloads)
      ? { latestMetrics: { downloads: repo.downloads } }
      : {}),
    daily: [],
    aliases: arxivAliases(repo),
  };
}
