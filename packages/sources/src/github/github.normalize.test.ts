import { readFileSync } from 'node:fs';

import { normalizeGitHubRepo, normalizeTopicSlugs } from '@trendr/core';
import { describe, expect, it } from 'vitest';

import type { FetchedItem } from '../adapter.js';
import { normalizeGitHubItem } from './github.adapter.js';
import {
  GitHubGraphqlEnvelopeSchema,
  GitHubRestRepoSchema,
  GitHubSearchResponseSchema,
  type GitHubGraphqlRepo,
  type GitHubRepoRaw,
} from './schemas.js';

/**
 * Spec §18 task 4.3 — fixture tests for `normalize`: repo, archived, fork,
 * renamed, not found. Payloads are validated through the same Zod schemas the
 * adapter uses at runtime, and the expectations compare against each fixture's
 * own raw values — re-recording live captures (spec §16) refreshes the data
 * without invalidating the mapping assertions.
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

/** Mirrors the adapter's empty-string → null cleanup for homepage fields. */
function emptyToNull(value: string | null): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

const graphqlEnvelope = GitHubGraphqlEnvelopeSchema.parse(fixture('graphql-batch.json'));

function graphqlField(name: string): GitHubGraphqlRepo {
  const value = graphqlEnvelope.data?.[name];
  if (value === undefined || value === null) throw new Error(`fixture ${name} missing`);
  return value as GitHubGraphqlRepo;
}

const searchResponse = GitHubSearchResponseSchema.parse(fixture('search-new-hot.json'));
const restRepo = GitHubRestRepoSchema.parse(fixture('rest-repo.json'));

describe('github normalize (spec §5.1, §7.3.1)', () => {
  it('maps a GraphQL repo to the canonical item and metrics', () => {
    const raw = graphqlField('r0');
    const normalized = normalizeGitHubItem(fetched(raw));
    const slash = raw.nameWithOwner.indexOf('/');
    const owner = raw.nameWithOwner.slice(0, slash);
    const name = raw.nameWithOwner.slice(slash + 1);
    const spdx = raw.licenseInfo?.spdxId ?? null;

    expect(normalized).not.toBeNull();
    expect(normalized?.item).toMatchObject({
      source: 'github',
      kind: 'repo',
      externalId: raw.nameWithOwner,
      upstreamId: raw.id,
      name,
      displayName: raw.nameWithOwner,
      description: raw.description,
      url: raw.url,
      homepage: emptyToNull(raw.homepageUrl),
      language: raw.primaryLanguage?.name ?? null,
      license: spdx === 'NOASSERTION' ? null : spdx,
      owner,
      topics: normalizeTopicSlugs(raw.repositoryTopics.nodes.map((node) => node.topic.name)),
      primaryMetric: 'stars',
      isArchived: raw.isArchived,
      flags: raw.isFork ? ['fork'] : [],
    });
    expect(normalized?.item.upstreamCreatedAt?.toISOString()).toBe(
      new Date(raw.createdAt).toISOString(),
    );
    expect(normalized?.snapshots).toEqual([
      { metric: 'stars', value: raw.stargazerCount },
      { metric: 'forks', value: raw.forkCount },
      { metric: 'open_issues', value: raw.issues.totalCount },
      { metric: 'watchers', value: raw.watchers.totalCount },
    ]);
    expect(normalized?.item.metadata).toEqual({ pushedAt: raw.pushedAt ?? null });
    expect(normalized?.daily).toEqual([]);
    expect(normalized?.aliases).toEqual([]);
  });

  it('maps a REST repo (subscribers → watchers, empty homepage → null)', () => {
    const normalized = normalizeGitHubItem(fetched(restRepo));
    const subscribers = restRepo.subscribers_count;
    if (subscribers === undefined) throw new Error('rest fixture lost subscribers_count');

    expect(normalized?.item.externalId).toBe(restRepo.full_name);
    expect(normalized?.item.upstreamId).toBe(restRepo.node_id);
    expect(normalized?.item.homepage).toBe(emptyToNull(restRepo.homepage));
    expect(normalized?.snapshots).toEqual([
      { metric: 'stars', value: restRepo.stargazers_count },
      { metric: 'forks', value: restRepo.forks_count },
      { metric: 'open_issues', value: restRepo.open_issues_count },
      { metric: 'watchers', value: subscribers },
    ]);
  });

  it('maps search items (no subscriber count → no watchers snapshot)', () => {
    const item = searchResponse.items[0];
    if (item === undefined) throw new Error('fixture item missing');
    // Live slugs can carry mixed case (`Gathin23/…`): canonicalize like the adapter.
    const canonical = normalizeGitHubRepo(item.full_name);
    const name = canonical.slice(canonical.indexOf('/') + 1);
    const normalized = normalizeGitHubItem(fetched(item, canonical));

    expect(normalized?.item).toMatchObject({
      externalId: canonical,
      name,
      homepage: emptyToNull(item.homepage),
    });
    expect(normalized?.snapshots).toEqual([
      { metric: 'stars', value: item.stargazers_count },
      { metric: 'forks', value: item.forks_count },
      { metric: 'open_issues', value: item.open_issues_count },
    ]);
  });

  it('keeps archived and forked repos, flagging the fork', () => {
    // Archived forks are rare on GitHub, so flip the flags on the live shape:
    // the branch under test is the mapping, not today's fixture selection.
    const raw: GitHubGraphqlRepo = { ...graphqlField('r0'), isArchived: true, isFork: true };
    const normalized = normalizeGitHubItem(fetched(raw, raw.nameWithOwner));

    expect(normalized?.item).toMatchObject({
      externalId: raw.nameWithOwner,
      isArchived: true,
      flags: ['fork'],
      primaryMetric: 'stars',
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
