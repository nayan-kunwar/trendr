import { createHash, createHmac } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { inArray, sql } from 'drizzle-orm';

import {
  METRIC_KIND,
  mcpGitHubFallback,
  mcpNpmFallback,
  normalizeArxivId,
  normalizeGitHubRepo,
  normalizeHuggingFaceId,
  normalizeMcpName,
  normalizeNpmPackage,
  normalizePyPiName,
} from '@trendr/core';
import type { HuggingFaceRepoKind, ItemFlag, ItemKind, Metric, Source, Tier } from '@trendr/core';

import { createDb, type Db } from './client.js';
import { type ItemUpsert, upsertItems } from './repositories/items.repo.js';
import {
  type DailyMetricUpsert,
  type ItemMetricPair,
  type SnapshotUpsert,
  refreshItemAggregates,
  upsertDailyMetrics,
  upsertSnapshots,
} from './repositories/snapshots.repo.js';
import { itemTopics, topics } from './schema/items.js';
import { apiKeys, users } from './schema/users.js';

/**
 * Dev seed (spec §7.3 bootstrap, §18 task 1.6): ≈ 200 fixture items across all
 * six sources with 60 days of synthetic-but-realistic series so the UI and the
 * scoring pipeline work offline. Every write goes through the Phase-1
 * repositories and their natural keys, which is what makes `pnpm db:seed`
 * idempotent; the series comes from a seeded PRNG (and its timestamps from the
 * run's UTC day), so re-runs inside one UTC day are byte-identical. One admin
 * user and one deterministic API key are created; the raw key is printed to
 * stdout because only its HMAC is stored (spec §15).
 */

/** Series length in days (spec §7.3 backfill windows; UI sparklines). */
const DAYS = 60;
const DAY_MS = 86_400_000;
/** Fixed PRNG seed — the whole fixture series is reproducible. */
const PRNG_SEED = 0x7f3d2a19;
/** Deterministic dev key material: `dt_live_` + 8-char prefix + 32 base62 chars. */
const SEED_KEY_PREFIX = 'seedkey1';
const SEED_KEY_MATERIAL = 'trendr:seed:api-key:v1';
const SEED_KEY_NAME = 'seed-dev-key';

export interface SeedOptions {
  /** HMAC pepper for the seeded API key (`API_KEY_PEPPER`, spec §15). */
  pepper: string;
  /** Admin account created (or kept) by the seed. */
  adminEmail: string;
  /** Anchor "now" for the generated series; defaults to the current time. */
  now?: Date;
}

export interface SeedReport {
  items: number;
  snapshots: number;
  dailyMetrics: number;
  topics: number;
  itemTopics: number;
  users: number;
  apiKeys: number;
  sources: Record<Source, number>;
  adminEmail: string;
  apiKeyPrefix: string;
  /** Raw API key — printed by the CLI; only its HMAC is stored. */
  apiKey: string;
}

interface FixtureItem {
  source: Source;
  kind: ItemKind;
  externalId: string;
  upstreamId: string | null;
  name: string;
  displayName: string;
  description: string | null;
  url: string;
  homepage: string | null;
  language: string | null;
  license: string | null;
  owner: string | null;
  primaryMetric: Metric;
  upstreamCreatedAt: Date;
  isArchived: boolean;
  flags: ItemFlag[];
  topics: string[];
}

// ---------------------------------------------------------------------------
// Fixture pools (hand-curated, deterministic)
// ---------------------------------------------------------------------------

const DESCRIPTIONS = [
  'Fast, unopinionated tooling for modern development workflows',
  'AI agent framework with tool calling and long-term memory',
  'Developer platform for building and shipping applications',
  'Data processing toolkit focused on performance and ergonomics',
  'Accessible UI component library with typed APIs',
  'Self-hosted infrastructure for teams that need control',
  'Machine learning library used in research and production',
  'Command-line utility for everyday developer workflows',
  'Observability toolkit for metrics, logs and traces',
  'Official SDK with batteries-included defaults',
  'Runtime and package manager built for speed',
  'Storage engine designed for high-throughput workloads',
] as const;

const TOPIC_POOL = [
  'ai',
  'llm',
  'agents',
  'mcp',
  'rag',
  'embeddings',
  'machine-learning',
  'deep-learning',
  'computer-vision',
  'nlp',
  'developer-tools',
  'cli',
  'web',
  'frameworks',
  'database',
  'rust',
  'typescript',
  'python',
  'javascript',
  'infrastructure',
  'observability',
  'serverless',
  'testing',
  'data-science',
  'audio',
  'video',
] as const;

const GH_LANGUAGES = ['TypeScript', 'Python', 'Rust', 'Go', 'C++', 'JavaScript', 'Java'] as const;
const LICENSES = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'GPL-3.0', 'ISC', 'MPL-2.0'] as const;

const GITHUB_REPOS = [
  'vercel/next.js',
  'facebook/react',
  'microsoft/vscode',
  'rust-lang/rust',
  'golang/go',
  'nodejs/node',
  'python/cpython',
  'tensorflow/tensorflow',
  'pytorch/pytorch',
  'huggingface/transformers',
  'langchain-ai/langchain',
  'ollama/ollama',
  'open-webui/open-webui',
  'denoland/deno',
  'oven-sh/bun',
  'vitejs/vite',
  'tailwindlabs/tailwindcss',
  'shadcn-ui/ui',
  'fastify/fastify',
  'honojs/hono',
  'trpc/trpc',
  'drizzle-team/drizzle-orm',
  'prisma/prisma',
  'supabase/supabase',
  'moby/moby',
  'kubernetes/kubernetes',
  'prometheus/prometheus',
  'grafana/grafana',
  'redis/redis',
  'valkey-io/valkey',
  'apache/kafka',
  'elastic/elasticsearch',
  'hashicorp/terraform',
  'ansible/ansible',
  'sveltejs/svelte',
  'nuxt/nuxt',
  'remix-run/remix',
  'withastro/astro',
  'solidjs/solid',
  'storybookjs/storybook',
] as const;

const NPM_PACKAGES = [
  'react',
  'next',
  'vue',
  'svelte',
  'typescript',
  'zod',
  'express',
  'fastify',
  'hono',
  'axios',
  'lodash',
  'underscore',
  'chalk',
  'commander',
  'vite',
  'webpack',
  'esbuild',
  'rollup',
  'tailwindcss',
  'postcss',
  'eslint',
  'prettier',
  'vitest',
  'jest',
  'playwright',
  'puppeteer',
  'prisma',
  'drizzle-orm',
  '@modelcontextprotocol/sdk',
  '@anthropic-ai/sdk',
  'openai',
  'socket.io',
  'redis',
  'ioredis',
  'bullmq',
  'ws',
  'undici',
  'dotenv',
  'husky',
  'turbo',
] as const;

/** Raw PyPI spellings on purpose — the seed runs them through PEP 503 normalization. */
const PYPI_PACKAGES = [
  'numpy',
  'pandas',
  'scipy',
  'torch',
  'tensorflow',
  'transformers',
  'sentence_transformers',
  'FastAPI',
  'Django',
  'Flask',
  'uvicorn',
  'pydantic',
  'ruff',
  'mypy',
  'pytest',
  'httpx',
  'Requests',
  'aiohttp',
  'boto3',
  'SQLAlchemy',
  'langchain',
  'llama_index',
  'openai',
  'anthropic',
  'gradio',
  'streamlit',
  'scikit_learn',
  'matplotlib',
  'plotly',
  'polars',
  'xgboost',
  'opencv-python',
  'jupyterlab',
  'datasets',
] as const;

const HF_MODELS = [
  'google/embeddinggemma-2',
  'meta-llama/Llama-3.1-8B-Instruct',
  'mistralai/Mistral-7B-Instruct-v0.3',
  'Qwen/Qwen2.5-7B',
  'deepseek-ai/DeepSeek-R1',
  'microsoft/phi-3-mini',
  'stabilityai/stable-diffusion-xl-base-1.0',
  'black-forest-labs/FLUX.1-dev',
  'openai/whisper-large-v3',
  'facebook/bart-large-mnli',
  'sentence-transformers/all-MiniLM-L6-v2',
  'BAAI/bge-m3',
  'nomic-ai/nomic-embed-text-v1.5',
  'distilbert/distilbert-base-uncased',
  'google-bert/bert-base-uncased',
  'microsoft/deberta-v3-base',
  'google-t5/t5-small',
  'Salesforce/blip-image-captioning-large',
  'hexgrad/Kokoro-82M',
  'pyannote/speaker-diarization-3.1',
  'openai/clip-vit-base-patch32',
  'tencent/HunyuanVideo',
  'Wan-AI/Wan2.1-T2V-14B',
  'deepseek-ai/DeepSeek-V3',
] as const;

const HF_DATASETS = [
  'squad',
  'glue',
  'openai/gsm8k',
  'allenai/c4',
  'Salesforce/wikitext',
  'stanfordnlp/imdb',
] as const;

const HF_SPACES = [
  'akhaliq/CLIP-Interrogator',
  'hysts/ControlNet-v1-1',
  'gradio/hello-world',
  'nateraw/food',
  'mrfakename/E2-F5-TTS',
  'openfree/flux-online',
] as const;

const ARXIV_MONTHS = ['2604', '2605', '2606', '2607', '2608', '2609', '2610'] as const;
const ARXIV_TITLES = [
  'Scaling Laws for Tool-Using Language Agents',
  'Retrieval-Augmented Generation Revisited: A Systematic Study',
  'Sparse Attention for Long-Context Inference',
  'A Benchmark for Multi-Agent Software Engineering',
  'Distillation of Mixture-of-Experts Models at Scale',
  'Grounded Reasoning with Programmatic Tool Calls',
  'Efficient Fine-Tuning of Vision-Language Models on a Budget',
  'Evaluating Faithfulness of Chain-of-Thought Explanations',
  'Speculative Decoding with Adaptive Draft Lengths',
  'Small Language Models for On-Device Code Completion',
  'Diffusion Models for Structured Data Generation',
  'Long-Term Memory for Conversational Assistants',
  'Quantization-Aware Training for 4-Bit Mixture-of-Experts',
  'Contrastive Embeddings for Code Search at Scale',
  'Robustness of Multimodal Models under Distribution Shift',
  'Agentic Web Navigation with Reinforcement Learning',
  'Data Curation Recipes for Small Pretraining Corpora',
  'Interpretable Routing in Sparse Expert Models',
  'GPU-Efficient Serving of Long-Sequence Transformers',
  'Formal Verification of LLM-Generated Code Patches',
  'Continual Learning without Catastrophic Forgetting',
  'Synthetic Data for Low-Resource Function Calling',
  'A Taxonomy of Prompt-Injection Attacks and Defenses',
  'Time-Series Forecasting with Foundation Models',
  'Semantic Caching for Enterprise Search',
  'Graph Neural Networks Meet Tabular Foundation Models',
] as const;

const MCP_REGISTRY = [
  'io.github.modelcontextprotocol/filesystem',
  'io.github.modelcontextprotocol/fetch',
  'io.github.modelcontextprotocol/git',
  'io.github.modelcontextprotocol/memory',
  'io.github.modelcontextprotocol/time',
  'io.github.modelcontextprotocol/sequentialthinking',
  'io.github.github/github-mcp-server',
  'io.github.cloudflare/mcp-server-cloudflare',
  'io.github.sentry/mcp',
  'io.github.stripe/mcp',
  'io.github.supabase-community/supabase-mcp',
  'io.github.vercel/mcp-adapter',
  'io.github.neondatabase/mcp-server-neon',
  'io.github.linear/linear-mcp',
  'io.github.notion/notion-mcp',
  'io.github.slack/slack-mcp',
  'io.github.figma/figma-context-mcp',
  'io.github.browserbase/mcp-server-browserbase',
  'io.github.exa-labs/exa-mcp-server',
  'io.github.firecrawl/firecrawl-mcp-server',
  'io.github.e2b-dev/mcp-server',
  'io.github.composiohq/composio-mcp',
] as const;
const MCP_FALLBACK_REPOS = ['acme/weather-mcp'] as const;
const MCP_FALLBACK_PACKAGES = ['@acme/mcp-tools'] as const;

/** Explicit quirks so the fixture set exercises every flag and the archived tier. */
const OVERRIDES: Record<string, Partial<Pick<FixtureItem, 'flags' | 'isArchived'>>> = {
  'github:open-webui/open-webui': { flags: ['fork'] },
  'github:remix-run/remix': { flags: ['fork'], isArchived: true },
  'npm:underscore': { flags: ['deprecated'], isArchived: true },
  'huggingface:models/meta-llama/Llama-3.1-8B-Instruct': { flags: ['gated'] },
  'pypi:requests': { flags: ['burst_suspected'] },
};

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

/** mulberry32 — tiny, fast, fully deterministic PRNG (spec: "seeded PRNG"). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[((index % values.length) + values.length) % values.length];
  if (value === undefined) throw new Error('seed: empty fixture pool');
  return value;
}

function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysAgo(anchor: Date, days: number): Date {
  return new Date(anchor.getTime() - days * DAY_MS);
}

function stableToken(input: string, length: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

function titleize(slug: string): string {
  return slug
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function splitOwnerName(id: string): { owner: string | null; name: string } {
  const slash = id.lastIndexOf('/');
  return slash === -1
    ? { owner: null, name: id }
    : { owner: id.slice(0, slash), name: id.slice(slash + 1) };
}

function pickTopics(seq: number): string[] {
  const count = 2 + (seq % 2);
  return Array.from({ length: count }, (_, k) => at(TOPIC_POOL, seq * 7 + k * 3));
}

// ---------------------------------------------------------------------------
// Fixture construction
// ---------------------------------------------------------------------------

function githubFixture(raw: string, seq: number, anchor: Date): FixtureItem {
  const externalId = normalizeGitHubRepo(raw);
  const { owner, name } = splitOwnerName(externalId);
  return {
    source: 'github',
    kind: 'repo',
    externalId,
    upstreamId: `R_kgDO${stableToken(externalId, 12)}`,
    name,
    displayName: externalId,
    description: at(DESCRIPTIONS, seq),
    url: `https://github.com/${externalId}`,
    homepage: null,
    language: at(GH_LANGUAGES, seq),
    license: at(LICENSES, seq),
    owner,
    primaryMetric: 'stars',
    upstreamCreatedAt: daysAgo(anchor, 90 + ((seq * 137) % 2000)),
    isArchived: false,
    flags: [],
    topics: pickTopics(seq),
  };
}

function npmFixture(raw: string, seq: number, anchor: Date): FixtureItem {
  const externalId = normalizeNpmPackage(raw);
  const { owner, name } = splitOwnerName(externalId);
  return {
    source: 'npm',
    kind: 'package',
    externalId,
    upstreamId: null,
    name,
    displayName: externalId,
    description: at(DESCRIPTIONS, seq),
    url: `https://www.npmjs.com/package/${externalId}`,
    homepage: null,
    language: 'javascript',
    license: at(LICENSES, seq),
    owner,
    primaryMetric: 'downloads',
    upstreamCreatedAt: daysAgo(anchor, 60 + ((seq * 211) % 2500)),
    isArchived: false,
    flags: [],
    topics: pickTopics(seq),
  };
}

function pypiFixture(raw: string, seq: number, anchor: Date): FixtureItem {
  const externalId = normalizePyPiName(raw);
  return {
    source: 'pypi',
    kind: 'package',
    externalId,
    upstreamId: null,
    name: externalId,
    displayName: externalId,
    description: at(DESCRIPTIONS, seq),
    url: `https://pypi.org/project/${externalId}/`,
    homepage: null,
    language: 'python',
    license: at(LICENSES, seq),
    owner: null,
    primaryMetric: 'downloads',
    upstreamCreatedAt: daysAgo(anchor, 90 + ((seq * 173) % 3000)),
    isArchived: false,
    flags: [],
    topics: pickTopics(seq),
  };
}

function huggingfaceFixture(
  kind: HuggingFaceRepoKind,
  repoId: string,
  seq: number,
  anchor: Date,
): FixtureItem {
  const externalId = normalizeHuggingFaceId(kind, repoId);
  const { owner, name } = splitOwnerName(repoId);
  const urlPrefix = kind === 'model' ? '' : `${kind}s/`;
  return {
    source: 'huggingface',
    kind: kind === 'model' ? 'model' : kind,
    externalId,
    upstreamId: stableToken(externalId, 24),
    name,
    displayName: repoId,
    description: at(DESCRIPTIONS, seq),
    url: `https://huggingface.co/${urlPrefix}${repoId}`,
    homepage: null,
    language: null,
    license: at(LICENSES, seq),
    owner,
    // Spec §7.3.4/§8.3: HF `likes` is the primary (cumulative) metric for all
    // kinds; there is deliberately no `huggingface:downloads` scoring params.
    primaryMetric: 'likes',
    upstreamCreatedAt: daysAgo(anchor, 30 + ((seq * 97) % 900)),
    isArchived: false,
    flags: [],
    topics: pickTopics(seq),
  };
}

function arxivFixture(index: number, anchor: Date): FixtureItem {
  const title = at(ARXIV_TITLES, index);
  const externalId = normalizeArxivId(`${at(ARXIV_MONTHS, index)}.${10_000 + index}`);
  return {
    source: 'arxiv',
    kind: 'paper',
    externalId,
    upstreamId: null,
    name: externalId,
    displayName: externalId,
    description: title,
    url: `https://arxiv.org/abs/${externalId}`,
    homepage: null,
    language: null,
    license: null,
    owner: null,
    primaryMetric: 'upvotes',
    upstreamCreatedAt: daysAgo(anchor, 3 + ((index * 11) % 75)),
    isArchived: false,
    flags: [],
    topics: pickTopics(index),
  };
}

function mcpRegistryFixture(raw: string, seq: number, anchor: Date): FixtureItem {
  const externalId = normalizeMcpName(raw);
  const { owner, name } = splitOwnerName(externalId);
  return {
    source: 'mcp',
    kind: 'mcp_server',
    externalId,
    upstreamId: externalId,
    name,
    displayName: externalId,
    description: at(DESCRIPTIONS, seq),
    url: `https://registry.modelcontextprotocol.io/v0/servers/${encodeURIComponent(externalId)}`,
    homepage: null,
    language: null,
    license: null,
    owner,
    primaryMetric: 'stars',
    upstreamCreatedAt: daysAgo(anchor, 20 + ((seq * 53) % 400)),
    isArchived: false,
    flags: [],
    topics: pickTopics(seq),
  };
}

function mcpFallbackFixture(
  raw: string,
  style: 'github' | 'npm',
  seq: number,
  anchor: Date,
): FixtureItem {
  const externalId = style === 'github' ? mcpGitHubFallback(raw) : mcpNpmFallback(raw);
  const repoSlug = style === 'github' ? normalizeGitHubRepo(raw) : normalizeNpmPackage(raw);
  const { owner, name } = splitOwnerName(repoSlug);
  return {
    source: 'mcp',
    kind: 'mcp_server',
    externalId,
    upstreamId: null,
    name,
    displayName: externalId,
    description: at(DESCRIPTIONS, seq),
    url:
      style === 'github'
        ? `https://github.com/${repoSlug}`
        : `https://www.npmjs.com/package/${repoSlug}`,
    homepage: null,
    language: null,
    license: null,
    owner,
    primaryMetric: 'stars',
    upstreamCreatedAt: daysAgo(anchor, 20 + ((seq * 53) % 400)),
    isArchived: false,
    flags: [],
    topics: pickTopics(seq),
  };
}

function buildFixtures(anchor: Date): FixtureItem[] {
  const fixtures: FixtureItem[] = [];
  let seq = 0;

  for (const repo of GITHUB_REPOS) fixtures.push(githubFixture(repo, seq++, anchor));
  for (const pkg of NPM_PACKAGES) fixtures.push(npmFixture(pkg, seq++, anchor));
  for (const pkg of PYPI_PACKAGES) fixtures.push(pypiFixture(pkg, seq++, anchor));
  for (const model of HF_MODELS) fixtures.push(huggingfaceFixture('model', model, seq++, anchor));
  for (const dataset of HF_DATASETS)
    fixtures.push(huggingfaceFixture('dataset', dataset, seq++, anchor));
  for (const space of HF_SPACES) fixtures.push(huggingfaceFixture('space', space, seq++, anchor));
  ARXIV_TITLES.forEach((_, index) => fixtures.push(arxivFixture(index, anchor)));
  for (const name of MCP_REGISTRY) fixtures.push(mcpRegistryFixture(name, seq++, anchor));
  for (const repo of MCP_FALLBACK_REPOS)
    fixtures.push(mcpFallbackFixture(repo, 'github', seq++, anchor));
  for (const pkg of MCP_FALLBACK_PACKAGES)
    fixtures.push(mcpFallbackFixture(pkg, 'npm', seq++, anchor));

  for (const fixture of fixtures) {
    const override = OVERRIDES[`${fixture.source}:${fixture.externalId}`];
    if (override !== undefined) {
      fixture.flags = override.flags ?? fixture.flags;
      fixture.isArchived = override.isArchived ?? fixture.isArchived;
    }
  }

  return fixtures;
}

function fixtureKey(fixture: FixtureItem): string {
  return `${fixture.source}:${fixture.externalId}`;
}

function toItemUpsert(fixture: FixtureItem): ItemUpsert {
  return {
    source: fixture.source,
    kind: fixture.kind,
    externalId: fixture.externalId,
    upstreamId: fixture.upstreamId,
    name: fixture.name,
    displayName: fixture.displayName,
    description: fixture.description,
    url: fixture.url,
    homepage: fixture.homepage,
    language: fixture.language,
    license: fixture.license,
    owner: fixture.owner,
    primaryMetric: fixture.primaryMetric,
    upstreamCreatedAt: fixture.upstreamCreatedAt,
    isArchived: fixture.isArchived,
    metadata: { seed: true },
    flags: fixture.flags,
  };
}

// ---------------------------------------------------------------------------
// Series generation (60 days per metric, deterministic)
// ---------------------------------------------------------------------------

interface MetricPlan {
  cumulative: Metric[];
  gauge: Metric[];
  daily: Metric[];
}

const PLANS: Record<Source, MetricPlan> = {
  github: { cumulative: ['stars', 'forks'], gauge: ['open_issues'], daily: [] },
  npm: { cumulative: ['downloads_total'], gauge: [], daily: ['downloads'] },
  pypi: { cumulative: ['downloads_total'], gauge: [], daily: ['downloads'] },
  huggingface: { cumulative: ['likes'], gauge: ['trending_score'], daily: ['downloads'] },
  arxiv: { cumulative: ['upvotes'], gauge: [], daily: [] },
  mcp: { cumulative: ['stars'], gauge: [], daily: [] },
};

/**
 * Metrics that are generated only to feed `latest_metrics` and never persisted
 * as a series. Spec §7.3.4: HF `downloads` is a rolling ~30-day count that is
 * stored only in `latest_metrics`, not as a snapshot/daily series (it has no
 * scoring params entry and must never reach the scoring input).
 */
function isLatestOnly(source: Source, metric: Metric): boolean {
  return source === 'huggingface' && metric === 'downloads';
}

interface BurstDays {
  days: number;
  factor: number;
}

interface ItemSeries {
  fixture: FixtureItem;
  /** metric → 60 values, oldest first. */
  series: Map<Metric, number[]>;
  /** Relative growth of the primary metric over the last 7 days. */
  momentum: number;
}

function metricBase(metric: Metric, starsBase: number | null, rand: () => number): number {
  switch (metric) {
    case 'stars':
      return 250 + 80_000 * rand() ** 4;
    case 'forks':
      return Math.max(5, (starsBase ?? 800) * (0.04 + rand() * 0.18));
    case 'open_issues':
      return 15 + 700 * rand() ** 2;
    case 'downloads_total':
      return 40_000 + 4_000_000 * rand() ** 3;
    case 'downloads':
      return 800 + 400_000 * rand() ** 3;
    case 'likes':
      return 15 + 5_000 * rand() ** 4;
    case 'upvotes':
      return 5 + 600 * rand() ** 3;
    case 'trending_score':
      return 5 + 85 * rand();
    default:
      return 10 + 2_000 * rand() ** 3;
  }
}

function cumulativeSeries(base: number, rand: () => number, burst: BurstDays | null): number[] {
  const damp = Math.min(1, Math.max(0.15, 5_000 / (5_000 + base)));
  const growth = (0.0006 + rand() ** 2 * 0.009) * damp;
  const values: number[] = [];
  let value = base;
  for (let day = 0; day < DAYS; day += 1) {
    let increment = value * growth * (0.6 + 0.8 * rand());
    if (burst !== null && day >= DAYS - burst.days) increment *= burst.factor;
    value += increment;
    values.push(Math.round(value));
  }
  return values;
}

/** Weekday seasonality for download counts (0 = Sunday). */
const DOW_FACTORS = [0.62, 0.98, 1.06, 1.06, 1.02, 0.98, 0.55] as const;

function dailySeries(
  base: number,
  anchor: Date,
  rand: () => number,
  burst: BurstDays | null,
): number[] {
  const growth = (rand() - 0.4) * 0.004;
  const values: number[] = [];
  let level = base;
  for (let day = 0; day < DAYS; day += 1) {
    level *= 1 + growth;
    const dayStart = new Date(anchor.getTime() - (DAYS - 1 - day) * DAY_MS);
    const factor = at(DOW_FACTORS, dayStart.getUTCDay());
    let value = level * factor * (0.88 + 0.24 * rand());
    if (burst !== null && day >= DAYS - burst.days) value *= burst.factor;
    values.push(Math.max(0, Math.round(value)));
  }
  return values;
}

function gaugeSeries(base: number, rand: () => number, cap: number | null): number[] {
  const values: number[] = [];
  let value = base * (0.7 + 0.6 * rand());
  for (let day = 0; day < DAYS; day += 1) {
    value += (base - value) * 0.08 + base * (rand() - 0.5) * 0.12;
    const rounded = Math.max(0, Math.round(value));
    values.push(cap !== null ? Math.min(cap, rounded) : rounded);
  }
  return values;
}

function cumulativeFromDaily(daily: number[], offset: number): number[] {
  const values: number[] = [];
  let total = offset;
  for (const value of daily) {
    total += value;
    values.push(Math.round(total));
  }
  return values;
}

function valueAt(values: number[], index: number): number {
  const clamped = Math.max(0, Math.min(values.length - 1, index));
  return values[clamped] ?? 0;
}

function computeMomentum(primary: Metric, series: Map<Metric, number[]>): number {
  const values = series.get(primary);
  if (values === undefined || values.length < 14) return 0;
  if (METRIC_KIND[primary] === 'cumulative') {
    const last = valueAt(values, values.length - 1);
    const before = valueAt(values, values.length - 8);
    return (last - before) / Math.max(1, before);
  }
  const recent = values.slice(-7).reduce((a, b) => a + b, 0);
  const prior = values.slice(-14, -7).reduce((a, b) => a + b, 0);
  return (recent + 1) / (prior + 1) - 1;
}

function buildSeries(fixtures: FixtureItem[], anchor: Date): ItemSeries[] {
  const rand = mulberry32(PRNG_SEED);
  let bursting = 0;

  return fixtures.map((fixture) => {
    // Drawn for every item so the PRNG stream is stable regardless of the cap.
    const wantsBurst = rand() < 0.07;
    const burstDays = 3 + Math.floor(rand() * 4);
    const burstFactor = 1.6 + rand() * 4;
    const burst: BurstDays | null =
      wantsBurst && bursting < 14 ? { days: burstDays, factor: burstFactor } : null;
    if (burst !== null) bursting += 1;

    const plan = PLANS[fixture.source];
    const primary = fixture.primaryMetric;
    const series = new Map<Metric, number[]>();

    const dailyValues = new Map<Metric, number[]>();
    for (const metric of plan.daily) {
      dailyValues.set(
        metric,
        dailySeries(
          metricBase(metric, null, rand),
          anchor,
          rand,
          metric === primary ? burst : null,
        ),
      );
    }

    let starsBase: number | null = null;
    for (const metric of plan.cumulative) {
      const base = metricBase(metric, starsBase, rand);
      if (metric === 'stars') starsBase = base;
      series.set(
        metric,
        metric === 'downloads_total'
          ? cumulativeFromDaily(dailyValues.get('downloads') ?? [], base)
          : cumulativeSeries(base, rand, metric === primary ? burst : null),
      );
    }

    for (const metric of plan.gauge) {
      series.set(
        metric,
        gaugeSeries(metricBase(metric, null, rand), rand, metric === 'trending_score' ? 100 : null),
      );
    }
    for (const [metric, values] of dailyValues) series.set(metric, values);

    return { fixture, series, momentum: computeMomentum(primary, series) };
  });
}

/**
 * Ranking-based tiering: the strongest recent movers become `hot`, the next
 * band `warm`, everything else `cold`; explicitly archived fixtures stay
 * `archived` (the real tiering job replaces these values in production).
 */
function assignTiers(seriesData: ItemSeries[]): Map<string, Tier> {
  const ranked = seriesData
    .map((item, index) => ({ index, momentum: item.momentum }))
    .sort((a, b) => b.momentum - a.momentum);

  const tiers = new Map<string, Tier>();
  ranked.forEach((entry, rank) => {
    const item = seriesData[entry.index];
    if (item === undefined) return;
    const tier: Tier = item.fixture.isArchived
      ? 'archived'
      : rank < 15
        ? 'hot'
        : rank < 50
          ? 'warm'
          : 'cold';
    tiers.set(fixtureKey(item.fixture), tier);
  });
  return tiers;
}

function buildSeedApiKey(pepper: string): { raw: string; prefix: string; hash: Buffer } {
  const suffix = stableToken(SEED_KEY_MATERIAL, 32);
  const raw = `dt_live_${SEED_KEY_PREFIX}_${suffix}`;
  return {
    raw,
    prefix: `dt_live_${SEED_KEY_PREFIX}`,
    hash: createHmac('sha256', pepper).update(raw).digest(),
  };
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

export async function seed(db: Db, options: SeedOptions): Promise<SeedReport> {
  const now = options.now ?? new Date();
  const anchorDay = utcMidnight(now);
  const adminEmail = options.adminEmail.trim().toLowerCase();
  const fixtures = buildFixtures(anchorDay);
  const seriesData = buildSeries(fixtures, anchorDay);
  const tiers = assignTiers(seriesData);
  const apiKeyMaterial = buildSeedApiKey(options.pepper);
  const slugsUsed = [...new Set(fixtures.flatMap((fixture) => fixture.topics))];

  const sources: Record<Source, number> = {
    github: 0,
    npm: 0,
    pypi: 0,
    huggingface: 0,
    arxiv: 0,
    mcp: 0,
  };
  for (const fixture of fixtures) sources[fixture.source] += 1;

  return db.transaction(async (tx) => {
    // 1. Items (adapter-owned columns only; tier/flags are handled below).
    const idByKey = new Map<string, bigint>();
    for (const row of await upsertItems(tx, fixtures.map(toItemUpsert))) {
      idByKey.set(`${row.source}:${row.externalId}`, row.id);
    }
    const idOf = (fixture: FixtureItem): bigint => {
      const id = idByKey.get(fixtureKey(fixture));
      if (id === undefined) throw new Error(`seed: missing item id for ${fixtureKey(fixture)}`);
      return id;
    };

    // 2. Series rows: daily bucket snapshots for cumulative/gauge metrics,
    //    daily_metrics for daily counts (npm/PyPI downloads; HF downloads are
    //    latest-only and never persisted as a series).
    const snapshotRows: SnapshotUpsert[] = [];
    const dailyRows: DailyMetricUpsert[] = [];
    const pairRows: ItemMetricPair[] = [];
    const latestDownloads = new Map<bigint, number>();

    for (const item of seriesData) {
      const itemId = idOf(item.fixture);
      for (const [metric, values] of item.series) {
        const kind = METRIC_KIND[metric];
        values.forEach((value, day) => {
          const dayStart = new Date(anchorDay.getTime() - (DAYS - 1 - day) * DAY_MS);
          if (kind === 'daily_count') {
            if (!isLatestOnly(item.fixture.source, metric)) {
              dailyRows.push({ itemId, metric, day: isoDay(dayStart), value });
            }
          } else {
            snapshotRows.push({
              itemId,
              metric,
              capturedAt: dayStart,
              observedAt: new Date(
                dayStart.getTime() +
                  3_600_000 * (1 + (Number(itemId) % 5)) +
                  60_000 * ((day * 13) % 60),
              ),
              value,
            });
          }
        });
        if (kind === 'daily_count') {
          if (metric === 'downloads') {
            latestDownloads.set(itemId, values[values.length - 1] ?? 0);
          }
        } else {
          pairRows.push({ itemId, metric });
        }
      }
    }

    await upsertSnapshots(tx, snapshotRows, { refreshAggregates: false });
    await upsertDailyMetrics(tx, dailyRows);
    await refreshItemAggregates(tx, pairRows);

    // 3. Mirror the latest daily download count into latest_metrics so the
    //    boards that read the item row alone see a downloads number.
    if (latestDownloads.size > 0) {
      const values = sql.join(
        [...latestDownloads].map(([itemId, value]) => sql`(${itemId}::bigint, ${value}::bigint)`),
        sql`, `,
      );
      await tx.execute(sql`
        UPDATE items i
        SET latest_metrics = i.latest_metrics || jsonb_build_object('downloads', v.value),
            updated_at = now()
        FROM (VALUES ${values}) AS v(item_id, value)
        WHERE i.id = v.item_id`);
    }

    // 4. Tiers from the generated momentum ranking.
    const tierEntries = [...tiers]
      .map(([key, tier]) => ({ itemId: idByKey.get(key), tier }))
      .filter((row): row is { itemId: bigint; tier: Tier } => row.itemId !== undefined);
    if (tierEntries.length > 0) {
      const values = sql.join(
        tierEntries.map((row) => sql`(${row.itemId}::bigint, ${row.tier}::tier_t)`),
        sql`, `,
      );
      await tx.execute(sql`
        UPDATE items i
        SET tier = v.tier, updated_at = now()
        FROM (VALUES ${values}) AS v(item_id, tier)
        WHERE i.id = v.item_id`);
    }

    // 5. Topics + links (spec §6.2; slugs come pre-normalized from the pool).
    const topicLinks: { itemId: bigint; topicId: number }[] = [];
    if (slugsUsed.length > 0) {
      await tx
        .insert(topics)
        .values(slugsUsed.map((slug) => ({ slug, name: titleize(slug) })))
        .onConflictDoNothing();
      const topicRows = await tx
        .select({ id: topics.id, slug: topics.slug })
        .from(topics)
        .where(inArray(topics.slug, slugsUsed));
      const topicIdBySlug = new Map(topicRows.map((row) => [row.slug, row.id]));
      for (const item of seriesData) {
        const itemId = idOf(item.fixture);
        for (const slug of item.fixture.topics) {
          const topicId = topicIdBySlug.get(slug);
          if (topicId !== undefined) topicLinks.push({ itemId, topicId });
        }
      }
      if (topicLinks.length > 0) {
        await tx.insert(itemTopics).values(topicLinks).onConflictDoNothing();
      }
      await tx.execute(sql`
        UPDATE topics
        SET item_count = (SELECT count(*) FROM item_topics it WHERE it.topic_id = topics.id)::int`);
    }

    // 6. Admin user + deterministic API key (spec §15; raw key only printed).
    const [userRow] = await tx
      .insert(users)
      .values({
        email: adminEmail,
        displayName: 'Seed Admin',
        role: 'admin',
        emailVerifiedAt: now,
      })
      .onConflictDoUpdate({
        target: users.email,
        set: {
          role: 'admin',
          displayName: 'Seed Admin',
          emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, excluded.email_verified_at)`,
        },
      })
      .returning({ id: users.id });
    if (userRow === undefined) throw new Error('seed: admin user upsert returned no row');

    await tx
      .insert(apiKeys)
      .values({
        userId: userRow.id,
        name: SEED_KEY_NAME,
        prefix: apiKeyMaterial.prefix,
        keyHash: apiKeyMaterial.hash,
        scopes: ['read', 'admin'],
        rateLimitPerMin: 600,
      })
      .onConflictDoUpdate({
        target: apiKeys.prefix,
        set: {
          userId: userRow.id,
          keyHash: apiKeyMaterial.hash,
          scopes: ['read', 'admin'],
          revokedAt: null,
          expiresAt: null,
        },
      });

    return {
      items: fixtures.length,
      snapshots: snapshotRows.length,
      dailyMetrics: dailyRows.length,
      topics: slugsUsed.length,
      itemTopics: topicLinks.length,
      users: 1,
      apiKeys: 1,
      sources,
      adminEmail,
      apiKeyPrefix: apiKeyMaterial.prefix,
      apiKey: apiKeyMaterial.raw,
    } satisfies SeedReport;
  });
}

// ---------------------------------------------------------------------------
// CLI (`node dist/seed.js` — compose smoke loads the seed through this path)
// ---------------------------------------------------------------------------

/**
 * `node dist/seed.js` detection that survives symlinks (same pattern as the
 * migrator): compose executes `packages/db/dist/seed.js` while Node resolves
 * `import.meta.url` to the real path under `node_modules/@trendr/db`.
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/** Local DX: pick up `.env` when the shell has not exported it (compose sets env itself). */
function loadEnvFiles(candidates: readonly string[]): void {
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    process.loadEnvFile(candidate);
  }
}

if (isDirectRun()) {
  loadEnvFiles(['.env', '../../.env', '../../../.env']);

  const databaseUrl = process.env.DATABASE_URL;
  const pepper = process.env.API_KEY_PEPPER;
  const firstAdmin = (process.env.ADMIN_EMAILS ?? '').split(',')[0]?.trim();
  const adminEmail =
    firstAdmin !== undefined && firstAdmin !== '' ? firstAdmin : 'admin@trendr.local';

  if (!databaseUrl) {
    console.error('DATABASE_URL is required to seed (see .env.example)');
    process.exit(1);
  }
  if (!pepper || pepper.length < 32) {
    console.error('API_KEY_PEPPER (min 32 chars) is required to seed (see .env.example)');
    process.exit(1);
  }

  const { db, pool } = createDb(databaseUrl, { max: 1 });
  try {
    const report = await seed(db, { pepper, adminEmail });
    const breakdown = Object.entries(report.sources)
      .map(([source, count]) => `${source} ${count}`)
      .join(', ');
    console.log(`seed: ${report.items} items (${breakdown})`);
    console.log(
      `seed: ${report.snapshots} snapshots, ${report.dailyMetrics} daily rows, ` +
        `${report.topics} topics, ${report.itemTopics} item-topic links`,
    );
    console.log(`seed: admin user ${report.adminEmail}`);
    console.log(`seed: API key (dev, scopes read+admin): ${report.apiKey}`);
  } catch (error) {
    console.error('seed failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
