import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hfDetailUrl, hfListUrl, HF_LIST_EXPANDS, HF_DETAIL_EXPANDS } from './urls.js';

/**
 * Spec §16 — `RECORD=1 pnpm fixtures:record --source huggingface` records the
 * list/detail payloads used by the fixture tests, plus the live rate-limit and
 * `Link` cursor evidence behind §7.3.4/GAP-5. Anonymous access is enough for
 * these public endpoints; `HF_TOKEN` is used when present.
 */

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const MODEL = 'google-bert/bert-base-uncased';

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

function sanitize(text: string): string {
  let out = text;
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, '<redacted>');
  return out;
}

async function request(url: string, userAgent: string): Promise<ProbeResult> {
  const token = process.env.HF_TOKEN?.trim() ?? '';
  const headers: Record<string, string> = {
    'user-agent': userAgent,
    accept: 'application/json',
  };
  if (token !== '') headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  return { status: response.status, body: await response.text(), headers: response.headers };
}

function trimDescription(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(trimDescription);
  const record = value as Record<string, unknown>;
  if (typeof record.description === 'string' && record.description.length > 1_000) {
    return { ...record, description: `${record.description.slice(0, 1_000)}…` };
  }
  return record;
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(
    join(FIXTURES_DIR, name),
    `${sanitize(JSON.stringify(value, null, 2))}\n`,
    'utf8',
  );
}

async function writeFixture(name: string, body: string): Promise<void> {
  const parsed: unknown = JSON.parse(body);
  await writeJson(name, trimDescription(parsed));
}

export async function recordHuggingFaceFixtures(): Promise<void> {
  if (process.env.RECORD !== '1') {
    throw new Error(
      'fixtures:record calls the live Hugging Face Hub API; set RECORD=1 to confirm.',
    );
  }
  const userAgent =
    process.env.HTTP_USER_AGENT ?? 'Trendr/1.0 (+https://github.com/nayankunwar/trendr)';
  const now = new Date();
  await mkdir(FIXTURES_DIR, { recursive: true });

  const modelList = await request(hfListUrl('model', 'trendingScore', 2), userAgent);
  if (modelList.status !== 200) throw new Error(`HF model list failed with ${modelList.status}`);
  await writeFixture('model-list.json', modelList.body);
  const modelListLink = modelList.headers.get('link');

  const detail = await request(hfDetailUrl('model', MODEL), userAgent);
  if (detail.status !== 200) throw new Error(`HF model detail failed with ${detail.status}`);
  await writeFixture('model-detail.json', detail.body);
  const detailParsed = JSON.parse(detail.body) as { tags?: string[] };

  const datasetList = await request(hfListUrl('dataset', 'trendingScore', 1), userAgent);
  if (datasetList.status !== 200) {
    throw new Error(`HF dataset list failed with ${datasetList.status}`);
  }
  await writeFixture('dataset-list.json', datasetList.body);

  const spaceList = await request(hfListUrl('space', 'trendingScore', 1), userAgent);
  if (spaceList.status !== 200) throw new Error(`HF space list failed with ${spaceList.status}`);
  await writeFixture('space-list.json', spaceList.body);

  const meta = {
    recordedAt: now.toISOString(),
    userAgent,
    model: MODEL,
    rateLimit: modelList.headers.get('ratelimit'),
    rateLimitPolicy: modelList.headers.get('ratelimit-policy'),
    modelListLink,
    expands: {
      list: HF_LIST_EXPANDS,
      detail: HF_DETAIL_EXPANDS,
    },
    evidence: {
      modelDetailArxivTags: (detailParsed.tags ?? []).filter((tag) => tag.startsWith('arxiv:')),
      modelDetailFields: Object.keys(JSON.parse(detail.body) as Record<string, unknown>).sort(),
      datasetListFields: Object.keys(
        (JSON.parse(datasetList.body) as Record<string, unknown>[])[0] ?? {},
      ).sort(),
      spaceListFields: Object.keys(
        (JSON.parse(spaceList.body) as Record<string, unknown>[])[0] ?? {},
      ).sort(),
    },
  };
  await writeJson('meta.json', meta);

  console.log(`fixtures written to ${FIXTURES_DIR}`);
  console.log(`model list Link: ${modelListLink ?? '(none)'}`);
  console.log(`RateLimit: ${meta.rateLimit ?? '(none)'}`);
}
