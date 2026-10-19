import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  LEADERBOARD_EVENTS_CHANNEL,
  LeaderboardCardSchema,
  redisKeys,
  type LeaderboardUpdatedEvent,
} from '@trendr/core';
import { createDb, type Connection } from '@trendr/db';

import { buildApp } from '../../src/app.js';

/**
 * Task 3.6 acceptance (spec §10.5, §10.6) over real Postgres + Redis: a client
 * gets `leaderboard.snapshot` then `leaderboard.update` after a PUBLISH; the
 * 6th concurrent stream from the same IP is rejected with 429 and the counter
 * decrements once streams close.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const REDIS_URL = process.env.REDIS_URL ?? '';
const DEPS = { corsOrigins: ['http://localhost:3000'], metricsToken: 'int-metrics-token' };

const SCOPE = 'github' as const;
const WINDOW = '24h' as const;
const RUN_ID = '81234';
const STREAM_PATH = '/v1/stream/leaderboard?scope=github&window=24h';

let connection: Connection;
let redis: Redis;

beforeAll(async () => {
  connection = createDb(DATABASE_URL, { max: 2 });
  redis = new Redis(REDIS_URL);
  await cleanup();
  await seedBoard();
});

afterAll(async () => {
  await cleanup();
  await connection.pool.end();
  redis.disconnect();
});

async function cleanup(): Promise<void> {
  await redis.del(
    redisKeys.leaderboardMeta(SCOPE, WINDOW),
    redisKeys.leaderboard(SCOPE, WINDOW),
    redisKeys.card('901', WINDOW),
    redisKeys.card('902', WINDOW),
  );
  const counters = await redis.keys('apirl:sse:*');
  if (counters.length > 0) {
    await redis.del(...counters);
  }
}

/** `lbmeta` + board ZSET + cards, exactly what the snapshot path reads. */
async function seedBoard(): Promise<void> {
  await redis.hset(redisKeys.leaderboardMeta(SCOPE, WINDOW), {
    runId: RUN_ID,
    computedAt: new Date().toISOString(),
    count: '3',
    version: '1',
  });
  await redis.zadd(redisKeys.leaderboard(SCOPE, WINDOW), 7.49, '901', 5.1, '902', 3.2, '903');
  await redis.set(redisKeys.card('901', WINDOW), cardPayload('901', 900));
  await redis.set(redisKeys.card('902', WINDOW), cardPayload('902', 412));
}

function cardPayload(itemId: string, delta: number): string {
  return JSON.stringify(
    LeaderboardCardSchema.parse({
      item: {
        id: itemId,
        source: SCOPE,
        kind: 'repo',
        externalId: `ext-${itemId}`,
        displayName: `repo-${itemId}`,
        description: null,
        url: `https://example.test/${itemId}`,
        language: 'TypeScript',
        topics: [],
        primaryMetric: 'stars',
      },
      window: WINDOW,
      delta,
      relGrowth: 0.12,
      score: 7.49,
      percentile: 99,
      current: 1000,
      sparkline: [1, 2, 3],
      flags: [],
    }),
  );
}

function updatePayload(runId: string): LeaderboardUpdatedEvent {
  return {
    type: 'leaderboard.updated',
    scope: SCOPE,
    window: WINDOW,
    runId,
    computedAt: new Date().toISOString(),
    movers: [{ itemId: '902', rank: 1, prevRank: 3, delta: 412 }],
    entered: ['456'],
    exited: ['789'],
  };
}

interface OpenStream {
  response: Response;
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array>;
}

async function connect(baseUrl: string, headers: Record<string, string> = {}): Promise<OpenStream> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}${STREAM_PATH}`, { headers, signal: controller.signal });
  const body = response.body;
  if (body === null) {
    throw new Error('sse response had no body');
  }
  return { response, controller, reader: body.getReader() };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs = 5_000,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (!predicate(text)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`sse condition not met within ${timeoutMs}ms; received: ${text}`);
    }
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`sse read timed out; received: ${text}`));
        }, remaining);
      }),
    ]).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
    if (result.done) {
      throw new Error(`sse stream ended before the condition; received: ${text}`);
    }
    text += decoder.decode(result.value, { stream: true });
  }
  return text;
}

/** Read a finite (non-SSE) body through the stream reader opened by `connect`. */
async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      return text;
    }
    text += decoder.decode(result.value, { stream: true });
  }
}

async function waitForNoStreams(timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const counters = await redis.keys('apirl:sse:*');
    if (counters.length === 0) {
      return;
    }
    if (Date.now() > deadline) {
      const values = await Promise.all(
        counters.map(async (key) => `${key}=${await redis.get(key)}`),
      );
      throw new Error(`sse counters did not drain: ${values.join(', ')}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

/**
 * Publish until the client receives a `leaderboard.update` frame. The
 * subscription and the per-board registration happen asynchronously around
 * connection setup, so a single publish can legitimately race them; repeating
 * the publish keeps the assertion deterministic while still requiring the route
 * to deliver published updates to an open stream.
 */
async function publishUntilUpdate(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  payload: LeaderboardUpdatedEvent,
  timeoutMs = 15_000,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  let nextPublishAt = 0;
  while (!text.includes('event: leaderboard.update')) {
    const now = Date.now();
    if (now > deadline) {
      throw new Error(`update not received within ${timeoutMs}ms; received: ${text}`);
    }
    if (now >= nextPublishAt) {
      await redis.publish(LEADERBOARD_EVENTS_CHANNEL, JSON.stringify(payload));
      nextPublishAt = now + 500;
    }
    let timer: NodeJS.Timeout | undefined;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          resolve('timeout');
        }, 250);
      }),
    ]).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
    if (chunk !== 'timeout') {
      if (chunk.done) {
        throw new Error(`sse stream ended before an update; received: ${text}`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  }
  return text;
}

/**
 * Real HTTP server on an ephemeral port (SSE cannot be exercised with
 * `app.inject`) plus best-effort teardown: every opened stream is aborted
 * before `app.close()` so a failing assertion cannot leave the server waiting
 * on a live stream.
 */
async function withListeningApp(
  run: (open: (headers?: Record<string, string>) => Promise<OpenStream>) => Promise<void>,
): Promise<void> {
  const app: FastifyInstance = await buildApp({
    ...DEPS,
    db: connection,
    redis,
    rateLimit: false,
  });
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const streams: OpenStream[] = [];
  const open = async (headers: Record<string, string> = {}): Promise<OpenStream> => {
    const stream = await connect(baseUrl, headers);
    streams.push(stream);
    return stream;
  };
  try {
    await run(open);
  } finally {
    for (const stream of streams) {
      stream.controller.abort();
    }
    await waitForNoStreams(1_000).catch(() => undefined);
    await app.close();
  }
}

describe('SSE leaderboard stream (task 3.6)', () => {
  it('streams the snapshot first and then the published update', async () => {
    await withListeningApp(async (open) => {
      const stream = await open();
      expect(stream.response.status).toBe(200);
      expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
      expect(stream.response.headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(stream.response.headers.get('x-accel-buffering')).toBe('no');

      const afterConnect = await readUntil(stream.reader, (text) =>
        text.includes('event: leaderboard.snapshot'),
      );
      expect(afterConnect).toContain('retry: 5000');
      expect(afterConnect).toContain('id: 81234');
      expect(afterConnect).toContain('"runId":"81234"');
      expect(afterConnect).toContain('"rank":1');
      expect(afterConnect).toContain('"itemId":"901"');
      expect(afterConnect).toContain('"score":7.49');
      expect(afterConnect).toContain('"delta":900');

      const afterUpdate = await publishUntilUpdate(stream.reader, updatePayload('81240'));
      expect(afterUpdate).toContain('id: 81240');
      expect(afterUpdate).toContain(
        '"movers":[{"itemId":"902","rank":1,"prevRank":3,"delta":412}]',
      );
      expect(afterUpdate).toContain('"entered":["456"]');
      expect(afterUpdate).not.toContain('"type":"leaderboard.updated"');

      stream.controller.abort();
      await waitForNoStreams();
    });
  });

  it('skips a current snapshot and rejects the 6th concurrent stream with 429', async () => {
    await withListeningApp(async (open) => {
      const first = await open({ 'last-event-id': RUN_ID });
      expect(first.response.status).toBe(200);
      const text = await publishUntilUpdate(first.reader, updatePayload('81241'));
      expect(text).not.toContain('leaderboard.snapshot');

      const extra: OpenStream[] = [];
      for (let index = 0; index < 4; index += 1) {
        const stream = await open();
        expect(stream.response.status).toBe(200);
        extra.push(stream);
      }

      const sixth = await open();
      expect(sixth.response.status).toBe(429);
      expect(sixth.response.headers.get('content-type')).toContain('application/problem+json');
      const problem = JSON.parse(await readAll(sixth.reader)) as { type: string; status: number };
      expect(problem.status).toBe(429);
      expect(problem.type).toBe('https://trendr.dev/problems/rate-limited');
      sixth.controller.abort();

      for (const stream of [...extra, first]) {
        stream.controller.abort();
      }
      await waitForNoStreams();

      // The counter decremented on close, so a fresh stream is accepted again.
      const after = await open();
      expect(after.response.status).toBe(200);
      after.controller.abort();
      await waitForNoStreams();
    });
  });
});
