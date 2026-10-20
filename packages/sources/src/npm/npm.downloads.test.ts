import { normalizeNpmPackage } from '@trendr/core';
import { describe, expect, it } from 'vitest';

import {
  NPM_BULK_MAX,
  addDays,
  bulkRangeUrl,
  chunkNpmNames,
  encodeNpmName,
  lastCompleteNpmDay,
  lastDayPointUrl,
  missingDailyBucket,
  npmWindowEndingAt,
  packumentUrl,
  parseGitHubRepositoryUrl,
  singleRangeUrl,
} from './downloads.js';
import { NPM_KEYWORDS, rotatedNpmKeywords } from './npm.adapter.js';

/**
 * Spec §18 task 5.1 — pure npm helpers: UTC day maths, scoped-name encoding,
 * bulk chunking and `repository` → GitHub alias parsing.
 */

describe('npm day maths (spec §7.3.2)', () => {
  it('anchors the last complete day on UTC, never local time', () => {
    expect(lastCompleteNpmDay(new Date('2026-10-20T00:00:01Z'))).toBe('2026-10-19');
    expect(lastCompleteNpmDay(new Date('2026-10-20T23:59:59Z'))).toBe('2026-10-19');
    // 03:09Z is after midnight but before npm computes the prior day; callers
    // must use the `last-day` probe instead of this plain UTC fallback.
    expect(lastCompleteNpmDay(new Date('2026-10-20T03:09:31Z'))).toBe('2026-10-19');
  });

  it('builds the inclusive D-2 … D window', () => {
    expect(npmWindowEndingAt('2026-10-18')).toEqual({
      start: '2026-10-16',
      end: '2026-10-18',
      days: ['2026-10-16', '2026-10-17', '2026-10-18'],
    });
  });

  it('crosses month and year boundaries', () => {
    expect(addDays('2026-03-01', -2)).toBe('2026-02-27');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('detects a missing newest daily bucket', () => {
    const complete = { downloads: [{ day: '2026-10-17' }, { day: '2026-10-18' }] };
    const late = { downloads: [{ day: '2026-10-17' }] };
    expect(missingDailyBucket(complete, '2026-10-18')).toBe(false);
    expect(missingDailyBucket(late, '2026-10-18')).toBe(true);
  });
});

describe('npm names and URLs (spec §7.3.2)', () => {
  it('encodes scoped names as @scope%2Fname and leaves unscoped names alone', () => {
    expect(encodeNpmName('@modelcontextprotocol/sdk')).toBe('@modelcontextprotocol%2Fsdk');
    expect(encodeNpmName('@MODELCONTEXTPROTOCOL/SDK')).toBe('@modelcontextprotocol%2Fsdk');
    expect(encodeNpmName('is-number')).toBe('is-number');
    expect(packumentUrl('@scope/pkg')).toBe('https://registry.npmjs.org/@scope%2Fpkg');
    expect(singleRangeUrl('2026-10-16', '2026-10-18', '@scope/pkg')).toBe(
      'https://api.npmjs.org/downloads/range/2026-10-16:2026-10-18/@scope%2Fpkg',
    );
    expect(lastDayPointUrl('@scope/pkg')).toBe(
      'https://api.npmjs.org/downloads/point/last-day/@scope%2Fpkg',
    );
  });

  it('keeps bulk requests unscoped and comma-separated', () => {
    expect(bulkRangeUrl('2026-10-16', '2026-10-18', ['react', 'vue'])).toBe(
      'https://api.npmjs.org/downloads/range/2026-10-16:2026-10-18/react,vue',
    );
  });

  it('chunks bulk names at 128 with a remainder', () => {
    const names = Array.from({ length: NPM_BULK_MAX + 3 }, (_, index) => `pkg-${String(index)}`);
    const chunks = chunkNpmNames(names);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(NPM_BULK_MAX);
    expect(chunks[1]).toHaveLength(3);
    expect(chunks[1]?.[0]).toBe(`pkg-${String(NPM_BULK_MAX)}`);
    expect(chunkNpmNames([])).toEqual([]);
  });
});

describe('npm keywords (spec §7.3.2)', () => {
  it('rotates the keyword start deterministically per six-hour slot', () => {
    const start = new Date('2026-10-20T00:00:00Z');
    const slotMs = 6 * 3_600_000;
    const at = (offset: number): readonly string[] =>
      rotatedNpmKeywords(new Date(start.getTime() + offset));

    const first = at(0);
    expect(first).toHaveLength(NPM_KEYWORDS.length);
    expect(new Set(first).size).toBe(NPM_KEYWORDS.length);
    const slot = Math.floor(start.getTime() / slotMs) % NPM_KEYWORDS.length;
    expect(first[0]).toBe(NPM_KEYWORDS[slot]);
    expect(at(slotMs - 1)).toEqual(first);
    expect(at(slotMs)[0]).toBe(NPM_KEYWORDS[(slot + 1) % NPM_KEYWORDS.length]);
  });
});

describe('npm repository → GitHub alias (spec §7.3.2)', () => {
  it('parses every URL form npm publishes', () => {
    const expected = 'jonschlinkert/is-number';
    for (const raw of [
      'git+https://github.com/jonschlinkert/is-number.git',
      'https://github.com/jonschlinkert/is-number',
      'git://github.com/jonschlinkert/is-number.git',
      'git+ssh://git@github.com/jonschlinkert/is-number.git',
      'ssh://git@github.com/jonschlinkert/is-number.git',
      'git@github.com:jonschlinkert/is-number.git',
      'github:jonschlinkert/is-number',
      'https://www.github.com/jonschlinkert/is-number/tree/main',
    ]) {
      expect(parseGitHubRepositoryUrl(raw), raw).toBe(expected);
    }
    expect(normalizeNpmPackage('@scope/pkg')).toBe('@scope/pkg');
  });

  it('ignores non-GitHub hosts and malformed values', () => {
    expect(parseGitHubRepositoryUrl('https://gitlab.com/o/r')).toBeNull();
    expect(parseGitHubRepositoryUrl('https://bitbucket.org/o/r')).toBeNull();
    expect(parseGitHubRepositoryUrl('not a url')).toBeNull();
    expect(parseGitHubRepositoryUrl('')).toBeNull();
    expect(parseGitHubRepositoryUrl(null)).toBeNull();
    expect(parseGitHubRepositoryUrl(undefined)).toBeNull();
  });

  it('normalizes mixed-case owners and repositories', () => {
    expect(parseGitHubRepositoryUrl('https://github.com/Vercel/AI')).toBe('vercel/ai');
  });
});
