import { describe, expect, it } from 'vitest';

import {
  HistoryQuery,
  ItemDetailResponse,
  LookupQuery,
  ScoreExplainQuery,
  ScoreExplainResponse,
  ScoresQuery,
} from './items.js';

/** Spec §10.4 — the item-endpoint query validations and DTO shapes. */

const DAY_MS = 86_400_000;
const daysAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

function detailBody(): unknown {
  return {
    id: '1',
    source: 'github',
    kind: 'repo',
    externalId: 'acme/widget',
    name: 'widget',
    displayName: 'acme/widget',
    description: null,
    url: 'https://example.test/acme/widget',
    homepage: null,
    language: 'TypeScript',
    license: null,
    owner: 'acme',
    topics: ['ai'],
    primaryMetric: 'stars',
    latestMetrics: { stars: 120 },
    tier: 'cold',
    flags: [],
    upstreamCreatedAt: null,
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSnapshotAt: null,
    scores: { '24h': null, '7d': null, '30d': null },
    aliases: [],
    metadata: {},
  };
}

describe('HistoryQuery (spec §10.4)', () => {
  it('defaults granularity to day and leaves from/to optional', () => {
    const query = HistoryQuery.parse({});
    expect(query.granularity).toBe('day');
    expect(query.from).toBeUndefined();
  });

  it('allows hour granularity up to 14 days back', () => {
    expect(HistoryQuery.parse({ granularity: 'hour', from: daysAgo(10) }).granularity).toBe('hour');
    expect(HistoryQuery.parse({ granularity: 'hour', from: daysAgo(13) }).granularity).toBe('hour');
    // Without an explicit `from` the §10.4 refine does not run.
    expect(HistoryQuery.parse({ granularity: 'hour' }).granularity).toBe('hour');
  });

  it('rejects hour granularity beyond 14 days', () => {
    expect(() => HistoryQuery.parse({ granularity: 'hour', from: daysAgo(15) })).toThrow(
      /hour granularity limited to 14 days/,
    );
  });

  it('rejects an unknown metric', () => {
    expect(() => HistoryQuery.parse({ metric: 'forks_per_minute' })).toThrow();
  });
});

describe('ScoresQuery (spec §10.4)', () => {
  it('applies the spec defaults', () => {
    expect(ScoresQuery.parse({})).toEqual({ window: '7d', granularity: 'day', days: 30 });
  });

  it('coerces days from the query string', () => {
    expect(ScoresQuery.parse({ days: '45' }).days).toBe(45);
  });

  it('allows hour granularity only within 48 hours', () => {
    expect(ScoresQuery.parse({ granularity: 'hour', days: '2' }).days).toBe(2);
    expect(() => ScoresQuery.parse({ granularity: 'hour', days: '3' })).toThrow(
      /hour granularity limited to the last 48 hours/,
    );
  });

  it('bounds days to 1..365 for day granularity', () => {
    expect(ScoresQuery.parse({ days: '365' }).days).toBe(365);
    expect(() => ScoresQuery.parse({ days: '0' })).toThrow();
    expect(() => ScoresQuery.parse({ days: '366' })).toThrow();
  });
});

describe('LookupQuery (spec §10.1)', () => {
  it('requires source and externalId', () => {
    expect(LookupQuery.parse({ source: 'npm', externalId: ' left-pad ' })).toEqual({
      source: 'npm',
      externalId: 'left-pad',
    });
    expect(() => LookupQuery.parse({ source: 'npm' })).toThrow();
    expect(() => LookupQuery.parse({ externalId: 'left-pad' })).toThrow();
    expect(() => LookupQuery.parse({ source: 'bitbucket', externalId: 'x' })).toThrow();
  });
});

describe('ScoreExplainQuery (spec §10.1)', () => {
  it('defaults the window to 24h', () => {
    expect(ScoreExplainQuery.parse({}).window).toBe('24h');
    expect(ScoreExplainQuery.parse({ window: '30d' }).window).toBe('30d');
  });
});

describe('item DTOs (spec §10.4)', () => {
  it('parses an item detail with a partial latestMetrics and all windows present', () => {
    const parsed = ItemDetailResponse.parse(detailBody());
    expect(parsed.latestMetrics).toEqual({ stars: 120 });
    expect(parsed.scores['24h']).toBeNull();
  });

  it("parses the not_eligible explain shape: null components with reason 'not_eligible'", () => {
    const parsed = ScoreExplainResponse.parse({
      itemId: '1',
      source: 'github',
      window: '24h',
      runId: null,
      computedAt: null,
      components: null,
      params: null,
      inputs: null,
      reason: 'not_eligible',
    });
    expect(parsed.components).toBeNull();
    expect(parsed.reason).toBe('not_eligible');
  });
});
