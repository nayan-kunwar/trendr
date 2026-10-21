import { describe, expect, it } from 'vitest';

import { buildBatchQuery } from '../../src/github/graphql.js';
import {
  GitHubGraphqlEnvelopeSchema,
  GitHubGraphqlRateLimitSchema,
  GitHubGraphqlRepoSchema,
  GitHubRestRepoSchema,
  GitHubSearchResponseSchema,
  GitHubStargazerCountSchema,
  GitHubStargazerHistorySchema,
} from '../../src/github/schemas.js';
import { CONTRACT_ENABLED, contractFetch, contractJson, requireGithubToken } from './helpers.js';

const API = 'https://api.github.com';
const REPO = 'vercel/next.js';

const describeContract = describe.skipIf(!CONTRACT_ENABLED);

describeContract('GitHub upstream contract (spec §7.3.1)', () => {
  it('validates the REST search and repository payloads', async () => {
    const token = requireGithubToken();
    const searchParams = new URLSearchParams({
      q: 'stars:>10000',
      sort: 'stars',
      order: 'desc',
      per_page: '1',
      page: '1',
    });
    const search = await contractFetch(`${API}/search/repositories?${searchParams.toString()}`, {
      token,
      headers: { accept: 'application/vnd.github+json' },
    });
    const searchBody = GitHubSearchResponseSchema.parse(contractJson(search.text));
    expect(searchBody.items.length).toBeGreaterThan(0);

    const repo = await contractFetch(`${API}/repos/${REPO}`, {
      token,
      headers: { accept: 'application/vnd.github+json' },
    });
    const repoBody = GitHubRestRepoSchema.parse(contractJson(repo.text));
    expect(repoBody.full_name).toBe(REPO);
  });

  it('validates one GraphQL repository batch and its rate-limit block', async () => {
    const token = requireGithubToken();
    const request = buildBatchQuery([{ source: 'github', kind: 'repo', externalId: REPO }]);
    const response = await contractFetch(`${API}/graphql`, {
      method: 'POST',
      token,
      headers: { accept: 'application/vnd.github+json' },
      body: request,
    });
    const envelope = GitHubGraphqlEnvelopeSchema.parse(contractJson(response.text));
    expect(envelope.errors ?? []).toEqual([]);
    const data = envelope.data;
    expect(data).not.toBeNull();
    const repo = GitHubGraphqlRepoSchema.parse(data?.r0);
    expect(repo.nameWithOwner).toBe(REPO);
    const rateLimit = GitHubGraphqlRateLimitSchema.parse(data?.rateLimit);
    expect(rateLimit.cost).toBeGreaterThan(0);
  });

  it('validates the stargazer count and history payloads', async () => {
    const token = requireGithubToken();
    const count = await contractFetch(`${API}/repos/${REPO}/stargazers/count`, { token });
    const countBody = GitHubStargazerCountSchema.parse(contractJson(count.text));
    expect(countBody.count).toBeGreaterThan(0);

    const history = await contractFetch(
      `${API}/repos/${REPO}/stargazers/history?per_page=1&page=1`,
      { token },
    );
    const historyBody = GitHubStargazerHistorySchema.parse(contractJson(history.text));
    expect(historyBody.length).toBeGreaterThan(0);
  });
});
