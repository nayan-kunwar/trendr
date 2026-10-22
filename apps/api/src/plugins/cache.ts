import fp from 'fastify-plugin';

/** Consecutive Redis errors that open the circuit breaker (spec §9.3). */
export const CACHE_BREAKER_THRESHOLD = 5;
/** How long Redis is skipped once the breaker is open (spec §9.3: 30 s). */
export const CACHE_BREAKER_COOLDOWN_MS = 30_000;

/** The slice of ioredis the read-through cache needs (unit tests pass a stub). */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

export interface CacheBreakerState {
  open: boolean;
  consecutiveErrors: number;
  /** Epoch ms the current skipping window ends at; null once a command succeeds. */
  openUntil: number | null;
}

/** §14.1 `trendr_cache_requests_total{cache=…}`. */
export type CacheKind = 'leaderboard' | 'item' | 'history' | 'query';
export type CacheResult = 'hit' | 'miss';

/** Client-side cache namespace → metric label. */
export function cacheKindForKey(key: string): CacheKind {
  if (key.startsWith('item:')) return 'item';
  if (key.startsWith('hist:')) return 'history';
  if (key.startsWith('lb:') || key.startsWith('lbmeta:')) return 'leaderboard';
  return 'query';
}

export interface CacheApi {
  /**
   * Spec §9.3 read-through: return the JSON cached under `key`, or run `load`
   * and cache its result for `ttlSec`. While the breaker is open — or whenever
   * Redis fails — only the loader runs, so callers never see Redis errors.
   */
  readThrough<T>(key: string, ttlSec: number, load: () => Promise<T>, kind?: CacheKind): Promise<T>;
  /** Best-effort DEL; a failure only feeds the breaker. */
  invalidate(...keys: string[]): Promise<void>;
  breakerState(): CacheBreakerState;
}

export interface CacheDeps {
  store: CacheStore;
  /** Injectable clock (unit tests). */
  now?: () => number;
  /** §14.1 cache hit/miss observer. */
  onResult?: (cache: CacheKind, result: CacheResult) => void;
}

/** Pure factory so breaker/read-through logic is testable without Fastify. */
export function createCache({ store, now = Date.now, onResult }: CacheDeps): CacheApi {
  let consecutiveErrors = 0;
  let openUntil: number | null = null;

  const isOpen = (): boolean => openUntil !== null && now() < openUntil;

  function recordSuccess(): void {
    consecutiveErrors = 0;
    openUntil = null;
  }

  function recordError(): void {
    consecutiveErrors += 1;
    if (consecutiveErrors >= CACHE_BREAKER_THRESHOLD) {
      openUntil = now() + CACHE_BREAKER_COOLDOWN_MS;
    }
  }

  return {
    async readThrough<T>(
      key: string,
      ttlSec: number,
      load: () => Promise<T>,
      kind?: CacheKind,
    ): Promise<T> {
      const cache = kind ?? cacheKindForKey(key);
      const report = (result: CacheResult): void => onResult?.(cache, result);
      if (isOpen()) {
        report('miss');
        return load();
      }
      let cached: string | null;
      try {
        cached = await store.get(key);
        recordSuccess();
      } catch {
        recordError();
        report('miss');
        return load();
      }
      if (cached !== null) {
        try {
          const value = JSON.parse(cached) as T;
          report('hit');
          return value;
        } catch {
          // Corrupt entry: fall through and let the loader refresh it.
        }
      }
      report('miss');
      const value = await load();
      try {
        await store.set(key, JSON.stringify(value), 'EX', ttlSec);
        recordSuccess();
      } catch {
        recordError();
      }
      return value;
    },

    async invalidate(...keys: string[]): Promise<void> {
      if (keys.length === 0 || isOpen()) {
        return;
      }
      try {
        await store.del(...keys);
        recordSuccess();
      } catch {
        recordError();
      }
    },

    breakerState(): CacheBreakerState {
      return { open: isOpen(), consecutiveErrors, openUntil };
    },
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Read-through cache with the §9.3 circuit breaker. */
    cache: CacheApi;
  }
}

export interface CachePluginOptions {
  /** Defaults to the redis plugin's command client. */
  store?: CacheStore;
  /** Injectable clock (unit tests). */
  now?: () => number;
  /** §14.1 observer; Fastify metrics decorates this after the cache plugin. */
  onResult?: (cache: CacheKind, result: CacheResult) => void;
}

/** Decorates `app.cache` (spec §4); requires the redis plugin unless a store is given. */
export const registerCache = fp<CachePluginOptions>(
  (app, { store, now, onResult }) => {
    if (store === undefined && !app.hasDecorator('redis')) {
      throw new Error('registerCache requires the redis plugin (or an explicit store)');
    }
    app.decorate(
      'cache',
      createCache({
        store: store ?? (app.redis as CacheStore),
        ...(now ? { now } : {}),
        onResult: (cache, result) => {
          onResult?.(cache, result);
          if (app.hasDecorator('observeCache')) app.observeCache(cache, result);
        },
      }),
    );
  },
  { name: 'cache' },
);
