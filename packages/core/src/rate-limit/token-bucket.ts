import { setTimeout as sleep } from 'node:timers/promises';

import type { Redis } from 'ioredis';
import { readFileSync } from 'node:fs';

import { redisKeys } from '../redis-keys.js';

/**
 * Spec §7.4 — Redis token bucket shared by every worker process. The Lua script
 * lives in `token-bucket.lua` (the spec's single source of truth); the package
 * build copies it next to the compiled module and `readFileSync` resolves it
 * from this module's URL in both `src` (tests, tsx) and `dist` (prod).
 */
const LUA = readFileSync(new URL('./token-bucket.lua', import.meta.url), 'utf8');

export interface BucketSpec {
  name: string;
  capacity: number;
  refillPerSec: number;
}

/** §14.1 `trendr_rate_limit_wait_seconds{bucket}` — one observation per blocked `take`. */
export type RateLimitWaitObserver = (bucket: string, seconds: number) => void;

declare module 'ioredis' {
  interface Redis {
    /**
     * `takeToken` (numberOfKeys: 2) — the spec §7.4 bucket script, registered
     * with `defineCommand`. Returns `[allowed, waitMs]`.
     */
    takeToken(
      bucketKey: string,
      pauseKey: string,
      capacity: number,
      refillPerMs: number,
      cost: number,
      nowMs: number,
      ttlMs: number,
    ): Promise<[number, number]>;
  }
}

export class RedisTokenBucket {
  constructor(
    private readonly redis: Redis,
    private readonly spec: BucketSpec,
    private readonly onWait?: RateLimitWaitObserver,
  ) {
    redis.defineCommand('takeToken', { numberOfKeys: 2, lua: LUA });
  }

  /** Blocks (async) until `cost` tokens are available or the signal aborts. */
  async take(cost = 1, signal?: AbortSignal): Promise<void> {
    let waitStarted: number | undefined;
    for (;;) {
      signal?.throwIfAborted();
      const [allowed, waitMs] = await this.redis.takeToken(
        redisKeys.rateBucket(this.spec.name),
        redisKeys.ratePause(this.spec.name),
        this.spec.capacity,
        this.spec.refillPerSec / 1000,
        cost,
        Date.now(),
        3_600_000,
      );
      if (allowed === 1) {
        if (waitStarted !== undefined) {
          this.onWait?.(this.spec.name, (Date.now() - waitStarted) / 1000);
        }
        return;
      }
      waitStarted ??= Date.now();
      // Spec §7.4: wait the script's advertised delay plus jitter, capped at 60 s.
      await sleep(
        Math.min(waitMs + Math.floor(Math.random() * 50), 60_000),
        undefined,
        signal === undefined ? undefined : { signal },
      );
    }
  }

  /** Called when upstream says we're exhausted (x-ratelimit-reset / RateLimit t= / retry-after). */
  async pauseUntil(epochMs: number): Promise<void> {
    await this.redis.set(
      redisKeys.ratePause(this.spec.name),
      String(epochMs),
      'PX',
      Math.max(1, epochMs - Date.now()),
    );
  }
}
