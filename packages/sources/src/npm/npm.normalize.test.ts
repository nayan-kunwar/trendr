import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { FetchedItem } from '../adapter.js';
import { normalizeNpmItem, type NpmRaw } from './npm.adapter.js';
import {
  NpmBulkDownloadsSchema,
  NpmDownloadsRangeSchema,
  NpmPackumentSchema,
  NpmSearchResponseSchema,
} from './schemas.js';

/**
 * Spec §18 task 5.1 — fixture tests for npm `normalize`: search payload,
 * full packument, bulk/scoped download ranges, alias extraction and the
 * metadata-less daily shape. Fixtures are live captures (spec §16); the
 * assertions compare against each fixture's own values so re-recording
 * refreshes the data without invalidating the mapping.
 */

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
}

const SEARCH = NpmSearchResponseSchema.parse(fixture('search.json'));
const PACKUMENT = NpmPackumentSchema.parse(fixture('packument.json'));
const BULK = NpmBulkDownloadsSchema.parse(fixture('downloads-bulk.json'));
const SCOPED = NpmDownloadsRangeSchema.parse(fixture('downloads-scoped.json'));

function fetched(raw: NpmRaw, externalId: string): FetchedItem<NpmRaw> {
  return {
    ref: { source: 'npm', kind: 'package', externalId },
    raw,
    fetchedAt: new Date('2026-10-20T12:00:00Z'),
  };
}

describe('normalizeNpmItem — search (spec §7.3.2)', () => {
  it('maps the scoped fixture package, topics and GitHub repository alias', () => {
    const result = SEARCH.objects[0];
    if (result === undefined) throw new Error('search fixture has no objects[0]');
    const normalized = normalizeNpmItem(fetched({ kind: 'search', result }, result.package.name));
    expect(normalized).not.toBeNull();
    const item = normalized?.item;
    expect(item).toMatchObject({
      source: 'npm',
      kind: 'package',
      externalId: result.package.name.toLowerCase(),
      upstreamId: null,
      url: `https://www.npmjs.com/package/${result.package.name.toLowerCase()}`,
      primaryMetric: 'downloads',
      isArchived: false,
      upstreamCreatedAt: null,
    });
    // Search dates are latest *publish* dates, never package creation.
    expect(item?.name).toBe(result.package.name.split('/').at(-1));
    expect(item?.owner).toBe('@modelcontextprotocol');
    expect(item?.description).toBe(result.package.description ?? null);
    expect(item?.license).toBe(result.package.license ?? null);
    expect(item?.topics).toContain('mcp');
    expect(item?.metadata.repository).toContain('github.com/modelcontextprotocol/typescript-sdk');
    expect(normalized?.aliases).toEqual([
      {
        source: 'github',
        kind: 'repo',
        externalId: 'modelcontextprotocol/typescript-sdk',
        relation: 'package_of',
        confidence: 0.9,
        evidence: 'npm.repository.url',
      },
    ]);
    expect(normalized?.daily).toEqual([]);
    expect(normalized?.snapshots).toEqual([]);
  });

  it('leaves owner null for unscoped packages and resolves their alias', () => {
    const result = SEARCH.objects.find((entry) => !entry.package.name.startsWith('@'));
    if (result === undefined) throw new Error('search fixture has no unscoped package');
    const normalized = normalizeNpmItem(fetched({ kind: 'search', result }, result.package.name));
    expect(normalized?.item.owner).toBeNull();
    expect(normalized?.item.name).toBe(result.package.name);
    const repository = result.package.links?.repository;
    if (typeof repository === 'string' && repository.includes('github.com/vercel/ai')) {
      expect(normalized?.aliases[0]?.externalId).toBe('vercel/ai');
    }
  });
});

describe('normalizeNpmItem — packument (spec §7.3.2)', () => {
  it('fills creation date and descriptive metadata from the full doc', () => {
    const normalized = normalizeNpmItem(
      fetched({ kind: 'packument', packument: PACKUMENT }, 'is-number'),
    );
    expect(normalized).not.toBeNull();
    const item = normalized?.item;
    expect(item).toMatchObject({
      externalId: 'is-number',
      name: 'is-number',
      owner: null,
      language: 'javascript',
      license: 'MIT',
      primaryMetric: 'downloads',
      isArchived: false,
    });
    expect(item?.description).toBe(PACKUMENT.description ?? null);
    expect(item?.homepage).toBe(PACKUMENT.homepage ?? null);
    expect(item?.upstreamCreatedAt).toEqual(new Date('2014-09-22T01:58:51.592Z'));
    expect(item?.topics).toContain('cast');
    expect(item?.metadata.version).toBe('7.0.0');
    expect(normalized?.aliases[0]).toMatchObject({
      externalId: 'jonschlinkert/is-number',
      relation: 'package_of',
    });
    expect(normalized?.daily).toEqual([]);
  });

  it('marks packages with types/typings as TypeScript', () => {
    const latest = PACKUMENT['dist-tags']?.latest;
    if (latest === undefined) throw new Error('packument fixture has no latest tag');
    const manifest = PACKUMENT.versions?.[latest];
    if (manifest === undefined) throw new Error('packument fixture has no latest manifest');
    const typed = {
      ...PACKUMENT,
      versions: { ...PACKUMENT.versions, [latest]: { ...manifest, types: 'index.d.ts' } },
    };
    const normalized = normalizeNpmItem(
      fetched({ kind: 'packument', packument: typed }, 'is-number'),
    );
    expect(normalized?.item.language).toBe('typescript');
  });

  it('drops non-http homepages from packuments', () => {
    const unsafe = { ...PACKUMENT, homepage: 'javascript:alert(1)' };
    const normalized = normalizeNpmItem(
      fetched({ kind: 'packument', packument: unsafe }, 'is-number'),
    );
    expect(normalized?.item.homepage).toBeNull();
  });

  it('returns null for a 404 / not-modified payload', () => {
    expect(
      normalizeNpmItem({
        ...fetched({ kind: 'packument', packument: null }, 'gone'),
        notFound: true,
      }),
    ).toBeNull();
    expect(
      normalizeNpmItem({
        ...fetched({ kind: 'packument', packument: null }, 'cached'),
        notModified: true,
      }),
    ).toBeNull();
    expect(normalizeNpmItem(fetched({ kind: 'packument', packument: null }, 'gone'))).toBeNull();
  });
});

describe('normalizeNpmItem — daily downloads (spec §7.3.2)', () => {
  it('maps the bulk fixture to daily rows with no metadata', () => {
    const range = BULK.react;
    if (range === undefined || range === null) throw new Error('bulk fixture is missing react');
    const normalized = normalizeNpmItem(
      fetched({ kind: 'downloads', range, day: range.end }, 'react'),
    );
    expect(normalized?.daily).toEqual(
      range.downloads.map((point) => ({
        metric: 'downloads',
        day: point.day,
        value: point.downloads,
      })),
    );
    const item = normalized?.item;
    expect(item).toMatchObject({
      externalId: 'react',
      name: 'react',
      owner: null,
      description: null,
      homepage: null,
      language: null,
      license: null,
      upstreamCreatedAt: null,
      metadata: {},
      primaryMetric: 'downloads',
    });
    expect(normalized?.aliases).toEqual([]);
  });

  it('splits a scoped package into owner and name', () => {
    const normalized = normalizeNpmItem(
      fetched({ kind: 'downloads', range: SCOPED, day: SCOPED.end }, SCOPED.package),
    );
    expect(normalized?.item).toMatchObject({
      externalId: '@modelcontextprotocol/sdk',
      owner: '@modelcontextprotocol',
      name: 'sdk',
    });
    expect(normalized?.daily).toHaveLength(3);
  });

  it('pins the recorded fixture window to the last available day', () => {
    const meta = fixture('meta.json') as {
      window: { start: string; end: string };
      lastDay: { start: string; end: string };
    };
    expect(meta.window.end).toBe(meta.lastDay.end);
    for (const range of [BULK.react, BULK.vue, BULK.typescript, SCOPED]) {
      if (range === null || range === undefined) throw new Error('fixture range is missing');
      expect(range.downloads).toHaveLength(3);
      expect(range.downloads[0]?.day).toBe(meta.window.start);
      expect(range.downloads.at(-1)?.day).toBe(meta.window.end);
    }
  });
});
