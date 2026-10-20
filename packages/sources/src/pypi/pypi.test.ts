import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { UpstreamError } from '@trendr/core';

import { parsePypiRss } from './rss.js';
import { PypiProjectSchema, PypiStatsOverallSchema, PypiStatsRecentSchema } from './schemas.js';
import {
  canonicalPypiName,
  isStatsIncomplete,
  keepLatestDays,
  latestDay,
  matchesPypiKeywords,
  overallStatsUrl,
  projectJsonUrl,
  projectPageUrl,
  pypiNameFromFeedLink,
  pypiNameFromFeedTitle,
  recentStatsUrl,
  windowEndingAt,
} from './urls.js';

const PYPI_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(PYPI_DIR, '__fixtures__');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

function seedFixture(): unknown {
  return JSON.parse(readFileSync(join(PYPI_DIR, 'seed.json'), 'utf8')) as unknown;
}

function jsonFixture(name: string): unknown {
  return JSON.parse(fixture(name)) as unknown;
}

describe('PyPI names and URLs (spec §7.3.3)', () => {
  it('applies PEP 503 normalization before every URL', () => {
    expect(canonicalPypiName('Zope.Interface')).toBe('zope-interface');
    expect(canonicalPypiName('foo__bar...baz')).toBe('foo-bar-baz');
    expect(canonicalPypiName('-not-a-name')).toBeNull();
    expect(canonicalPypiName('bad name')).toBeNull();
    expect(projectJsonUrl('Zope.Interface')).toBe('https://pypi.org/pypi/zope-interface/json');
    expect(projectPageUrl('Zope.Interface')).toBe('https://pypi.org/project/zope-interface/');
    expect(overallStatsUrl('Zope.Interface')).toBe(
      'https://pypistats.org/api/packages/zope-interface/overall?mirrors=false',
    );
    expect(recentStatsUrl('Zope.Interface')).toBe(
      'https://pypistats.org/api/packages/zope-interface/recent',
    );
  });

  it('reads the project name from RSS links and falls back to the title', () => {
    expect(pypiNameFromFeedLink('https://pypi.org/project/FastMCP/1.2.3/')).toBe('fastmcp');
    expect(pypiNameFromFeedLink('https://pypi.org/project/foo_bar/')).toBe('foo-bar');
    expect(pypiNameFromFeedLink('https://example.test/project/nope/')).toBeNull();
    expect(pypiNameFromFeedTitle('foo-bar 1.2.3')).toBe('foo-bar');
    expect(pypiNameFromFeedTitle('foo_bar added to PyPI')).toBe('foo-bar');
  });

  it('filters RSS items by name, title or summary with word boundaries', () => {
    expect(matchesPypiKeywords('mcp-server')).toBe(true);
    expect(matchesPypiKeywords('An LLM SDK')).toBe(true);
    expect(matchesPypiKeywords('multi-agent workflows')).toBe(true);
    expect(matchesPypiKeywords('storage utilities')).toBe(false);
    expect(matchesPypiKeywords('unrelated', null, 'uses JAX')).toBe(true);
  });

  it('selects the three-day window and reports an incomplete newest day', () => {
    const points = [
      { date: '2026-10-16', downloads: 1 },
      { date: '2026-10-17', downloads: 2 },
      { date: '2026-10-18', downloads: 3 },
      { date: '2026-10-19', downloads: 4 },
    ];
    expect(windowEndingAt(points, '2026-10-19', 3).map((point) => point.date)).toEqual([
      '2026-10-17',
      '2026-10-18',
      '2026-10-19',
    ]);
    expect(latestDay(points)).toBe('2026-10-19');
    expect(isStatsIncomplete(points, '2026-10-19')).toBe(false);
    expect(isStatsIncomplete(points, '2026-10-20')).toBe(true);
    expect(keepLatestDays(points, 2).map((point) => point.date)).toEqual([
      '2026-10-18',
      '2026-10-19',
    ]);
  });
});

describe('PyPI RSS parser (spec §7.3.3)', () => {
  it('parses the recorded newest and updates feeds', () => {
    const newest = parsePypiRss(fixture('rss-newest.xml'));
    const updates = parsePypiRss(fixture('rss-updates.xml'));
    expect(newest.length).toBeGreaterThan(0);
    expect(updates.length).toBeGreaterThan(0);
    expect(newest[0]?.title).toContain('added to PyPI');
    expect(newest[0]?.link).toContain('https://pypi.org/project/');
  });

  it('normalizes a one-item channel and rejects a schema mismatch', () => {
    const one = parsePypiRss(
      '<?xml version="1.0"?><rss><channel><item><title>mcp</title><link>https://pypi.org/project/mcp/</link></item></channel></rss>',
    );
    expect(one).toEqual([{ title: 'mcp', link: 'https://pypi.org/project/mcp/' }]);
    expect(() => parsePypiRss('<html><body>not rss</body></html>')).toThrow(UpstreamError);
  });
});

describe('PyPI fixtures and seed list (spec §16)', () => {
  it('record a project with project_urls and 180-day stats', () => {
    const project = PypiProjectSchema.parse(jsonFixture('project.json'));
    expect(project.info.name).toBe('mcp');
    expect(project.info.project_urls?.Repository).toContain('github.com/modelcontextprotocol');
    expect(Object.keys(project.releases ?? {}).length).toBeGreaterThan(10);

    const overall = PypiStatsOverallSchema.parse(jsonFixture('stats-overall.json'));
    expect(overall.package).toBe('mcp');
    expect(overall.data.length).toBeGreaterThanOrEqual(180);
    expect(overall.data.every((point) => point.category === 'without_mirrors')).toBe(true);

    const recent = PypiStatsRecentSchema.parse(jsonFixture('stats-recent.json'));
    expect(recent.data.last_week).toBeGreaterThan(500);
  });

  it('has no token prefixes or auth headers in any fixture', () => {
    const files = readdirSync(FIXTURES_DIR);
    expect(files.length).toBeGreaterThanOrEqual(6);
    const forbidden: { name: string; pattern: RegExp }[] = [
      { name: 'ghp_ classic PAT', pattern: /ghp_[A-Za-z0-9]/ },
      { name: 'github_pat_ fine-grained PAT', pattern: /github_pat_[A-Za-z0-9]/ },
      { name: 'hf_ token', pattern: /hf_[A-Za-z0-9]{10}/ },
      { name: 'npm_ token', pattern: /npm_[A-Za-z0-9]{10}/ },
      { name: 'authorization header', pattern: /authorization\s*:/i },
      { name: 'set-cookie header', pattern: /set-cookie\s*:/i },
    ];
    for (const file of files) {
      const text = fixture(file);
      for (const { name, pattern } of forbidden) {
        expect(pattern.test(text), `${file} contains ${name}`).toBe(false);
      }
    }
  });

  it('ships a ~300-project canonical seed list with unique names', () => {
    const seeds = z.array(z.string()).parse(seedFixture());
    expect(seeds.length).toBeGreaterThanOrEqual(290);
    expect(seeds.length).toBeLessThanOrEqual(310);
    expect(new Set(seeds).size).toBe(seeds.length);
    for (const name of seeds) {
      expect(canonicalPypiName(name), name).toBe(name);
    }
    expect(seeds.slice(0, 3)).toEqual(['mcp', 'fastmcp', 'langchain']);
  });
});
