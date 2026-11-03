import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DiscoveredRef } from '../adapter.js';
import { buildBatchQuery } from './graphql.js';

/**
 * Spec §16 — `pnpm fixtures:record --source github` runs against the live API
 * with `RECORD=1`, writes JSON responses into `__fixtures__/` and strips every
 * token before writing. It also records the ADR evidence: the GAP-1 GraphQL
 * point cost, the GAP-7 capture that the stargazers listing is retired for
 * non-collaborators (ADR 0012) and the GAP-8 PAT expiry header.
 */

const API = 'https://api.github.com';
const STAR_ACCEPT = 'application/vnd.github.star+json';
const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const DAY_MS = 86_400_000;

/** Repos for the 50-alias GAP-1 measurement (public, long-lived). */
const GAP1_REPOS = [
  'vercel/next.js',
  'facebook/react',
  'vuejs/core',
  'angular/angular',
  'sveltejs/svelte',
  'microsoft/vscode',
  'microsoft/TypeScript',
  'nodejs/node',
  'denoland/deno',
  'oven-sh/bun',
  'torvalds/linux',
  'python/cpython',
  'rust-lang/rust',
  'golang/go',
  'kubernetes/kubernetes',
  'docker/compose',
  'redis/redis',
  'postgres/postgres',
  'mongodb/mongo',
  'elastic/elasticsearch',
  'grafana/grafana',
  'prometheus/prometheus',
  'hashicorp/terraform',
  'tailwindlabs/tailwindcss',
  'vitejs/vite',
  'webpack/webpack',
  'rollup/rollup',
  'evanw/esbuild',
  'jestjs/jest',
  'vitest-dev/vitest',
  'microsoft/playwright',
  'puppeteer/puppeteer',
  'axios/axios',
  'expressjs/express',
  'fastify/fastify',
  'nestjs/nest',
  'remix-run/react-router',
  'TanStack/query',
  'prisma/prisma',
  'drizzle-team/drizzle-orm',
  'typeorm/typeorm',
  'sequelize/sequelize',
  'Automattic/mongoose',
  'openai/openai-node',
  'langchain-ai/langchain',
  'huggingface/transformers',
  'pytorch/pytorch',
  'tensorflow/tensorflow',
  'scikit-learn/scikit-learn',
  'pandas-dev/pandas',
];

const TOKEN_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9_]{10,}/g,
  /github_pat_[A-Za-z0-9_]{10,}/g,
  /hf_[A-Za-z0-9]{10,}/g,
];

interface ProbeResult {
  status: number;
  body: string;
  headers: Headers;
}

/** The dev tool reads `.env` itself: `@trendr/config` validates the full schema. */
async function loadDotenv(): Promise<void> {
  let dir = process.cwd();
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      const text = await readFile(candidate, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
        const key = match?.[1];
        const value = match?.[2];
        if (key !== undefined && value !== undefined && process.env[key] === undefined) {
          process.env[key] = value.trim().replace(/^["']|["']$/g, '');
        }
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function sanitize(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join('<redacted>');
  }
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, '<redacted>');
  return out;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** GitHub error bodies are JSON, but a proxy or gateway may return text. */
function failureMessage(body: string): string | null {
  try {
    return (JSON.parse(body) as { message?: string }).message ?? null;
  } catch {
    return null;
  }
}

async function request(
  path: string,
  init: RequestInit,
  headers: Record<string, string>,
): Promise<ProbeResult> {
  const response = await fetch(`${API}${path}`, { ...init, headers });
  return { status: response.status, body: await response.text(), headers: response.headers };
}

function gqlQuery(repos: readonly string[]): string {
  const declarations: string[] = [];
  const fields: string[] = [];
  for (let index = 0; index < repos.length; index += 1) {
    declarations.push(`$o${index}: String!`, `$n${index}: String!`);
    fields.push(`r${index}: repository(owner:$o${index}, name:$n${index}) { id nameWithOwner }`);
  }
  return `query TrendrProbe(${declarations.join(', ')}) { ${fields.join(' ')} rateLimit { cost remaining resetAt } }`;
}

async function graphql(
  repos: readonly string[],
  headers: Record<string, string>,
): Promise<{ body: string; rateLimit: { cost: number; remaining: number } | null }> {
  const variables: Record<string, string> = {};
  repos.forEach((repo, index) => {
    const [owner, name] = repo.split('/');
    variables[`o${index}`] = owner ?? '';
    variables[`n${index}`] = name ?? '';
  });
  const result = await request(
    '/graphql',
    { method: 'POST', body: JSON.stringify({ query: gqlQuery(repos), variables }) },
    headers,
  );
  if (result.status !== 200) throw new Error(`graphql probe failed with ${result.status}`);
  const parsed = JSON.parse(result.body) as {
    data?: { rateLimit?: { cost: number; remaining: number } };
  };
  return { body: result.body, rateLimit: parsed.data?.rateLimit ?? null };
}

async function writeFixture(name: string, body: string, secrets: readonly string[]): Promise<void> {
  const parsed: unknown = JSON.parse(body);
  await writeFile(
    join(FIXTURES_DIR, name),
    `${sanitize(JSON.stringify(parsed, null, 2), secrets)}\n`,
    'utf8',
  );
}

export async function recordGitHubFixtures(): Promise<void> {
  if (process.env.RECORD !== '1') {
    throw new Error('fixtures:record calls the live GitHub API; set RECORD=1 to confirm.');
  }
  await loadDotenv();
  const tokens = (process.env.GITHUB_TOKENS ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const token = tokens[0];
  if (token === undefined) {
    throw new Error('GITHUB_TOKENS is not set (shell env or .env).');
  }
  const userAgent =
    process.env.HTTP_USER_AGENT ?? 'Trendr/1.0 (+https://github.com/nayan-kunwar/trendr)';
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'user-agent': userAgent,
    accept: 'application/vnd.github+json',
  };
  await mkdir(FIXTURES_DIR, { recursive: true });
  const now = new Date();

  // ── search (new-hot + one topic query) ──────────────────────────────────
  const newHotQ = `created:${isoDay(new Date(now.getTime() - 7 * DAY_MS))}..${isoDay(now)} stars:>=20`;
  const newHot = await request(
    `/search/repositories?q=${encodeURIComponent(newHotQ)}&sort=stars&order=desc&per_page=20&page=1`,
    {},
    headers,
  );
  if (newHot.status !== 200) throw new Error(`search new-hot failed with ${newHot.status}`);
  await writeFixture('search-new-hot.json', newHot.body, tokens);

  const topicQ = `topic:mcp-server pushed:>${isoDay(new Date(now.getTime() - 14 * DAY_MS))} stars:>=10`;
  const topic = await request(
    `/search/repositories?q=${encodeURIComponent(topicQ)}&sort=stars&order=desc&per_page=20&page=1`,
    {},
    headers,
  );
  if (topic.status !== 200) throw new Error(`search topic failed with ${topic.status}`);
  await writeFixture('search-topic.json', topic.body, tokens);

  // ── REST repo (ETag + GAP-8 expiry header) ──────────────────────────────
  const restRepo = await request('/repos/vercel/next.js', {}, headers);
  if (restRepo.status !== 200) throw new Error(`rest repo failed with ${restRepo.status}`);
  await writeFixture('rest-repo.json', restRepo.body, tokens);

  // ── GraphQL: production snapshot fixture + GAP-1 cost at 3 and 50 ───────
  // The fixture must be the *adapter's* batch shape (tests feed it straight
  // into `normalize`), so replay `buildBatchQuery` over a live repo, a small
  // repo and a NOT_FOUND alias instead of the minimal cost probe.
  const snapshotRefs: DiscoveredRef[] = [
    { source: 'github', kind: 'repo', externalId: 'vercel/next.js' },
    { source: 'github', kind: 'repo', externalId: 'sindresorhus/got' },
    { source: 'github', kind: 'repo', externalId: 'int-ingest/does-not-exist' },
  ];
  const snapshotRequest = buildBatchQuery(snapshotRefs);
  const snapshot = await request(
    '/graphql',
    {
      method: 'POST',
      body: JSON.stringify({ query: snapshotRequest.query, variables: snapshotRequest.variables }),
    },
    headers,
  );
  if (snapshot.status !== 200) throw new Error(`graphql snapshot failed with ${snapshot.status}`);
  await writeFixture('graphql-batch.json', snapshot.body, tokens);
  const snapshotRateLimit =
    (JSON.parse(snapshot.body) as { data?: { rateLimit?: { cost: number; remaining: number } } })
      .data?.rateLimit ?? null;

  const batch3 = await graphql(
    snapshotRefs.map((ref) => ref.externalId),
    headers,
  );
  const batch50 = await graphql(GAP1_REPOS.slice(0, 50), headers);

  // ── stargazers: history + count; the user listing is retired (ADR 0012) ──
  const history = await request(
    '/repos/sindresorhus/got/stargazers/history?per_page=30&page=1',
    {},
    headers,
  );
  if (history.status !== 200) throw new Error(`stargazers history failed with ${history.status}`);
  await writeFixture('stargazers-history.json', history.body, tokens);
  const historyWeeks = JSON.parse(history.body) as { week: number }[];

  const starsCount = await request('/repos/sindresorhus/got/stargazers/count', {}, headers);
  if (starsCount.status !== 200) {
    throw new Error(`stargazers count failed with ${starsCount.status}`);
  }
  await writeFixture('stargazers-count.json', starsCount.body, tokens);

  // GAP-7 evidence: the listing is now limited to admins and collaborators
  // (June 2026 changelog), so capture the refusal the backfill was designed
  // around — it is why the endpoint swap exists at all.
  const listing = await request(
    '/repos/sindresorhus/got/stargazers?per_page=1&page=1',
    {},
    { ...headers, accept: STAR_ACCEPT },
  );
  await writeFixture('stargazers-listing.json', listing.body, tokens);
  const listingMessage = failureMessage(listing.body);

  const meta = {
    recordedAt: now.toISOString(),
    userAgent,
    graphql: [
      { aliases: 3, probe: true, ...(batch3.rateLimit ?? {}) },
      { aliases: 50, probe: true, ...(batch50.rateLimit ?? {}) },
      { aliases: 3, probe: false, ...(snapshotRateLimit ?? {}) },
    ],
    tokenExpiryHeader: restRepo.headers.get('github-authentication-token-expiration'),
    restEtag: restRepo.headers.get('etag'),
    searchRateLimitRemaining: newHot.headers.get('x-ratelimit-remaining'),
    stargazerHistory: {
      repo: 'sindresorhus/got',
      weeksPerPage: historyWeeks.length,
      newestWeek: historyWeeks[0]?.week ?? null,
      oldestWeek: historyWeeks.at(-1)?.week ?? null,
    },
    stargazerListing: {
      repo: 'sindresorhus/got',
      status: listing.status,
      message: listingMessage,
    },
  };
  await writeFile(
    join(FIXTURES_DIR, 'meta.json'),
    `${sanitize(JSON.stringify(meta, null, 2), tokens)}\n`,
    'utf8',
  );

  console.log(`fixtures written to ${FIXTURES_DIR}`);
  console.log(
    `graphql cost: 3 aliases → ${batch3.rateLimit?.cost}, 50 aliases → ${batch50.rateLimit?.cost}`,
  );
  console.log(`pat expiry header: ${meta.tokenExpiryHeader ?? '(absent)'}`);
  console.log(`stargazers listing (retired): ${listing.status} ${listingMessage ?? ''}`);
  console.log(
    `stargazers history: ${historyWeeks.length} weeks recorded (newest ${meta.stargazerHistory.newestWeek})`,
  );
}
