import { normalizeArxivId, normalizeHuggingFaceId, type HuggingFaceRepoKind } from '@trendr/core';

/**
 * Spec §7.3.4 — Hugging Face URL and header maths. The list endpoint's next
 * page is carried in the `Link` header as an absolute URL; detail calls use
 * the same host but a per-kind `expand[]` set (spaces do not expose downloads
 * and models/datasets do not expose `description`).
 */

export const HF_BASE = 'https://huggingface.co';
export const HF_API_BASE = `${HF_BASE}/api`;
export const HF_LIST_LIMIT = 100;
/** §7.3.4: 5 pages trending + 2 pages newest per hourly pass. */
export const HF_TRENDING_PAGES = 5;
export const HF_NEWEST_PAGES = 2;
export const HF_LIKES_PAGES = 10;
export const HF_OPTIONAL_PAGES = 2;
/**
 * Hard cap for one hourly pass: 700 model items plus the optional dataset and
 * space phases (2 pages each). With both flags off only 700 are emitted.
 */
export const HF_DISCOVERY_MAX_ITEMS = 1_100;
export const HF_NEWEST_MIN_LIKES = 5;

export const HF_LIST_EXPANDS: Readonly<Record<HuggingFaceRepoKind, readonly string[]>> = {
  model: [
    'likes',
    'downloads',
    'downloadsAllTime',
    'trendingScore',
    'createdAt',
    'pipeline_tag',
    'tags',
    'library_name',
    'gated',
    'disabled',
  ],
  dataset: [
    'likes',
    'downloads',
    'downloadsAllTime',
    'trendingScore',
    'createdAt',
    'tags',
    'description',
    'gated',
    'disabled',
  ],
  // Spaces have no downloads/downloadsAllTime and do not accept `gated`.
  space: ['likes', 'trendingScore', 'createdAt', 'tags', 'sdk', 'disabled'],
};

export const HF_DETAIL_EXPANDS: Readonly<Record<HuggingFaceRepoKind, readonly string[]>> = {
  model: [
    'likes',
    'downloads',
    'downloadsAllTime',
    'trendingScore',
    'createdAt',
    'pipeline_tag',
    'tags',
    'library_name',
    'gated',
    'disabled',
  ],
  dataset: [
    'likes',
    'downloads',
    'downloadsAllTime',
    'trendingScore',
    'createdAt',
    'tags',
    'description',
    'gated',
    'disabled',
  ],
  space: ['likes', 'trendingScore', 'createdAt', 'tags', 'sdk', 'disabled'],
};

const KIND_PREFIX: Record<HuggingFaceRepoKind, string> = {
  model: 'models',
  dataset: 'datasets',
  space: 'spaces',
};

/** `models/owner/name`, `datasets/squad`, `spaces/owner/name`. */
export function parseHuggingFaceExternalId(
  externalId: string,
): { kind: HuggingFaceRepoKind; repoId: string } | null {
  const slash = externalId.indexOf('/');
  if (slash <= 0 || slash === externalId.length - 1) return null;
  const prefix = externalId.slice(0, slash);
  const repoId = externalId.slice(slash + 1);
  const kind = (Object.keys(KIND_PREFIX) as HuggingFaceRepoKind[]).find(
    (candidate) => KIND_PREFIX[candidate] === prefix,
  );
  return kind === undefined ? null : { kind, repoId };
}

export function huggingFaceExternalId(kind: HuggingFaceRepoKind, repoId: string): string {
  return normalizeHuggingFaceId(kind, repoId);
}

function encodedRepoPath(repoId: string): string {
  return repoId
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** `GET /api/models?sort=trendingScore&direction=-1&limit=100&expand[]=...` */
export function hfListUrl(kind: HuggingFaceRepoKind, sort: string, limit = HF_LIST_LIMIT): string {
  const expands = HF_LIST_EXPANDS[kind].map((field) => `expand[]=${field}`).join('&');
  return `${HF_API_BASE}/${KIND_PREFIX[kind]}?sort=${encodeURIComponent(sort)}&direction=-1&limit=${limit}&${expands}`;
}

/** `GET /api/models/{repo_id}?expand[]=...` */
export function hfDetailUrl(kind: HuggingFaceRepoKind, repoId: string): string {
  const expands = HF_DETAIL_EXPANDS[kind].map((field) => `expand[]=${field}`).join('&');
  return `${HF_API_BASE}/${KIND_PREFIX[kind]}/${encodedRepoPath(repoId)}?${expands}`;
}

/** Canonical public page, e.g. `https://huggingface.co/datasets/squad`. */
export function hfRepoUrl(kind: HuggingFaceRepoKind, repoId: string): string {
  const prefix = kind === 'model' ? '' : `${KIND_PREFIX[kind]}/`;
  return `${HF_BASE}/${prefix}${repoId}`;
}

/** `Link: <https://huggingface.co/api/...>; rel="next"` → absolute next URL. */
export function hfNextLink(headers: Headers): string | null {
  const link = headers.get('link');
  if (link === null) return null;
  const match = /<([^>]+)>;\s*rel="next"/i.exec(link);
  if (match?.[1] === undefined) return null;
  try {
    const url = new URL(match[1], HF_BASE);
    if (url.protocol !== 'https:' || url.hostname !== 'huggingface.co') return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * HF 429s carry the reset in `RateLimit: "api";r={remaining};t={seconds}` and
 * no `Retry-After`. `t=0` means the window has already reset, but retrying
 * immediately can amplify the block; use a one-second floor.
 */
export function hfRateLimitDelayMs(headers: Headers): number | null {
  const value = headers.get('ratelimit');
  const match = /;\s*t=(\d+)/i.exec(value ?? '');
  if (match?.[1] === undefined) return null;
  return Math.max(1, Number(match[1])) * 1_000;
}

/** Observed `RateLimit: "api";r=499;t=163` → gauge state for §14.1. */
export function hfRateLimitInfo(
  headers: Headers,
  now: Date,
): { resource: string; remaining: number; resetAt: Date | null } | null {
  const value = headers.get('ratelimit');
  if (value === null) return null;
  const remaining = /;\s*r=(\d+)/i.exec(value)?.[1];
  if (remaining === undefined) return null;
  const seconds = /;\s*t=(\d+)/i.exec(value)?.[1];
  return {
    resource: 'api',
    remaining: Number(remaining),
    resetAt:
      seconds === undefined ? null : new Date(now.getTime() + Math.max(1, Number(seconds)) * 1_000),
  };
}

/** `arxiv:1810.04805` → `1810.04805` (version suffix stripped). */
export function arxivTagId(tag: string): string | null {
  const match = /^arxiv:(.+)$/i.exec(tag.trim());
  if (match?.[1] === undefined) return null;
  const id = normalizeArxivId(match[1].replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, ''));
  return id === '' ? null : id;
}
