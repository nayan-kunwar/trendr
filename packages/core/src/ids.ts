import { ValidationError } from './errors.js';

/**
 * Spec §5.4 — canonical `external_id` normalizers. Adapters must pass every
 * upstream name through these before creating or looking up an item: the
 * canonical string is the natural key (`items` unique on (source, external_id)).
 */

/** GitHub repos: `owner/name`, lowercase. */
export function normalizeGitHubRepo(input: string): string {
  const [, owner, name] = /^([^\s/]+)\/([^\s/]+)$/.exec(input.trim()) ?? [];
  if (owner === undefined || name === undefined) {
    throw new ValidationError(`invalid GitHub repo "${input}" (expected "owner/name")`);
  }
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

/** npm packages: the name as published, lowercased (npm names are lowercase-only). */
export function normalizeNpmPackage(input: string): string {
  return input.trim().toLowerCase();
}

/** PyPI packages: PEP 503 normalization — `[-_.]+` runs collapse to `-`, lowercased. */
export function normalizePyPiName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-');
}

export type HuggingFaceRepoKind = 'model' | 'dataset' | 'space';

const HF_KIND_PREFIX: Record<HuggingFaceRepoKind, string> = {
  model: 'models',
  dataset: 'datasets',
  space: 'spaces',
};

/** Hugging Face repos: `{kind}s/{repo_id}` — e.g. `models/google/embeddinggemma-2`. */
export function normalizeHuggingFaceId(kind: HuggingFaceRepoKind, repoId: string): string {
  return `${HF_KIND_PREFIX[kind]}/${repoId.trim()}`;
}

/** arXiv papers: the id without its version suffix (`2610.21185v3` → `2610.21185`). */
export function normalizeArxivId(input: string): string {
  return input.trim().replace(/v\d+$/i, '');
}

/** MCP servers listed in the registry: `server.name`, canonical already. */
export function normalizeMcpName(input: string): string {
  return input.trim();
}

/** MCP servers found only outside the registry: `github:owner/name`. */
export function mcpGitHubFallback(repoSlug: string): string {
  return `github:${normalizeGitHubRepo(repoSlug)}`;
}

/** MCP servers found only outside the registry: `npm:<pkg>`. */
export function mcpNpmFallback(packageName: string): string {
  return `npm:${normalizeNpmPackage(packageName)}`;
}
