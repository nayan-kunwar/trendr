import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import { RedisTokenBucket, SOURCES } from '@trendr/core';

import { BUCKET_NAMES, SOURCE_PRIMARY_BUCKET, bucketSpec, createBucket } from './buckets.js';

describe('bucket table (spec §7.4)', () => {
  it('resolves every named bucket with positive limits', () => {
    for (const name of BUCKET_NAMES) {
      const spec = bucketSpec(name);
      expect(spec.name).toBe(name);
      expect(spec.capacity).toBeGreaterThan(0);
      expect(spec.refillPerSec).toBeGreaterThan(0);
    }
  });

  it('uses the documented capacities and refill rates', () => {
    expect(bucketSpec('github:core')).toEqual({
      name: 'github:core',
      capacity: 500,
      refillPerSec: 4_500 / 3_600,
    });
    expect(bucketSpec('github:search')).toEqual({
      name: 'github:search',
      capacity: 25,
      refillPerSec: 25 / 60,
    });
    expect(bucketSpec('arxiv:api')).toEqual({
      name: 'arxiv:api',
      capacity: 1,
      refillPerSec: 1 / 3,
    });
    // Spec §7.4 / task 5.2: pypistats gets one request per two seconds. With
    // capacity 1 and a 0.5 token/s refill, a second call waits ≥ 2 s.
    expect(bucketSpec('pypi:stats')).toEqual({
      name: 'pypi:stats',
      capacity: 1,
      refillPerSec: 0.5,
    });
  });

  it('sizes the Hugging Face bucket from HF_RATE_PER_5MIN (80 %, refilled over 5 min)', () => {
    expect(bucketSpec('huggingface:api')).toEqual({
      name: 'huggingface:api',
      capacity: 800,
      refillPerSec: 800 / 300,
    });
    expect(bucketSpec('huggingface:api', { hfRatePer5Min: 500 })).toEqual({
      name: 'huggingface:api',
      capacity: 400,
      refillPerSec: 400 / 300,
    });
  });

  it('maps every source to one of the named primary buckets', () => {
    for (const source of SOURCES) {
      expect(BUCKET_NAMES).toContain(SOURCE_PRIMARY_BUCKET[source]);
    }
  });

  it('builds a RedisTokenBucket that registers its Lua command', () => {
    const defineCommand = vi.fn();
    const redis = { defineCommand } as unknown as Redis;

    const bucket = createBucket(redis, 'npm:registry');

    expect(bucket).toBeInstanceOf(RedisTokenBucket);
    expect(defineCommand).toHaveBeenCalledWith(
      'takeToken',
      expect.objectContaining({ numberOfKeys: 2 }),
    );
  });
});
