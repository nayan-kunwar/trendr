import { describe, expect, it } from 'vitest';

import { StatsResponse } from './stats.js';

/** Spec §10.1 — `/v1/stats`: zero-filled per-source counts and last successes. */

const ALL_SOURCES = {
  github: 10,
  npm: 4,
  pypi: 3,
  huggingface: 2,
  arxiv: 1,
  mcp: 0,
};

describe('StatsResponse (spec §10.1)', () => {
  it('accepts every source key and nullable-source runs', () => {
    const parsed = StatsResponse.parse({
      items: ALL_SOURCES,
      runs: [
        {
          source: 'github',
          jobType: 'discover',
          runId: '812',
          lastSuccessAt: '2026-06-01T10:00:00.000Z',
        },
        {
          source: null,
          jobType: 'maintenance',
          runId: '900',
          lastSuccessAt: '2026-06-01T09:00:00.000Z',
        },
      ],
    });
    expect(parsed.runs[1]?.source).toBeNull();
  });

  it('requires all six source keys (zero-filled contract)', () => {
    const partial = { github: 10, npm: 4, pypi: 3, huggingface: 2, arxiv: 1 };
    expect(StatsResponse.safeParse({ items: partial, runs: [] }).success).toBe(false);
  });

  it('rejects unknown job types and non-ISO timestamps', () => {
    expect(
      StatsResponse.safeParse({
        items: ALL_SOURCES,
        runs: [
          { source: null, jobType: 'crawl', runId: '1', lastSuccessAt: '2026-06-01T10:00:00.000Z' },
        ],
      }).success,
    ).toBe(false);
    expect(
      StatsResponse.safeParse({
        items: ALL_SOURCES,
        runs: [{ source: null, jobType: 'digest', runId: '1', lastSuccessAt: 'yesterday' }],
      }).success,
    ).toBe(false);
  });
});
