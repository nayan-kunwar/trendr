import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePypiRss } from './rss.js';
import { PypiProjectSchema, PypiStatsOverallSchema, PypiStatsRecentSchema } from './schemas.js';
import { overallStatsUrl, projectJsonUrl, PYPI_FEEDS, recentStatsUrl } from './urls.js';

/**
 * Spec §16 — `pnpm fixtures:record --source pypi` runs against the live PyPI
 * and pypistats APIs with `RECORD=1`. It records both discovery feeds, a
 * project JSON trimmed to the fields the adapter consumes, and the 180-day /
 * recent pypistats payloads, plus the ETag/CDN evidence behind the adapter.
 */

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const FIXTURE_PACKAGE = 'mcp';

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
  const response = await fetch(url, {
    headers: { 'user-agent': userAgent, accept: 'application/json' },
  });
  return { status: response.status, body: await response.text(), headers: response.headers };
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(
    join(FIXTURES_DIR, name),
    `${sanitize(JSON.stringify(value, null, 2))}\n`,
    'utf8',
  );
}

export async function recordPypiFixtures(): Promise<void> {
  if (process.env.RECORD !== '1') {
    throw new Error('fixtures:record calls the live PyPI APIs; set RECORD=1 to confirm.');
  }
  const userAgent =
    process.env.HTTP_USER_AGENT ?? 'Trendr/1.0 (+https://github.com/nayankunwar/trendr)';
  const now = new Date();
  await mkdir(FIXTURES_DIR, { recursive: true });

  // ── discovery feeds (XML; newest and updates) ───────────────────────────
  const newest = await request(PYPI_FEEDS.newest, userAgent);
  if (newest.status !== 200) throw new Error(`PyPI newest RSS failed with ${newest.status}`);
  await writeFile(join(FIXTURES_DIR, 'rss-newest.xml'), sanitize(newest.body), 'utf8');

  const updates = await request(PYPI_FEEDS.updates, userAgent);
  if (updates.status !== 200) throw new Error(`PyPI updates RSS failed with ${updates.status}`);
  await writeFile(join(FIXTURES_DIR, 'rss-updates.xml'), sanitize(updates.body), 'utf8');

  // ── project JSON (ETag + project_urls → GitHub alias) ───────────────────
  const projectResponse = await request(projectJsonUrl(FIXTURE_PACKAGE), userAgent);
  if (projectResponse.status !== 200) {
    throw new Error(`PyPI project JSON failed with ${projectResponse.status}`);
  }
  const parsedProject: unknown = JSON.parse(projectResponse.body);
  const project = PypiProjectSchema.parse(parsedProject);
  const releases = Object.fromEntries(
    Object.entries(project.releases ?? {}).map(([version, files]) => [
      version,
      files.map((file) => ({
        upload_time_iso_8601: file.upload_time_iso_8601,
        upload_time: file.upload_time,
        yanked: file.yanked,
      })),
    ]),
  );
  await writeJson('project.json', { info: project.info, releases });

  // ── downloads: overall (180 days, without mirrors) and recent ────────────
  const overall = await request(overallStatsUrl(FIXTURE_PACKAGE), userAgent);
  if (overall.status !== 200) throw new Error(`pypistats overall failed with ${overall.status}`);
  const overallParsed = PypiStatsOverallSchema.parse(JSON.parse(overall.body) as unknown);
  const withoutMirrors = overallParsed.data.filter((point) => point.category === 'without_mirrors');
  await writeJson('stats-overall.json', {
    data: withoutMirrors,
    package: overallParsed.package,
    type: overallParsed.type ?? 'overall_downloads',
  });

  const recent = await request(recentStatsUrl(FIXTURE_PACKAGE), userAgent);
  if (recent.status !== 200) throw new Error(`pypistats recent failed with ${recent.status}`);
  const recentParsed = PypiStatsRecentSchema.parse(JSON.parse(recent.body) as unknown);
  await writeJson('stats-recent.json', recentParsed);

  const meta = {
    recordedAt: now.toISOString(),
    userAgent,
    package: FIXTURE_PACKAGE,
    project: {
      etag: projectResponse.headers.get('etag'),
      cacheControl: projectResponse.headers.get('cache-control'),
      lastSerial: projectResponse.headers.get('x-pypi-last-serial'),
      projectUrls: project.info.project_urls ?? {},
    },
    rss: {
      newest: {
        items: parsePypiRss(newest.body).length,
        cacheControl: newest.headers.get('cache-control'),
      },
      updates: {
        items: parsePypiRss(updates.body).length,
        cacheControl: updates.headers.get('cache-control'),
      },
    },
    stats: {
      overall: {
        points: withoutMirrors.length,
        first: withoutMirrors[0]?.date ?? null,
        last: withoutMirrors.at(-1)?.date ?? null,
      },
      recent: recentParsed.data,
    },
  };
  await writeJson('meta.json', meta);

  console.log(`fixtures written to ${FIXTURES_DIR}`);
  console.log(
    `package ${FIXTURE_PACKAGE}: ${withoutMirrors.length} overall points, recent ${
      recentParsed.data.last_week
    }/week`,
  );
}
