import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { FetchedItem } from '../adapter.js';
import type { GitHubRestRepo } from '../github/schemas.js';
import type { NpmSearchResult } from '../npm/schemas.js';
import { normalizeMcpItem, type McpRaw } from './normalize.js';
import type { McpRegistryEntry } from './schemas.js';

function readFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
}

const REGISTRY = (readFixture('registry-entries.json') as { servers: McpRegistryEntry[] }).servers;
const GITHUB = (readFixture('github-search.json') as { items: GitHubRestRepo[] }).items;
const NPM = (readFixture('npm-search.json') as { objects: NpmSearchResult[] }).objects;
const META = readFixture('meta.json') as {
  registry: { deletedFixture: string; schema: string };
  github: { query: string };
  npm: { query: string };
};

function registryEntry(name: string): McpRegistryEntry {
  const entry = REGISTRY.find((candidate) => candidate.server.name === name);
  if (entry === undefined) throw new Error(`missing registry fixture ${name}`);
  return entry;
}

function normalizeRegistry(name: string) {
  const entry = registryEntry(name);
  return normalizeMcpItem({
    ref: { source: 'mcp', kind: 'mcp_server', externalId: entry.server.name },
    raw: { kind: 'registry', entry },
    fetchedAt: new Date('2026-10-20T12:00:00Z'),
  });
}

describe('MCP normalization (spec §7.3.6)', () => {
  it('normalizes a registry entry with a GitHub repo and npm package', () => {
    const normalized = normalizeRegistry('ai.agenttrust/mcp-server');
    expect(normalized).not.toBeNull();
    if (normalized === null) throw new Error('expected registry item');

    expect(normalized.item).toMatchObject({
      source: 'mcp',
      kind: 'mcp_server',
      externalId: 'ai.agenttrust/mcp-server',
      upstreamId: 'ai.agenttrust/mcp-server',
      name: 'mcp-server',
      displayName: 'AgentTrust — Identity & Trust for A2A Agents',
      homepage: 'https://agenttrust.ai',
      owner: 'ai.agenttrust',
      primaryMetric: 'stars',
      isArchived: false,
      flags: [],
    });
    expect(normalized.item.url).toBe(
      'https://registry.modelcontextprotocol.io/v0.1/servers/ai.agenttrust%2Fmcp-server/versions/latest',
    );
    expect(normalized.item.topics).toContain('mcp');
    expect(normalized.item.metadata).toMatchObject({
      registryStatus: 'active',
      registrySchema: META.registry.schema,
      registryVersion: '1.1.1',
      repositoryUrl: 'https://github.com/agenttrust/mcp-server',
      packages: [{ registryType: 'npm', identifier: '@agenttrust/mcp-server', version: '1.1.1' }],
    });
    expect(normalized.aliases).toEqual([
      {
        source: 'github',
        kind: 'repo',
        externalId: 'agenttrust/mcp-server',
        relation: 'mcp_server_of',
        confidence: 0.95,
        evidence: 'mcp.registry.repository',
      },
      {
        source: 'npm',
        kind: 'package',
        externalId: '@agenttrust/mcp-server',
        relation: 'registry_entry_of',
        confidence: 0.95,
        evidence: 'mcp.registry.packages',
      },
    ]);
    expect(normalized.snapshots).toEqual([]);
    expect(normalized.daily).toEqual([]);
  });

  it('uses downloads as primary when the registry entry has no GitHub repo', () => {
    const withPackage = normalizeRegistry('agency.kesey/pretrip');
    expect(withPackage?.item.primaryMetric).toBe('downloads');
    expect(withPackage?.aliases).toEqual([
      {
        source: 'npm',
        kind: 'package',
        externalId: 'pretrip-mcp',
        relation: 'registry_entry_of',
        confidence: 0.95,
        evidence: 'mcp.registry.packages',
      },
    ]);

    const bare = normalizeRegistry('ac.snag/snag');
    expect(bare?.item.primaryMetric).toBe('downloads');
    expect(bare?.aliases).toEqual([]);
  });

  it('marks a deleted registry entry as deleted and drops its aliases', () => {
    const normalized = normalizeRegistry(META.registry.deletedFixture);
    expect(normalized).not.toBeNull();
    expect(normalized?.deleted).toBe(true);
    expect(normalized?.item.isArchived).toBe(true);
    expect(normalized?.aliases).toEqual([]);
    expect(normalized?.item.metadata).toMatchObject({ registryStatus: 'deleted' });
  });

  it('normalizes GitHub-topic and npm-keyword fallbacks with their aliases and thresholds data', () => {
    const repo = GITHUB[0];
    const pkg = NPM[0];
    if (repo === undefined || pkg === undefined) throw new Error('fallback fixtures are empty');

    const gh = normalizeMcpItem({
      ref: {
        source: 'mcp',
        kind: 'mcp_server',
        externalId: `github:${repo.full_name.toLowerCase()}`,
      },
      raw: { kind: 'github', repo, query: META.github.query },
      fetchedAt: new Date('2026-10-20T12:00:00Z'),
    });
    expect(gh?.item).toMatchObject({
      source: 'mcp',
      kind: 'mcp_server',
      externalId: `github:${repo.full_name.toLowerCase()}`,
      upstreamId: null,
      primaryMetric: 'stars',
      displayName: `github:${repo.full_name.toLowerCase()}`,
    });
    expect(gh?.snapshots).toEqual([{ metric: 'stars', value: repo.stargazers_count }]);
    expect(gh?.aliases).toEqual([
      {
        source: 'github',
        kind: 'repo',
        externalId: repo.full_name.toLowerCase(),
        relation: 'mcp_server_of',
        confidence: 1,
        evidence: 'mcp.github.topic',
      },
    ]);

    const npm = normalizeMcpItem({
      ref: {
        source: 'mcp',
        kind: 'mcp_server',
        externalId: `npm:${pkg.package.name}`,
      },
      raw: { kind: 'npm', result: pkg, keyword: 'mcp-server' },
      fetchedAt: new Date('2026-10-20T12:00:00Z'),
    });
    expect(npm?.item).toMatchObject({
      source: 'mcp',
      externalId: `npm:${pkg.package.name}`,
      primaryMetric: 'downloads',
    });
    expect(npm?.aliases).toEqual([
      {
        source: 'npm',
        kind: 'package',
        externalId: pkg.package.name,
        relation: 'registry_entry_of',
        confidence: 1,
        evidence: 'mcp.npm.keyword',
      },
    ]);
  });

  it('normalizes derived metrics: stars win as primary, downloads stay daily', () => {
    const normalized = normalizeMcpItem({
      ref: { source: 'mcp', kind: 'mcp_server', externalId: 'ai.example/server' },
      raw: {
        kind: 'derived',
        metrics: {
          latest: { stars: 1234, downloads: 56 },
          daily: [
            { metric: 'downloads', day: '2026-10-19', value: 50 },
            { metric: 'downloads', day: '2026-10-20', value: 56 },
          ],
        },
      },
      fetchedAt: new Date('2026-10-20T12:00:00Z'),
    });
    expect(normalized?.item.primaryMetric).toBe('stars');
    expect(normalized?.snapshots).toEqual([{ metric: 'stars', value: 1234 }]);
    expect(normalized?.daily).toEqual([
      { metric: 'downloads', day: '2026-10-19', value: 50 },
      { metric: 'downloads', day: '2026-10-20', value: 56 },
    ]);

    const downloadsOnly = normalizeMcpItem({
      ref: { source: 'mcp', kind: 'mcp_server', externalId: 'npm:example-mcp' },
      raw: { kind: 'derived', metrics: { latest: { downloads: 7 }, daily: [] } },
      fetchedAt: new Date('2026-10-20T12:00:00Z'),
    });
    expect(downloadsOnly?.item.primaryMetric).toBe('downloads');
    expect(downloadsOnly?.snapshots).toEqual([]);

    const empty = normalizeMcpItem({
      ref: { source: 'mcp', kind: 'mcp_server', externalId: 'github:owner/repo' },
      raw: { kind: 'derived', metrics: { latest: {}, daily: [] } },
      fetchedAt: new Date('2026-10-20T12:00:00Z'),
    });
    expect(empty?.item.primaryMetric).toBe('downloads');
    expect(empty?.snapshots).toEqual([]);
    expect(empty?.daily).toEqual([]);
  });

  it('returns null for notFound/notModified fetches and invalid payloads', () => {
    const fetched: FetchedItem<McpRaw> = {
      ref: { source: 'mcp', kind: 'mcp_server', externalId: 'ai.example/server' },
      raw: {
        kind: 'derived',
        metrics: { latest: {}, daily: [] },
      },
      fetchedAt: new Date(),
      notFound: true,
    };
    expect(normalizeMcpItem(fetched)).toBeNull();
  });
});
