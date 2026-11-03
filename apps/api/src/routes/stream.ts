import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import {
  LeaderboardCardSchema,
  RateLimitedError,
  UnavailableError,
  redisKeys,
  type LeaderboardScope,
  type Window,
} from '@trendr/core';

import { CACHE_CONTROL } from '../plugins/etag.js';
import { rateLimitKey } from '../plugins/rate-limit.js';
import { StreamQuery } from '../schemas/stream.js';
import { LeaderboardBroadcaster, type LeaderboardSseClient } from '../sse/broadcaster.js';

/** Spec §10.6 — snapshot depth. */
export const SSE_TOP_SIZE = 25;
/** Spec §10.6 — heartbeat comment interval. */
export const SSE_HEARTBEAT_MS = 25_000;
/** Spec §10.6 — drop a client whose socket stays blocked this long. */
export const SSE_DRAIN_TIMEOUT_MS = 10_000;
/** Spec §10.5 — `sse` tier: concurrent streams per IP/key. */
export const SSE_MAX_CONNECTIONS = 5;
/**
 * M-5: the per-client counter is a lease, not a permanent record. The heartbeat
 * refreshes it every 25 s, so a crashed process releases its slots about 90 s
 * later instead of locking the user out for a day.
 */
export const SSE_COUNTER_LEASE_SECONDS = 90;

export interface SnapshotEntry {
  rank: number;
  itemId: string;
  score: number;
  delta: number;
}

/**
 * Spec §10.6 — `id`/`event: leaderboard.snapshot` frame. Returns null when the
 * client's `Last-Event-ID` already equals the current `runId` (nothing new).
 */
export function snapshotFrame(
  scope: LeaderboardScope,
  window: Window,
  runId: string,
  top: SnapshotEntry[],
  lastEventId: string | undefined,
): string | null {
  if (lastEventId === runId) {
    return null;
  }
  return `id: ${runId}\nevent: leaderboard.snapshot\ndata: ${JSON.stringify({ scope, window, runId, top })}\n\n`;
}

/** Spec §10.6 — `: ping` comment every 25 s; returns the stop function. */
export function startHeartbeat(
  send: () => void,
  intervalMs: number = SSE_HEARTBEAT_MS,
): () => void {
  const timer = setInterval(send, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}

/** `card:{itemId}:{window}` is display-only; a missing or invalid card means delta 0. */
function cardDelta(payload: string | null): number {
  if (payload === null) {
    return 0;
  }
  try {
    const parsed = LeaderboardCardSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data.delta : 0;
  } catch {
    return 0;
  }
}

export interface StreamRouteOptions {
  /** Env TRUST_PROXY: identity for the `sse` counter is key id ‖ user id ‖ IP (§10.5). */
  trustProxy?: boolean;
  /** Env TRUST_CF_CONNECTING_IP: only a trusted proxy writes that header (M-12). */
  trustCfConnectingIp?: boolean;
}

/**
 * Spec §10.6 — `GET /v1/stream/leaderboard`: `text/event-stream` with
 * `retry: 5000`, an initial top-25 snapshot (skipped when `Last-Event-ID`
 * matches the board runId), `events:leaderboard` fan-out, 25 s heartbeats and
 * a §10.5 concurrency cap of 5 streams per IP/key. The route is always
 * registered (it belongs in the OpenAPI document); without Redis it answers
 * 503 `unavailable`. On shutdown every stream ends with `event: shutdown`.
 */
export function registerStreamRoutes(app: FastifyInstance, options: StreamRouteOptions = {}): void {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const trustProxy = options.trustProxy ?? false;
  const trustCfConnectingIp = options.trustCfConnectingIp ?? false;
  const hasRedis = app.hasDecorator('redis');
  const broadcaster = app.hasDecorator('redisSub')
    ? new LeaderboardBroadcaster({
        subscriber: app.redisSub,
        onInvalidEvent: (raw) => {
          app.log.warn({ raw }, 'ignoring invalid leaderboard event');
        },
      })
    : null;

  if (broadcaster !== null) {
    broadcaster.subscribe().catch((error: unknown) => {
      app.log.warn({ err: error }, 'leaderboard broadcaster subscribe failed');
    });
    app.addHook('onClose', async () => {
      broadcaster.shutdown();
      await broadcaster.close();
    });
  }

  server.get(
    '/v1/stream/leaderboard',
    { schema: { querystring: StreamQuery } },
    async (request, reply) => {
      if (broadcaster === null || !hasRedis) {
        throw new UnavailableError('leaderboard stream requires Redis');
      }

      const { scope, window } = request.query;

      // Spec §10.5 — `apirl:sse:{keyId|ip}` INCR/DECR; 6th concurrent stream is 429.
      const counterKey = redisKeys.sseConnections(
        rateLimitKey(request, trustProxy, trustCfConnectingIp),
      );
      let counted = false;
      try {
        const count = await app.redis.incr(counterKey);
        if (count > SSE_MAX_CONNECTIONS) {
          await app.redis.decr(counterKey).catch(() => undefined);
          throw new RateLimitedError(
            `at most ${SSE_MAX_CONNECTIONS} concurrent leaderboard streams per client`,
          );
        }
        counted = true;
        await app.redis.expire(counterKey, SSE_COUNTER_LEASE_SECONDS).catch(() => undefined);
      } catch (error) {
        if (error instanceof RateLimitedError) {
          throw error;
        }
        app.log.warn({ err: error }, 'sse concurrency counter unavailable; failing open');
      }

      // `reply.hijack()` bypasses Fastify's normal header serialization, so
      // copy headers set by onRequest plugins (notably @fastify/cors) before
      // switching to the raw response.
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) {
          headers[name] = Array.isArray(value) ? value : String(value);
        }
      }
      Object.assign(headers, {
        'content-type': 'text/event-stream',
        'cache-control': CACHE_CONTROL.sse,
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, headers);

      let finalized = false;
      let ready = false;
      const pending: string[] = [];
      let drainTimer: NodeJS.Timeout | undefined;
      let stopHeartbeat: () => void = () => {
        /* set once the snapshot has been flushed */
      };

      const finalize = (): void => {
        if (finalized) {
          return;
        }
        finalized = true;
        stopHeartbeat();
        if (drainTimer !== undefined) {
          clearTimeout(drainTimer);
          drainTimer = undefined;
        }
        broadcaster.remove(client);
        if (app.hasDecorator('sseClients')) {
          app.sseClients.set({ scope, window }, broadcaster.size(scope, window));
        }
        if (counted) {
          app.redis
            .decr(counterKey)
            .then(async (value) => {
              if (value <= 0) {
                await app.redis.del(counterKey);
              }
            })
            .catch((error: unknown) => {
              app.log.warn({ err: error }, 'sse counter decrement failed');
            });
        }
      };

      const writeFrame = (frame: string): void => {
        if (finalized) {
          return;
        }
        if (!raw.write(frame) && drainTimer === undefined) {
          drainTimer = setTimeout(() => {
            app.log.warn({ scope, window }, 'dropping stalled sse client');
            raw.destroy();
          }, SSE_DRAIN_TIMEOUT_MS);
        }
      };

      const client: LeaderboardSseClient = {
        scope,
        window,
        send: (frame) => {
          if (finalized) {
            return;
          }
          if (!ready) {
            pending.push(frame);
            return;
          }
          writeFrame(frame);
        },
        end: () => {
          raw.end();
        },
      };

      raw.on('drain', () => {
        if (drainTimer !== undefined) {
          clearTimeout(drainTimer);
          drainTimer = undefined;
        }
      });
      raw.on('close', finalize);

      // Register before the snapshot read: an update published while the
      // snapshot loads is buffered (below) instead of dropped. §10.6 ordering —
      // retry + snapshot first, then every buffered update in publish order.
      broadcaster.add(client);
      if (app.hasDecorator('sseClients')) {
        app.sseClients.set({ scope, window }, broadcaster.size(scope, window));
      }

      client.send('retry: 5000\n\n');

      // Started synchronously after registration so `finalize` (which can only run
      // on a later tick) always has a live timer to stop.
      stopHeartbeat = startHeartbeat(() => {
        client.send(': ping\n\n');
        // M-5: every heartbeat proves the process is alive, so the lease can
        // expire quickly after a crash.
        if (counted && !finalized) {
          app.redis.expire(counterKey, SSE_COUNTER_LEASE_SECONDS).catch((error: unknown) => {
            app.log.warn({ err: error }, 'sse counter lease refresh failed');
          });
        }
      });

      // Spec §10.6 — snapshot from `lbmeta` + the board ZSET; deltas via cards.
      let snapshot: string | null = null;
      try {
        const meta = await app.redis.hgetall(redisKeys.leaderboardMeta(scope, window));
        const runId = meta.runId;
        if (runId !== undefined && runId !== '') {
          const flat = await app.redis.zrevrange(
            redisKeys.leaderboard(scope, window),
            0,
            SSE_TOP_SIZE - 1,
            'WITHSCORES',
          );
          const top: SnapshotEntry[] = [];
          for (let index = 0; index + 1 < flat.length; index += 2) {
            top.push({
              rank: index / 2 + 1,
              itemId: flat[index] ?? '',
              score: Number(flat[index + 1] ?? 0),
              delta: 0,
            });
          }
          if (top.length > 0) {
            const cards = await app.redis.mget(
              ...top.map((entry) => redisKeys.card(entry.itemId, window)),
            );
            cards.forEach((payload, index) => {
              const entry = top[index];
              if (entry !== undefined) {
                entry.delta = cardDelta(payload);
              }
            });
          }
          const lastEventIdHeader = request.headers['last-event-id'];
          const lastEventId = Array.isArray(lastEventIdHeader)
            ? lastEventIdHeader[0]
            : lastEventIdHeader;
          snapshot = snapshotFrame(scope, window, runId, top, lastEventId);
        }
      } catch (error) {
        app.log.warn({ err: error }, 'leaderboard snapshot unavailable');
      }
      if (snapshot !== null) {
        client.send(snapshot);
      }

      ready = true;
      for (const frame of pending) {
        writeFrame(frame);
      }
      pending.length = 0;
    },
  );
}
