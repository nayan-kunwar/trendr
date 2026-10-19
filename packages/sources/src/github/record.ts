import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Spec §16 — `pnpm fixtures:record --source github` runs against the live API
 * with `RECORD=1`, writes JSON responses into `__fixtures__/` and strips every
 * token before writing. It also records the GAP-1/7/8 evidence used by the
 * ADRs (GraphQL point cost, stargazer pagination depth, PAT expiry header).
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

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
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

async function main(): Promise<void> {
  const source = argValue('--source');
  if (source !== 'github') {
    console.error('usage: RECORD=1 pnpm fixtures:record --source github');
    process.exitCode = 1;
    return;
  }
  if (process.env.RECORD !== '1') {
    console.error('fixtures:record calls the live GitHub API; set RECORD=1 to confirm.');
    console.error('usage: RECORD=1 pnpm fixtures:record --source github');
    process.exitCode = 1;
    return;
  }
  await loadDotenv();
  const tokens = (process.env.GITHUB_TOKENS ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const token = tokens[0];
  if (token === undefined) {
    console.error('GITHUB_TOKENS is not set (shell env or .env).');
    process.exitCode = 1;
    return;
  }
  const userAgent =
    process.env.HTTP_USER_AGENT ?? 'Trendr/1.0 (+https://github.com/nayankunwar/trendr)';
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

  // ── GraphQL batch (fixture + GAP-1 cost at 3 and 50 aliases) ────────────
  const batch3 = await graphql(
    ['vercel/next.js', 'sindresorhus/got', 'int-ingest/does-not-exist'],
    headers,
  );
  await writeFixture('graphql-batch.json', batch3.body, tokens);
  const batch50 = await graphql(GAP1_REPOS.slice(0, 50), headers);

  // ── stargazers: page 1 + last page + GAP-7 depth probe ──────────────────
  const starHeaders = { ...headers, accept: STAR_ACCEPT };
  const page1 = await request(
    '/repos/sindresorhus/got/stargazers?per_page=100&page=1',
    {},
    starHeaders,
  );
  if (page1.status !== 200) throw new Error(`stargazers page 1 failed with ${page1.status}`);
  await writeFixture('stargazers-page-1.json', page1.body, tokens);
  const link = page1.headers.get('link');
  const lastPage = link === null ? 1 : Number(/[?&]page=(\d+)>;\s*rel="last"/.exec(link)?.[1] ?? 1);
  const last = await request(
    `/repos/sindresorhus/got/stargazers?per_page=100&page=${lastPage}`,
    {},
    starHeaders,
  );
  if (last.status !== 200) throw new Error(`stargazers last page failed with ${last.status}`);
  await writeFixture('stargazers-last.json', last.body, tokens);

  const depthProbe: { repo: string; page: number; status: number; message: string | null }[] = [];
  for (const page of [398, 400, 401]) {
    const probe = await request(
      `/repos/torvalds/linux/stargazers?per_page=100&page=${page}`,
      {},
      starHeaders,
    );
    let message: string | null = null;
    try {
      message = (JSON.parse(probe.body) as { message?: string }).message ?? null;
    } catch {
      message = null;
    }
    depthProbe.push({ repo: 'torvalds/linux', page, status: probe.status, message });
  }

  const meta = {
    recordedAt: now.toISOString(),
    userAgent,
    graphql: [
      { aliases: 3, ...(batch3.rateLimit ?? {}) },
      { aliases: 50, ...(batch50.rateLimit ?? {}) },
    ],
    tokenExpiryHeader: restRepo.headers.get('github-authentication-token-expiration'),
    restEtag: restRepo.headers.get('etag'),
    searchRateLimitRemaining: newHot.headers.get('x-ratelimit-remaining'),
    stargazers: { repo: 'sindresorhus/got', lastPage, link },
    stargazerDepthProbe: depthProbe,
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
  for (const probe of depthProbe) {
    console.log(
      `stargazers ${probe.repo} page ${probe.page}: ${probe.status} ${probe.message ?? ''}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
