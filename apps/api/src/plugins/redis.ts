import fp from 'fastify-plugin';
import type { Redis } from 'ioredis';

declare module 'fastify' {
  interface FastifyInstance {
    /** Shared command connection (cache, rate limits, reads). */
    redis: Redis;
    /** Dedicated subscriber for pub/sub fan-out (SSE, task 3.6). */
    redisSub: Redis;
  }
}

export interface RedisPluginOptions {
  redis: Redis;
  /** Defaults to `redis.duplicate()`; a subscriber created here is torn down on close. */
  redisSub?: Redis;
}

/** Decorates `app.redis` + `app.redisSub` (spec §4, §9.3). */
export const registerRedis = fp<RedisPluginOptions>(
  (app, { redis, redisSub }) => {
    // A subscriber created here gets subscriber-friendly options: failures are
    // queued (the main client fails fast for the §9.3 circuit breaker) and its
    // error events are logged instead of crashing the process.
    const subscriber =
      redisSub ?? redis.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null });
    if (redisSub === undefined) {
      subscriber.on('error', (error: Error) => {
        app.log.warn({ err: error }, 'redis subscriber error');
      });
    }
    app.decorate('redis', redis);
    app.decorate('redisSub', subscriber);
    if (redisSub === undefined) {
      app.addHook('onClose', (_instance, done) => {
        subscriber.disconnect();
        done();
      });
    }
  },
  { name: 'redis' },
);
