import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { FetchedItem } from '../adapter.js';
import { normalizePypiItem, type PypiRaw } from './pypi.adapter.js';
import { PypiProjectSchema, PypiStatsOverallSchema } from './schemas.js';

/**
 * Spec §18 task 5.2 — fixture tests for PyPI `normalize`: project JSON,
 * `project_urls` aliases, SCM metadata, PEP 503 identity and the metadata-less
 * daily download shape. Assertions use the fixture's own values so
 * re-recording refreshes the data without invalidating the mapping.
 */

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
}

const PROJECT = PypiProjectSchema.parse(fixture('project.json'));
const OVERALL = PypiStatsOverallSchema.parse(fixture('stats-overall.json'));

function fetched(raw: PypiRaw, externalId = 'mcp'): FetchedItem<PypiRaw> {
  return {
    ref: { source: 'pypi', kind: 'package', externalId },
    raw,
    fetchedAt: new Date('2026-10-20T12:00:00Z'),
  };
}

describe('normalizePypiItem — project JSON (spec §7.3.3)', () => {
  it('maps identity, SCM metadata and the GitHub alias', () => {
    const normalized = normalizePypiItem(fetched({ kind: 'metadata', project: PROJECT }));
    expect(normalized).not.toBeNull();
    const item = normalized?.item;
    expect(item).toMatchObject({
      source: 'pypi',
      kind: 'package',
      externalId: 'mcp',
      upstreamId: null,
      name: 'mcp',
      displayName: 'mcp',
      description: PROJECT.info.summary,
      url: 'https://pypi.org/project/mcp/',
      homepage: 'https://modelcontextprotocol.io',
      language: 'python',
      license: 'MIT',
      owner: PROJECT.info.author,
      primaryMetric: 'downloads',
      isArchived: false,
    });
    expect(item?.upstreamCreatedAt).toBeInstanceOf(Date);
    expect(item?.topics).toContain('llm');
    expect(item?.topics).toContain('mcp');
    expect(item?.metadata).toMatchObject({
      repository: 'modelcontextprotocol/python-sdk',
      version: PROJECT.info.version,
      requiresPython: PROJECT.info.requires_python,
    });
    expect(normalized?.snapshots).toEqual([]);
    expect(normalized?.daily).toEqual([]);
    expect(normalized?.aliases).toEqual([
      {
        source: 'github',
        kind: 'repo',
        externalId: 'modelcontextprotocol/python-sdk',
        relation: 'package_of',
        confidence: 0.9,
        evidence: 'pypi.project_urls',
      },
    ]);
  });

  it('canonicalizes the name and returns null for absent/not-modified payloads', () => {
    const normalized = normalizePypiItem(fetched({ kind: 'metadata', project: PROJECT }, 'MCP'));
    expect(normalized?.item.externalId).toBe('mcp');
    expect(
      normalizePypiItem({ ...fetched({ kind: 'metadata', project: null }), notFound: true }),
    ).toBeNull();
    expect(
      normalizePypiItem({ ...fetched({ kind: 'metadata', project: PROJECT }), notModified: true }),
    ).toBeNull();
    expect(normalizePypiItem(fetched({ kind: 'metadata', project: null }))).toBeNull();
  });
});

describe('normalizePypiItem — downloads (spec §7.3.3)', () => {
  it('maps without_mirrors points to daily rows and keeps the daily item metadata-less', () => {
    const points = OVERALL.data.filter((point) => point.category === 'without_mirrors').slice(-3);
    const normalized = normalizePypiItem(
      fetched({ kind: 'downloads', points, latestDay: points.at(-1)?.date ?? null }),
    );
    expect(normalized).not.toBeNull();
    expect(normalized?.item).toMatchObject({
      source: 'pypi',
      externalId: 'mcp',
      name: 'mcp',
      language: 'python',
      description: null,
      primaryMetric: 'downloads',
      upstreamId: null,
    });
    expect(normalized?.snapshots).toEqual([]);
    expect(normalized?.aliases).toEqual([]);
    expect(normalized?.daily).toEqual(
      points.map((point) => ({
        metric: 'downloads',
        day: point.date,
        value: point.downloads,
      })),
    );
  });
});
