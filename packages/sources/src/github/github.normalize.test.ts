import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { FetchedItem } from '../adapter.js';
import { normalizeGitHubItem } from './github.adapter.js';
import {
  GitHubGraphqlEnvelopeSchema,
  GitHubRestRepoSchema,
  GitHubSearchResponseSchema,
} from './schemas.js';
import type { GitHubRepoRaw } from './schemas.js';

/**
 * Spec §18 task 4.3 — fixture tests for `normalize`: repo, archived, fork,
 * renamed, not found. Every fixture is validated through the same Zod schema
 * the adapter uses at runtime, so a payload-shape drift fails here first.
 */

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
}

function fetched(
  raw: GitHubRepoRaw | null,
  externalId = 'acme/vector-forge',
): FetchedItem<GitHubRepoRaw | null> {
  return {
    ref: { source: 'github', kind: 'repo', externalId },
    raw,
    fetchedAt: new Date('2026-10-19T00:00:00Z'),
  };
}

const graphqlEnvelope = GitHubGraphqlEnvelopeSchema.parse(fixture('graphql-batch.json'));

function graphqlField(name: string): GitHubRepoRaw {
  const value = graphqlEnvelope.data?.[name];
  if (value === undefined || value === null) throw new Error(`fixture ${name} missing`);
  return value as GitHubRepoRaw;
}

const searchResponse = GitHubSearchResponseSchema.parse(fixture('search-new-hot.json'));
const restRepo = GitHubRestRepoSchema.parse(fixture('rest-repo.json'));

describe('github normalize (spec §5.1, §7.3.1)', () => {
  it('maps a GraphQL repo to the canonical item and metrics', () => {
    const normalized = normalizeGitHubItem(fetched(graphqlField('r0')));
    expect(normalized).not.toBeNull();
    expect(normalized?.item).toMatchObject({
      source: 'github',
      kind: 'repo',
      externalId: 'acme/vector-forge',
      upstreamId: 'R_kgDOMYk3Xw',
      name: 'vector-forge',
      displayName: 'acme/vector-forge',
      description: 'Vector search toolkit for LLM agents',
      url: 'https://github.com/acme/vector-forge',
      homepage: 'https://vectorforge.dev',
      language: 'TypeScript',
      license: 'MIT',
      owner: 'acme',
      topics: ['mcp', 'llm', 'typescript', 'vector-search'],
      primaryMetric: 'stars',
      isArchived: false,
      flags: [],
    });
    expect(normalized?.item.upstreamCreatedAt?.toISOString()).toBe('2026-10-13T09:12:44.000Z');
    expect(normalized?.snapshots).toEqual([
      { metric: 'stars', value: 842 },
      { metric: 'forks', value: 37 },
      { metric: 'open_issues', value: 12 },
      { metric: 'watchers', value: 95 },
    ]);
    expect(normalized?.item.metadata).toEqual({ pushedAt: '2026-10-18T21:58:07Z' });
    expect(normalized?.daily).toEqual([]);
    expect(normalized?.aliases).toEqual([]);
  });

  it('maps a REST repo (subscribers → watchers, empty homepage → null)', () => {
    const normalized = normalizeGitHubItem(fetched(restRepo));
    expect(normalized?.item.externalId).toBe('acme/vector-forge');
    expect(normalized?.item.upstreamId).toBe('R_kgDOMYk3Xw');
    expect(normalized?.snapshots).toEqual([
      { metric: 'stars', value: 842 },
      { metric: 'forks', value: 37 },
      { metric: 'open_issues', value: 12 },
      { metric: 'watchers', value: 95 },
    ]);
  });

  it('maps search items (no subscriber count → no watchers snapshot)', () => {
    const item = searchResponse.items[1];
    if (item === undefined) throw new Error('fixture item missing');
    const normalized = normalizeGitHubItem(fetched(item, 'octo-labs/quick-cli'));
    expect(normalized?.item).toMatchObject({
      externalId: 'octo-labs/quick-cli',
      name: 'quick-cli',
      homepage: null,
      language: 'Rust',
      license: null,
      topics: ['cli', 'devtools', 'rust'],
    });
    expect(normalized?.snapshots).toEqual([
      { metric: 'stars', value: 128 },
      { metric: 'forks', value: 9 },
      { metric: 'open_issues', value: 3 },
    ]);
  });

  it('keeps archived and forked repos, flagging the fork', () => {
    const normalized = normalizeGitHubItem(fetched(graphqlField('r2'), 'legacy-labs/old-forge'));
    expect(normalized?.item).toMatchObject({
      externalId: 'legacy-labs/old-forge',
      upstreamId: 'R_kgDOAb1cde',
      isArchived: true,
      flags: ['fork'],
      license: null,
      homepage: null,
      description: null,
      language: 'Python',
      topics: ['archived-experiment'],
    });
  });

  it('canonicalizes the new slug on rename while keeping the upstream node id', () => {
    const envelope = GitHubGraphqlEnvelopeSchema.parse(fixture('graphql-renamed.json'));
    const value = envelope.data?.r0;
    if (value === undefined || value === null) throw new Error('renamed fixture missing');
    const normalized = normalizeGitHubItem(fetched(value as GitHubRepoRaw, 'acme/vector-forge'));
    expect(normalized?.item.externalId).toBe('acme-labs/vector-forge');
    expect(normalized?.item.displayName).toBe('acme-labs/vector-forge');
    expect(normalized?.item.owner).toBe('acme-labs');
    // §5.4: the node id survives the rename — persistence detects it via upstreamId.
    expect(normalized?.item.upstreamId).toBe('R_kgDOMYk3Xw');
  });

  it('returns null for notModified, notFound and unusable payloads', () => {
    expect(normalizeGitHubItem({ ...fetched(null), notModified: true })).toBeNull();
    expect(normalizeGitHubItem({ ...fetched(null), notFound: true })).toBeNull();
    expect(normalizeGitHubItem(fetched(null))).toBeNull();
    const broken = { ...restRepo, full_name: 'not-a-slug' };
    expect(normalizeGitHubItem(fetched(broken as GitHubRepoRaw))).toBeNull();
  });
});
