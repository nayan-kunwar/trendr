import {
  mcpGitHubFallback,
  mcpNpmFallback,
  normalizeMcpName,
  normalizeNpmPackage,
  normalizePyPiName,
  normalizeTopicSlugs,
  safeHttpUrl,
  type ItemFlag,
} from '@trendr/core';

import type { DerivedMetrics, FetchedItem, NormalizedItem } from '../adapter.js';
import type { GitHubRestRepo } from '../github/schemas.js';
import { parseGitHubRepositoryUrl } from '../npm/downloads.js';
import type { NpmSearchResult } from '../npm/schemas.js';
import type { McpPackage, McpRegistryEntry } from './schemas.js';
import { mcpServerPageUrl } from './urls.js';

/**
 * Spec §7.3.6 — pure normalization for the three MCP discovery paths:
 * registry entries, GitHub-topic fallbacks and npm-keyword fallbacks. A fourth
 * raw variant carries metrics copied from alias targets for snapshots.
 */

export type McpRaw =
  | { kind: 'registry'; entry: McpRegistryEntry }
  | { kind: 'github'; repo: GitHubRestRepo; query: string }
  | { kind: 'npm'; result: NpmSearchResult; keyword: string }
  | { kind: 'derived'; metrics: DerivedMetrics };

export function normalizeMcpItem(fetched: FetchedItem<McpRaw>): NormalizedItem | null {
  if (fetched.notModified === true || fetched.notFound === true) return null;
  const raw = fetched.raw;
  switch (raw.kind) {
    case 'registry':
      return normalizeRegistry(raw.entry);
    case 'github':
      return normalizeGitHubFallback(raw.repo, raw.query);
    case 'npm':
      return normalizeNpmFallback(raw.result, raw.keyword);
    case 'derived':
      return normalizeDerived(fetched.ref.externalId, raw.metrics);
  }
}

function normalizeRegistry(entry: McpRegistryEntry): NormalizedItem | null {
  const server = entry.server;
  const externalId = normalizeMcpName(server.name);
  if (externalId === '') return null;

  const official = entry._meta['io.modelcontextprotocol.registry/official'];
  const status = cleanString(official.status)?.toLowerCase() ?? 'active';
  const repository = parseGitHubRepositoryUrl(server.repository?.url ?? null);
  const packages = packageAliases(server.packages ?? []);
  const hasGitHubAlias = repository !== null;
  const flags: ItemFlag[] = [];
  if (status === 'deprecated') flags.push('deprecated');
  const deleted = status === 'deleted';
  const aliases: NormalizedItem['aliases'] = [];
  if (!deleted) {
    if (repository !== null) {
      aliases.push({
        source: 'github',
        kind: 'repo',
        externalId: repository,
        relation: 'mcp_server_of',
        confidence: 0.95,
        evidence: 'mcp.registry.repository',
      });
    }
    for (const target of packages) {
      aliases.push({
        source: target.source,
        kind: 'package',
        externalId: target.externalId,
        relation: 'registry_entry_of',
        confidence: 0.95,
        evidence: 'mcp.registry.packages',
      });
    }
  }

  const metadata: Record<string, unknown> = {
    registryStatus: status,
    registrySchema: server.$schema ?? null,
    registryVersion: server.version ?? null,
    registryUpdatedAt: official.updatedAt ?? null,
    registryPublishedAt: official.publishedAt ?? null,
    repositoryUrl: repository === null ? null : `https://github.com/${repository}`,
    packages: packages.map((pkg) => pkg.metadata),
    remotes: (server.remotes ?? []).map((remote) => ({
      type: remote.type,
      url: remote.url,
    })),
  };

  return {
    item: {
      source: 'mcp',
      kind: 'mcp_server',
      externalId,
      upstreamId: externalId,
      name: shortName(externalId),
      displayName: cleanString(server.title) ?? externalId,
      description: cleanDescription(server.description),
      url: mcpServerPageUrl(externalId),
      homepage: safeHttpUrl(server.websiteUrl),
      language: null,
      license: null,
      owner: ownerOf(externalId),
      topics: normalizeTopicSlugs(['mcp', ...publisherTopics(server._meta)]),
      primaryMetric: hasGitHubAlias ? 'stars' : 'downloads',
      upstreamCreatedAt: dateOrNull(official.publishedAt),
      isArchived: deleted,
      flags,
      metadata,
    },
    snapshots: [],
    daily: [],
    aliases: dedupeAliases(aliases),
    ...(deleted ? { deleted: true } : {}),
  };
}

function normalizeGitHubFallback(repo: GitHubRestRepo, query: string): NormalizedItem | null {
  let externalId: string;
  try {
    externalId = mcpGitHubFallback(repo.full_name);
  } catch {
    return null;
  }
  const fullName = externalId.slice('github:'.length);
  const license = repo.license?.spdx_id;
  const flags: ItemFlag[] = [];
  if (repo.fork) flags.push('fork');

  return {
    item: {
      source: 'mcp',
      kind: 'mcp_server',
      externalId,
      upstreamId: null,
      name: repo.name,
      displayName: externalId,
      description: cleanDescription(repo.description),
      url: repo.html_url,
      homepage: safeHttpUrl(repo.homepage),
      language: cleanString(repo.language),
      license:
        license === null || license === undefined || license === 'NOASSERTION' ? null : license,
      owner: repo.owner.login.toLowerCase(),
      topics: normalizeTopicSlugs(repo.topics ?? []),
      primaryMetric: 'stars',
      upstreamCreatedAt: dateOrNull(repo.created_at),
      isArchived: repo.archived,
      flags,
      metadata: {
        githubStars: repo.stargazers_count,
        githubForks: repo.forks_count,
        githubPushedAt: repo.pushed_at,
        discoveryQuery: query,
      },
    },
    snapshots: [{ metric: 'stars', value: repo.stargazers_count }],
    daily: [],
    aliases: [
      {
        source: 'github',
        kind: 'repo',
        externalId: fullName,
        relation: 'mcp_server_of',
        confidence: 1,
        evidence: 'mcp.github.topic',
      },
    ],
  };
}

function normalizeNpmFallback(result: NpmSearchResult, keyword: string): NormalizedItem | null {
  const pkg = result.package;
  let externalId: string;
  try {
    externalId = mcpNpmFallback(pkg.name);
  } catch {
    return null;
  }
  const packageName = externalId.slice('npm:'.length);
  const links = pkg.links;

  return {
    item: {
      source: 'mcp',
      kind: 'mcp_server',
      externalId,
      upstreamId: null,
      name: shortName(packageName),
      displayName: externalId,
      description: cleanDescription(pkg.description),
      url: safeHttpUrl(links?.npm) ?? `https://www.npmjs.com/package/${packageName}`,
      homepage: safeHttpUrl(links?.homepage),
      language: null,
      license: licenseString(pkg.license),
      owner: packageName.startsWith('@') ? (packageName.split('/')[0] ?? null) : null,
      topics: normalizeTopicSlugs(pkg.keywords ?? []),
      primaryMetric: 'downloads',
      upstreamCreatedAt: dateOrNull(pkg.date),
      isArchived: false,
      flags: [],
      metadata: {
        npmVersion: pkg.version ?? null,
        npmWeeklyDownloads: result.downloads?.weekly ?? null,
        npmMonthlyDownloads: result.downloads?.monthly ?? null,
        npmRepository: links?.repository ?? null,
        discoveryKeyword: keyword,
      },
    },
    snapshots: [],
    daily: [],
    aliases: [
      {
        source: 'npm',
        kind: 'package',
        externalId: packageName,
        relation: 'registry_entry_of',
        confidence: 1,
        evidence: 'mcp.npm.keyword',
      },
    ],
  };
}

/**
 * Spec §7.3.6 — snapshots never call the registry for a tracked MCP item: the
 * worker injects the alias-derived values. The derived row deliberately leaves
 * descriptive fields empty; the processor persists it with
 * `preserveMetadata` so discovery metadata survives.
 */
function normalizeDerived(externalId: string, metrics: DerivedMetrics): NormalizedItem | null {
  const canonical = normalizeMcpName(externalId);
  if (canonical === '') return null;
  const stars = finiteMetric(metrics.latest.stars);
  const snapshots: NormalizedItem['snapshots'] = [];
  if (stars !== undefined) snapshots.push({ metric: 'stars', value: stars });

  const daily = metrics.daily
    .filter(
      (point) =>
        point.metric === 'downloads' &&
        /^\d{4}-\d{2}-\d{2}$/.test(point.day) &&
        Number.isFinite(point.value) &&
        point.value >= 0,
    )
    .map((point) => ({
      metric: point.metric,
      day: point.day,
      value: Math.round(point.value),
    }));

  const decoded = decodeFallback(canonical);
  return {
    item: {
      source: 'mcp',
      kind: 'mcp_server',
      externalId: canonical,
      upstreamId:
        canonical.startsWith('github:') || canonical.startsWith('npm:') ? null : canonical,
      name: shortName(decoded),
      displayName: canonical,
      description: null,
      url: derivedUrl(canonical),
      homepage: null,
      language: null,
      license: null,
      owner: null,
      topics: [],
      primaryMetric: stars !== undefined ? 'stars' : 'downloads',
      upstreamCreatedAt: null,
      isArchived: false,
      flags: [],
      metadata: {},
    },
    snapshots,
    daily,
    aliases: [],
  };
}

function packageAliases(
  packages: readonly McpPackage[],
): { source: 'npm' | 'pypi'; externalId: string; metadata: Record<string, unknown> }[] {
  const result: {
    source: 'npm' | 'pypi';
    externalId: string;
    metadata: Record<string, unknown>;
  }[] = [];
  const seen = new Set<string>();
  for (const pkg of packages) {
    const registryType = pkg.registryType.toLowerCase();
    let source: 'npm' | 'pypi';
    let externalId: string;
    if (registryType === 'npm') {
      source = 'npm';
      externalId = normalizeNpmPackage(pkg.identifier);
    } else if (registryType === 'pypi') {
      source = 'pypi';
      externalId = normalizePyPiName(pkg.identifier);
    } else {
      continue;
    }
    if (externalId === '') continue;
    const key = `${source}:${externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      source,
      externalId,
      metadata: {
        registryType: pkg.registryType,
        identifier: pkg.identifier,
        version: pkg.version ?? null,
      },
    });
  }
  return result;
}

function dedupeAliases(aliases: NormalizedItem['aliases']): NormalizedItem['aliases'] {
  const seen = new Set<string>();
  return aliases.filter((alias) => {
    const key = `${alias.source}:${alias.externalId}:${alias.relation}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function publisherTopics(meta: Record<string, unknown> | null | undefined): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (!key.toLowerCase().includes('publisher-provided')) continue;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    for (const field of ['keywords', 'categories']) {
      const list = record[field];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (typeof entry === 'string') values.push(entry);
      }
    }
  }
  return values;
}

function decodeFallback(externalId: string): string {
  if (externalId.startsWith('github:')) return externalId.slice('github:'.length);
  if (externalId.startsWith('npm:')) return externalId.slice('npm:'.length);
  return externalId;
}

function derivedUrl(externalId: string): string {
  if (externalId.startsWith('github:')) return `https://github.com/${externalId.slice(7)}`;
  if (externalId.startsWith('npm:')) {
    return `https://www.npmjs.com/package/${externalId.slice(4)}`;
  }
  return mcpServerPageUrl(externalId);
}

function shortName(externalId: string): string {
  const slash = externalId.lastIndexOf('/');
  return slash === -1 ? externalId : externalId.slice(slash + 1);
}

function ownerOf(externalId: string): string | null {
  const slash = externalId.lastIndexOf('/');
  return slash === -1 ? null : externalId.slice(0, slash);
}

function cleanString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned === '' ? null : cleaned;
}

function cleanDescription(value: string | null | undefined): string | null {
  const cleaned = cleanString(value);
  return cleaned === null ? null : cleaned.slice(0, 2_000);
}

function dateOrNull(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function licenseString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return cleanString(value);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : null;
    const url = typeof record.url === 'string' ? record.url : null;
    return cleanString(type) ?? cleanString(url);
  }
  return null;
}

function finiteMetric(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}
