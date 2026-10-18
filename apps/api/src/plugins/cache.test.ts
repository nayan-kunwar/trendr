import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  CACHE_BREAKER_COOLDOWN_MS,
  CACHE_BREAKER_THRESHOLD,
  createCache,
  type CacheStore,
} from './cache.js';

interface StubStore {
  store: CacheStore;
  get: Mock<CacheStore['get']>;
  set: Mock<CacheStore['set']>;
  del: Mock<CacheStore['del']>;
}

function stubStore(): StubStore {
  const get = vi.fn<CacheStore['get']>().mockResolvedValue(null);
  const set = vi.fn<CacheStore['set']>().mockResolvedValue('OK');
  const del = vi.fn<CacheStore['del']>().mockResolvedValue(1);
  return { store: { get, set, del }, get, set, del };
}

const sqlLoader =
  (value = 'sql') =>
  () =>
    Promise.resolve(value);

describe('createCache (spec §9.3)', () => {
  it('loads and caches the loader result on a miss', async () => {
    const { store, set } = stubStore();
    const cache = createCache({ store });
    const load = vi.fn(() => Promise.resolve({ v: 1 }));

    await expect(cache.readThrough('item:1', 300, load)).resolves.toEqual({ v: 1 });
    expect(load).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith('item:1', '{"v":1}', 'EX', 300);
  });

  it('returns a cached hit without loading', async () => {
    const { store, get } = stubStore();
    get.mockResolvedValue(JSON.stringify({ v: 2 }));
    const cache = createCache({ store });
    const load = vi.fn(() => Promise.resolve({ v: 3 }));

    await expect(cache.readThrough('item:2', 300, load)).resolves.toEqual({ v: 2 });
    expect(load).not.toHaveBeenCalled();
  });

  it('treats a corrupt entry as a miss', async () => {
    const { store } = stubStore();
    store.get = vi.fn(() => Promise.resolve('{not json'));
    const cache = createCache({ store });
    const load = vi.fn(() => Promise.resolve('fresh'));

    await expect(cache.readThrough('item:3', 300, load)).resolves.toBe('fresh');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('degrades to the loader when the read fails, counting the error', async () => {
    const { store, get } = stubStore();
    get.mockRejectedValue(new Error('redis down'));
    const cache = createCache({ store });

    await expect(cache.readThrough('item:4', 300, sqlLoader())).resolves.toBe('sql');
    expect(cache.breakerState()).toMatchObject({ open: false, consecutiveErrors: 1 });
  });

  it('still returns the loaded value when the write fails', async () => {
    const { store, set } = stubStore();
    set.mockRejectedValue(new Error('write failed'));
    const cache = createCache({ store });

    await expect(cache.readThrough('item:5', 300, sqlLoader('value'))).resolves.toBe('value');
    expect(cache.breakerState().consecutiveErrors).toBe(1);
  });

  it('opens the breaker after N consecutive errors and stops touching Redis', async () => {
    const { store, get } = stubStore();
    get.mockRejectedValue(new Error('redis down'));
    const cache = createCache({ store });

    for (let i = 0; i < CACHE_BREAKER_THRESHOLD; i += 1) {
      await cache.readThrough(`item:${i}`, 300, sqlLoader());
    }
    expect(cache.breakerState()).toMatchObject({
      open: true,
      consecutiveErrors: CACHE_BREAKER_THRESHOLD,
    });

    const calls = get.mock.calls.length;
    await expect(cache.readThrough('item:open', 300, sqlLoader())).resolves.toBe('sql');
    expect(get.mock.calls.length).toBe(calls);
  });

  it('retries Redis after the cooldown and closes the breaker on success', async () => {
    const { store, get } = stubStore();
    get.mockRejectedValue(new Error('redis down'));
    let now = 0;
    const cache = createCache({ store, now: () => now });

    for (let i = 0; i < CACHE_BREAKER_THRESHOLD; i += 1) {
      await cache.readThrough(`item:${i}`, 300, sqlLoader());
    }
    expect(cache.breakerState().open).toBe(true);

    now += CACHE_BREAKER_COOLDOWN_MS + 1;
    expect(cache.breakerState().open).toBe(false);
    get.mockResolvedValue(JSON.stringify('recovered'));

    await expect(cache.readThrough('item:again', 300, sqlLoader())).resolves.toBe('recovered');
    expect(cache.breakerState()).toMatchObject({ open: false, consecutiveErrors: 0 });
  });

  it('resets the error count after a successful command', async () => {
    const { store, get } = stubStore();
    const cache = createCache({ store });

    get.mockRejectedValueOnce(new Error('blip'));
    await cache.readThrough('item:6', 300, sqlLoader());
    expect(cache.breakerState().consecutiveErrors).toBe(1);

    get.mockResolvedValue(JSON.stringify('cached'));
    await cache.readThrough('item:6', 300, sqlLoader());
    expect(cache.breakerState().consecutiveErrors).toBe(0);
  });

  it('invalidates keys and counts failures without throwing', async () => {
    const { store, del } = stubStore();
    const cache = createCache({ store });

    await cache.invalidate('item:1', 'item:2');
    expect(del).toHaveBeenCalledWith('item:1', 'item:2');

    del.mockRejectedValue(new Error('redis down'));
    await expect(cache.invalidate('item:3')).resolves.toBeUndefined();
    expect(cache.breakerState().consecutiveErrors).toBe(1);
  });

  it('does not touch Redis while the breaker is open', async () => {
    const { store, get, set, del } = stubStore();
    get.mockRejectedValue(new Error('redis down'));
    const cache = createCache({ store });

    for (let i = 0; i < CACHE_BREAKER_THRESHOLD; i += 1) {
      await cache.readThrough(`item:${i}`, 300, sqlLoader());
    }
    const counts = { get: get.mock.calls.length, set: set.mock.calls.length };
    await cache.invalidate('item:1');
    expect(del).not.toHaveBeenCalled();
    expect({ get: get.mock.calls.length, set: set.mock.calls.length }).toEqual(counts);
  });
});
