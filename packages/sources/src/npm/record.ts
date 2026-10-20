import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { npmWindowEndingAt } from './downloads.js';

/**
 * Spec §16 — `pnpm fixtures:record --source npm` runs against the live
 * registry/downloads APIs with `RECORD=1` and writes raw JSON responses into
 * `__fixtures__/`. It also captures the evidence behind the adapter choices:
 * `last-day` is yesterday, today is present with `0`, and scoped packages are
 * rejected by the bulk endpoint (HTTP 400).
 */

const REGISTRY = 'https://registry.npmjs.org';
const DOWNLOADS = 'https://api.npmjs.org';
const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

/** Small, long-lived package with a GitHub repository (keeps the fixture tiny). */
const PACKUMENT_PACKAGE = 'is-number';
/** Public scoped package for the encoded single fetch. */
const SCOPED_PACKAGE = '@modelcontextprotocol/sdk';
/** Long-lived unscoped packages for the bulk mapping fixture. */
const BULK_PACKAGES = ['react', 'vue', 'typescript'] as const;

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

function encodeName(name: string): string {
  return name.replace('/', '%2F');
}

async function request(url: string, userAgent: string): Promise<ProbeResult> {
  const response = await fetch(url, { headers: { 'user-agent': userAgent } });
  return { status: response.status, body: await response.text(), headers: response.headers };
}

async function writeFixture(name: string, body: string): Promise<void> {
  const parsed: unknown = JSON.parse(body);
  await writeFile(
    join(FIXTURES_DIR, name),
    `${sanitize(JSON.stringify(parsed, null, 2))}\n`,
    'utf8',
  );
}

export async function recordNpmFixtures(): Promise<void> {
  if (process.env.RECORD !== '1') {
    throw new Error('fixtures:record calls the live npm APIs; set RECORD=1 to confirm.');
  }
  const userAgent =
    process.env.HTTP_USER_AGENT ?? 'Trendr/1.0 (+https://github.com/nayankunwar/trendr)';
  const now = new Date();
  await mkdir(FIXTURES_DIR, { recursive: true });

  // ── evidence: `last-day` is the authoritative available day ─────────────
  // At 03:09Z the range endpoint still echoed the previous request end with a
  // `0` row, so the adapter anchors on this point probe instead.
  const point = await request(`${DOWNLOADS}/downloads/point/last-day/react`, userAgent);
  if (point.status !== 200) throw new Error(`npm point last-day failed with ${point.status}`);
  await writeFixture('point-last-day.json', point.body);
  const lastDay = (JSON.parse(point.body) as { end: string }).end;
  const window = npmWindowEndingAt(lastDay);

  // ── keyword search (discovery payload) ──────────────────────────────────
  const search = await request(
    `${REGISTRY}/-/v1/search?text=keywords%3Amcp&size=5&from=0`,
    userAgent,
  );
  if (search.status !== 200) throw new Error(`npm search failed with ${search.status}`);
  await writeFixture('search.json', search.body);
  const searchBody = JSON.parse(search.body) as {
    objects?: { package?: { links?: { repository?: string | null } } }[];
  };
  const searchRepository = searchBody.objects?.[0]?.package?.links?.repository ?? null;

  // ── full packument (refresh/snapshot payload, repository alias) ─────────
  const packument = await request(`${REGISTRY}/${encodeName(PACKUMENT_PACKAGE)}`, userAgent);
  if (packument.status !== 200) throw new Error(`npm packument failed with ${packument.status}`);
  await writeFixture('packument.json', packument.body);
  const packumentBody = JSON.parse(packument.body) as {
    repository?: string | { url?: string };
  };
  const packumentRepository =
    typeof packumentBody.repository === 'string'
      ? packumentBody.repository
      : (packumentBody.repository?.url ?? null);

  // ── downloads: 3-day bulk window (D-2 … D) ──────────────────────────────
  const bulk = await request(
    `${DOWNLOADS}/downloads/range/${window.start}:${window.end}/${BULK_PACKAGES.join(',')}`,
    userAgent,
  );
  if (bulk.status !== 200) throw new Error(`npm bulk downloads failed with ${bulk.status}`);
  await writeFixture('downloads-bulk.json', bulk.body);

  // ── downloads: scoped single request (`@scope%2Fname`) ──────────────────
  const scoped = await request(
    `${DOWNLOADS}/downloads/range/${window.start}:${window.end}/${encodeName(SCOPED_PACKAGE)}`,
    userAgent,
  );
  if (scoped.status !== 200) throw new Error(`npm scoped downloads failed with ${scoped.status}`);
  await writeFixture('downloads-scoped.json', scoped.body);

  // ── evidence: scoped names are rejected by the bulk endpoint ────────────
  const scopedBulk = await request(
    `${DOWNLOADS}/downloads/range/${window.start}:${window.end}/react,${encodeName(SCOPED_PACKAGE)}`,
    userAgent,
  );

  const meta = {
    recordedAt: now.toISOString(),
    userAgent,
    window,
    lastDay: JSON.parse(point.body) as { start: string; end: string },
    bulkPackages: BULK_PACKAGES,
    scopedPackage: SCOPED_PACKAGE,
    search: {
      cacheControl: search.headers.get('cache-control'),
      repository: searchRepository,
    },
    packument: {
      package: PACKUMENT_PACKAGE,
      repository: packumentRepository,
      cacheControl: packument.headers.get('cache-control'),
    },
    scopedBulk: {
      status: scopedBulk.status,
      body: scopedBulk.body,
    },
  };
  await writeFile(join(FIXTURES_DIR, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  console.log(`fixtures written to ${FIXTURES_DIR}`);
  console.log(`window: ${window.start} … ${window.end} (last-day ${meta.lastDay.start})`);
  console.log(`scoped bulk evidence: ${scopedBulk.status} ${scopedBulk.body}`);
}
