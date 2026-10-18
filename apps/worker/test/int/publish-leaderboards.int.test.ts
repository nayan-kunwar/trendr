import { and, eq, like, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  LEADERBOARD_EVENTS_CHANNEL,
  LB_MAX_SIZE,
  LeaderboardCardSchema,
  LeaderboardUpdatedEventSchema,
  redisKeys,
  type LeaderboardUpdatedEvent,
  type Source,
} from '@trendr/core';
import {
  createDb,
  insertScores,
  items,
  scores,
  startRun,
  swapCurrentRun,
  upsertDailyMetrics,
  upsertItems,
  upsertSnapshots,
  type Connection,
  type DailyMetricUpsert,
  type Db,
  type ItemUpsert,
  type ScoreUpsert,
  type SnapshotUpsert,
} from '@trendr/db';

import { publishBoard, publishLeaderboards } from '../../src/scoring/publish-leaderboards.js';

/**
 * Task 2.5 acceptance (spec §18): tmp ZSET + RENAME swap, cards, lbmeta and
 * the `events:leaderboard` diff. The reader-loop test proves a concurrent
 * reader only ever sees the complete old board or the complete new one, and
 * every received event is validated with its Zod schema (§9.2).
 */

const T = new Date('2026-10-18T12:00:00Z');
const DAY = 86_400_000;
const PREFIX = 'lb-int';
const CARD_TTL = 6 * 3600;

/** Boards this file publishes to and asserts on; reset before and after. */
function boardKeys(): string[] {
  return [
    redisKeys.leaderboard('github', '7d'),
    redisKeys.leaderboardMeta('github', '7d'),
    redisKeys.leaderboard('all', '7d'),
    redisKeys.leaderboardMeta('all', '7d'),
    redisKeys.leaderboard('pypi', '24h'),
    redisKeys.leaderboardMeta('pypi', '24h'),
    redisKeys.leaderboard('github', '24h'),
    redisKeys.leaderboardMeta('github', '24h'),
    redisKeys.leaderboard('npm', '30d'),
    redisKeys.leaderboardMeta('npm', '30d'),
    redisKeys.leaderboard('npm', '24h'),
    redisKeys.leaderboardMeta('npm', '24h'),
  ];
}

let connection: Connection;
let db: Db;
let redis: Redis;
let redisUrl = '';

const ids = new Map<string, bigint>();

function idOf(key: string): bigint {
  const id = ids.get(key);
  if (id === undefined) throw new Error(`missing fixture ${key}`);
  return id;
}

/** Start of the fixture's UTC day, `offsetDays` before the anchor day. */
function utcDay(offsetDays: number): Date {
  return new Date(Date.UTC(2026, 9, 18) - offsetDays * DAY);
}

function utcDayString(offsetDays: number): string {
  return utcDay(offsetDays).toISOString().slice(0, 10);
}

function itemFixture(externalId: string, overrides: Partial<ItemUpsert> = {}): ItemUpsert {
  return {
    source: 'github',
    kind: 'repo',
    externalId,
    upstreamId: null,
    name: externalId,
    displayName: externalId,
    description: `${externalId} description`,
    url: `https://example.test/lb/${externalId}`,
    homepage: null,
    language: 'TypeScript',
    license: null,
    owner: PREFIX,
    primaryMetric: 'stars',
    upstreamCreatedAt: new Date(T.getTime() - 300 * DAY),
    isArchived: false,
    metadata: {},
    ...overrides,
  };
}

function snap(externalId: string, capturedAt: Date, value: number): SnapshotUpsert {
  return {
    itemId: idOf(externalId),
    metric: 'stars',
    capturedAt,
    observedAt: capturedAt,
    value,
  };
}

function daily(externalId: string, day: string, value: number): DailyMetricUpsert {
  return { itemId: idOf(externalId), metric: 'downloads', day, value };
}

function scoreRow(
  externalId: string,
  source: Source,
  runId: bigint,
  overrides: Partial<ScoreUpsert>,
): ScoreUpsert {
  return {
    itemId: idOf(externalId),
    window: '7d',
    runId,
    source,
    computedAt: T,
    delta: 0,
    base: 0,
    relGrowth: 0,
    rawScore: 0,
    ageFactor: 1,
    confidence: 1,
    anomalyPenalty: 1,
    finalScore: 0,
    zScore: 0,
    percentile: 0,
    rankSource: 1,
    rankAll: null,
    flags: [],
    ...overrides,
  };
}

let githubRun = 0n;
let npmRun = 0n;

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  redisUrl = process.env.REDIS_URL ?? '';
  if (!databaseUrl || redisUrl === '') {
    throw new Error('DATABASE_URL/REDIS_URL are missing — run through `pnpm test:int`');
  }
  connection = createDb(databaseUrl);
  db = connection.db;
  redis = new Redis(redisUrl);

  // The all-board read joins every source's current run; clear them so the
  // fixture board is deterministic even when the seed-scoring file ran first.
  await db.execute(sql`DELETE FROM score_runs_current`);

  const upserted = await upsertItems(db, [
    itemFixture(`${PREFIX}-a`),
    itemFixture(`${PREFIX}-b`),
    itemFixture(`${PREFIX}-c`),
    itemFixture(`${PREFIX}-d`, {
      source: 'npm',
      kind: 'package',
      primaryMetric: 'downloads',
      language: null,
    }),
  ]);
  for (const row of upserted) ids.set(row.externalId, row.id);

  // A: 40 daily points (100..295) plus the 11:00 hourly tail (300) — the
  // sparkline keeps the last 30 days, `current` is the freshest value.
  const aSnapshots: SnapshotUpsert[] = [];
  for (let offset = 39; offset >= 0; offset -= 1) {
    aSnapshots.push(snap(`${PREFIX}-a`, utcDay(offset), 100 + (39 - offset) * 5));
  }
  aSnapshots.push(snap(`${PREFIX}-a`, new Date(T.getTime() - 3_600_000), 300));
  await upsertSnapshots(db, [
    ...aSnapshots,
    snap(`${PREFIX}-b`, utcDay(2), 40),
    snap(`${PREFIX}-b`, utcDay(1), 50),
    snap(`${PREFIX}-b`, utcDay(0), 60),
    snap(`${PREFIX}-c`, utcDay(0), 30),
  ]);

  // D: daily-count downloads; the incomplete anchor-day row must be ignored.
  const dDaily: DailyMetricUpsert[] = [];
  for (let offset = 39; offset >= 1; offset -= 1) {
    dDaily.push(daily(`${PREFIX}-d`, utcDayString(offset), 1000 + (39 - offset) * 10));
  }
  dDaily.push(daily(`${PREFIX}-d`, utcDayString(0), 9999));
  await upsertDailyMetrics(db, dDaily);

  githubRun = await startRun(db, {
    source: 'github',
    jobType: 'score',
    jobId: `${PREFIX}-github-run`,
  });
  npmRun = await startRun(db, { source: 'npm', jobType: 'score', jobId: `${PREFIX}-npm-run` });

  await insertScores(db, [
    scoreRow(`${PREFIX}-a`, 'github', githubRun, {
      finalScore: 9,
      zScore: 4.5,
      percentile: 99.5,
      delta: 210,
      relGrowth: 9,
      rankSource: 1,
      rankAll: 1,
      flags: ['new_item'],
    }),
    scoreRow(`${PREFIX}-b`, 'github', githubRun, {
      finalScore: 5,
      zScore: 2,
      percentile: 50,
      delta: 60,
      relGrowth: 1,
      rankSource: 3,
      rankAll: 3,
    }),
    scoreRow(`${PREFIX}-c`, 'github', githubRun, {
      finalScore: 6,
      zScore: 3,
      percentile: 75,
      delta: 90,
      relGrowth: 3,
      rankSource: 2,
      rankAll: 2,
    }),
    scoreRow(`${PREFIX}-d`, 'npm', npmRun, {
      finalScore: 4,
      zScore: 1,
      percentile: 10,
      delta: 500,
      relGrowth: 0.5,
      rankAll: 4,
    }),
  ]);
  await swapCurrentRun(db, { source: 'github', window: '7d', runId: githubRun, computedAt: T });
  await swapCurrentRun(db, { source: 'npm', window: '7d', runId: npmRun, computedAt: T });

  // Reset the keys this file asserts on (the seed-scoring file may have run
  // first); lbmeta versions restart from 1.
  await redis.del(
    ...boardKeys(),
    ...['a', 'b', 'c', 'd'].map((suffix) => redisKeys.card(idOf(`${PREFIX}-${suffix}`), '7d')),
  );
});

afterAll(async () => {
  await db.delete(items).where(like(items.externalId, `${PREFIX}-%`));
  await redis.del(...boardKeys());
  await redis.quit();
  await connection.pool.end();
});

/** Run `fn`, then return every event published on `events:leaderboard`. */
async function collectEvents(
  expected: number,
  fn: () => Promise<unknown>,
): Promise<LeaderboardUpdatedEvent[]> {
  const subscriber = new Redis(redisUrl);
  const messages: string[] = [];
  await subscriber.subscribe(LEADERBOARD_EVENTS_CHANNEL);
  subscriber.on('message', (_channel: string, message: string) => {
    messages.push(message);
  });
  try {
    await fn();
    const deadline = Date.now() + 2_000;
    while (messages.length < expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return messages.map((message) => LeaderboardUpdatedEventSchema.parse(JSON.parse(message)));
  } finally {
    await subscriber.unsubscribe(LEADERBOARD_EVENTS_CHANNEL);
    await subscriber.quit();
  }
}

async function zsetState(key: string): Promise<{ members: string[]; scores: string[] }> {
  const flat = await redis.zrevrange(key, 0, -1, 'WITHSCORES');
  const members: string[] = [];
  const scores: string[] = [];
  for (let index = 0; index < flat.length; index += 2) {
    const member = flat[index];
    const score = flat[index + 1];
    if (member === undefined || score === undefined) throw new Error('unexpected WITHSCORES shape');
    members.push(member);
    scores.push(score);
  }
  return { members, scores };
}

async function readCard(externalId: string) {
  const raw = await redis.get(redisKeys.card(idOf(externalId), '7d'));
  if (raw === null) throw new Error(`missing card for ${externalId}`);
  return LeaderboardCardSchema.parse(JSON.parse(raw));
}

function eventFor(
  events: LeaderboardUpdatedEvent[],
  scope: LeaderboardUpdatedEvent['scope'],
): LeaderboardUpdatedEvent {
  const event = events.find((candidate) => candidate.scope === scope);
  if (event === undefined) throw new Error(`no event for scope ${scope}`);
  return event;
}

describe('publishLeaderboards (§9.2, task 2.5)', () => {
  it('swaps source and combined boards atomically with meta, cards and diff events', async () => {
    const events = await collectEvents(2, () =>
      publishLeaderboards({ db, redis }, 'github', ['7d'], githubRun, { computedAt: T }),
    );

    const sourceBoard = await zsetState(redisKeys.leaderboard('github', '7d'));
    expect(sourceBoard.members).toEqual([
      String(idOf(`${PREFIX}-a`)),
      String(idOf(`${PREFIX}-c`)),
      String(idOf(`${PREFIX}-b`)),
    ]);
    expect(sourceBoard.scores).toEqual(['9', '6', '5']);

    const allBoard = await zsetState(redisKeys.leaderboard('all', '7d'));
    expect(allBoard.members).toEqual([
      String(idOf(`${PREFIX}-a`)),
      String(idOf(`${PREFIX}-c`)),
      String(idOf(`${PREFIX}-b`)),
      String(idOf(`${PREFIX}-d`)),
    ]);
    expect(allBoard.scores).toEqual(['4.5', '3', '2', '1']);

    expect(await redis.hgetall(redisKeys.leaderboardMeta('github', '7d'))).toEqual({
      runId: String(githubRun),
      computedAt: T.toISOString(),
      count: '3',
      version: '1',
    });
    expect(await redis.hgetall(redisKeys.leaderboardMeta('all', '7d'))).toEqual({
      runId: String(githubRun),
      computedAt: T.toISOString(),
      count: '4',
      version: '1',
    });

    // The temp key never survives the swap.
    expect(await redis.exists(`${redisKeys.leaderboard('github', '7d')}:tmp:${githubRun}`)).toBe(0);

    const event = eventFor(events, 'github');
    expect(event.type).toBe('leaderboard.updated');
    expect(event.window).toBe('7d');
    expect(event.runId).toBe(String(githubRun));
    expect(event.computedAt).toBe(T.toISOString());
    expect(event.movers).toEqual([]);
    expect(event.entered).toEqual([
      String(idOf(`${PREFIX}-a`)),
      String(idOf(`${PREFIX}-c`)),
      String(idOf(`${PREFIX}-b`)),
    ]);
    expect(event.exited).toEqual([]);
    const allEvent = eventFor(events, 'all');
    expect(allEvent.entered).toEqual([
      String(idOf(`${PREFIX}-a`)),
      String(idOf(`${PREFIX}-c`)),
      String(idOf(`${PREFIX}-b`)),
      String(idOf(`${PREFIX}-d`)),
    ]);
    expect(allEvent.exited).toEqual([]);

    // Cards: LeaderboardEntry minus rank, current + up-to-30 daily sparkline.
    const cardA = await readCard(`${PREFIX}-a`);
    expect(cardA.item.displayName).toBe(`${PREFIX}-a`);
    expect(cardA.item.primaryMetric).toBe('stars');
    expect(cardA.score).toBe(9);
    expect(cardA.percentile).toBe(99.5);
    expect(cardA.delta).toBe(210);
    expect(cardA.relGrowth).toBe(9);
    expect(cardA.flags).toEqual(['new_item']);
    expect(cardA.current).toBe(300);
    expect(cardA.sparkline).toHaveLength(30);
    expect(cardA.sparkline[0]).toBe(150);
    expect(cardA.sparkline.at(-1)).toBe(300);
    expect(await redis.ttl(redisKeys.card(idOf(`${PREFIX}-a`), '7d'))).toBeLessThanOrEqual(
      CARD_TTL,
    );

    const cardB = await readCard(`${PREFIX}-b`);
    expect(cardB.sparkline).toEqual([40, 50, 60]);
    expect(cardB.current).toBe(60);

    // Downloads ride the daily_metrics path and stop at the last complete day.
    const cardD = await readCard(`${PREFIX}-d`);
    expect(cardD.item.primaryMetric).toBe('downloads');
    expect(cardD.score).toBe(4);
    expect(cardD.sparkline).toHaveLength(30);
    expect(cardD.sparkline[0]).toBe(1090);
    expect(cardD.current).toBe(1380);
  });

  it('reports movers, entered and exited in the second diff', async () => {
    await db
      .update(scores)
      .set({ finalScore: 10, zScore: 5 })
      .where(
        and(
          eq(scores.itemId, idOf(`${PREFIX}-b`)),
          eq(scores.window, '7d'),
          eq(scores.runId, githubRun),
        ),
      );

    const newItem = await upsertItems(db, [itemFixture(`${PREFIX}-e`)]);
    const newItemId = newItem[0]?.id;
    if (newItemId === undefined) throw new Error('fixture insert returned no row');
    ids.set(`${PREFIX}-e`, newItemId);
    await insertScores(db, [
      scoreRow(`${PREFIX}-e`, 'github', githubRun, {
        finalScore: 12,
        zScore: 6.5,
        percentile: 100,
        delta: 400,
        relGrowth: 4,
        rankSource: 1,
        rankAll: 5,
        flags: ['new_item'],
      }),
    ]);

    const events = await collectEvents(2, () =>
      publishLeaderboards({ db, redis }, 'github', ['7d'], githubRun, { computedAt: T }),
    );

    // New source order: E(12), B(10), A(9), C(6); prev ranks A1, C2, B3.
    const event = eventFor(events, 'github');
    expect(event.movers).toEqual([
      { itemId: String(idOf(`${PREFIX}-a`)), rank: 3, prevRank: 1, delta: 210 },
      { itemId: String(idOf(`${PREFIX}-c`)), rank: 4, prevRank: 2, delta: 90 },
      { itemId: String(idOf(`${PREFIX}-b`)), rank: 2, prevRank: 3, delta: 60 },
    ]);
    expect(event.entered).toEqual([String(idOf(`${PREFIX}-e`))]);
    expect(event.exited).toEqual([]);

    const allEvent = eventFor(events, 'all');
    expect(allEvent.movers).toEqual([]);
    expect(allEvent.entered).toEqual([String(idOf(`${PREFIX}-e`))]);
    expect(allEvent.exited).toEqual([]);

    expect(await redis.hget(redisKeys.leaderboardMeta('github', '7d'), 'version')).toBe('2');
    expect(await redis.hget(redisKeys.leaderboardMeta('github', '7d'), 'count')).toBe('4');

    // E has no series rows yet, so no card is minted (cards hydrate on read).
    expect(await redis.exists(redisKeys.card(idOf(`${PREFIX}-e`), '7d'))).toBe(0);
  });

  it('deletes the live key for an empty board and still bumps the version', async () => {
    const live = redisKeys.leaderboard('pypi', '24h');
    await publishBoard(redis, 'pypi', '24h', '_all', [{ itemId: 701n, score: 5 }], 700n);
    expect(await redis.zcard(live)).toBe(1);

    const event = await publishBoard(redis, 'pypi', '24h', '_all', [], 701n);
    expect(await redis.exists(live)).toBe(0);
    expect(await redis.hgetall(redisKeys.leaderboardMeta('pypi', '24h'))).toEqual({
      runId: '701',
      computedAt: event.computedAt,
      count: '0',
      version: '2',
    });
    expect(event.exited).toEqual(['701']);
    expect(event.entered).toEqual([]);
    expect(event.movers).toEqual([]);
  });

  it('never exposes a partial board to a concurrent reader', async () => {
    const live = redisKeys.leaderboard('github', '24h');
    const oldRows = [
      { itemId: 9001n, score: 30 },
      { itemId: 9002n, score: 20 },
      { itemId: 9003n, score: 10 },
    ];
    await publishBoard(redis, 'github', '24h', '_all', oldRows, 601n);

    const oldState = JSON.stringify(['9001', '9002', '9003']);
    const bigRows = Array.from({ length: LB_MAX_SIZE + 200 }, (_, index) => ({
      itemId: BigInt(10_000 + index),
      score: 1_200 - index,
    }));
    const newState = JSON.stringify(bigRows.slice(0, LB_MAX_SIZE).map((row) => String(row.itemId)));

    const observations: string[] = [];
    const control = { reading: true };
    const reader = (async () => {
      while (control.reading) {
        const members = await redis.zrevrange(live, 0, -1);
        observations.push(JSON.stringify(members));
      }
    })();

    await publishBoard(redis, 'github', '24h', '_all', bigRows, 602n);
    control.reading = false;
    await reader;
    const finalState = JSON.stringify(await redis.zrevrange(live, 0, -1));

    expect(observations.length).toBeGreaterThan(0);
    expect(observations[0]).toBe(oldState);
    expect(observations.every((state) => state === oldState || state === newState)).toBe(true);
    expect(finalState).toBe(newState);
    expect(await redis.zcard(live)).toBe(LB_MAX_SIZE);
    expect(await redis.exists(`${live}:tmp:602`)).toBe(0);
  });

  it('marks entered and exited members from the top-100 membership change', async () => {
    const first = await publishBoard(
      redis,
      'npm',
      '30d',
      '_all',
      [
        { itemId: 3n, score: 30 },
        { itemId: 1n, score: 20 },
        { itemId: 2n, score: 10 },
      ],
      801n,
    );
    expect(first.entered).toEqual(['3', '1', '2']);
    expect(first.exited).toEqual([]);

    const second = await publishBoard(
      redis,
      'npm',
      '30d',
      '_all',
      [
        { itemId: 4n, score: 40 },
        { itemId: 3n, score: 30 },
        { itemId: 1n, score: 20 },
      ],
      802n,
    );
    expect(second.movers).toEqual([
      { itemId: '3', rank: 2, prevRank: 1, delta: 0 },
      { itemId: '1', rank: 3, prevRank: 2, delta: 0 },
    ]);
    expect(second.entered).toEqual(['4']);
    expect(second.exited).toEqual(['2']);
  });

  it('treats a jump from below the old top 100 as entered and caps movers at 20', async () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      itemId: BigInt(20_000 + index),
      score: 1_000 - index,
    }));
    await publishBoard(redis, 'npm', '24h', '_all', many, 901n);

    const second = await publishBoard(
      redis,
      'npm',
      '24h',
      '_all',
      [{ itemId: 20_119n, score: 1_500 }, ...many.slice(0, 99)],
      902n,
    );

    // 20,119 sat at old rank 120: it entered the top 100 but has no rank change
    // within it, so it is not a mover; 20,099 fell out of the top 100.
    expect(second.entered).toEqual(['20119']);
    expect(second.exited).toEqual(['20099']);
    expect(second.movers).toHaveLength(20);
    expect(second.movers[0]).toEqual({ itemId: '20000', rank: 2, prevRank: 1, delta: 0 });
    expect(second.movers.some((mover) => mover.itemId === '20119')).toBe(false);
  });
});
