import { RedisTokenBucket, type BucketSpec, type Source } from '@trendr/core';
import type { Redis } from 'ioredis';

/**
 * Spec §7.4 — the per-API token buckets, keyed `rl:{name}` in Redis. The
 * worker builds each source's primary bucket from `SOURCE_PRIMARY_BUCKET`;
 * adapters may construct extra buckets (search, graphql, downloads) by name.
 */
export const BUCKET_NAMES = [
  'github:core',
  'github:search',
  'github:graphql',
  'npm:registry',
  'npm:downloads',
  'pypi:json',
  'pypi:stats',
  'huggingface:api',
  'arxiv:api',
  'mcp:registry',
] as const;
export type BucketName = (typeof BUCKET_NAMES)[number];

interface BucketDefinition {
  capacity: number;
  refillPerSec: number;
}

/** The §7.4 table, minus the env-dependent Hugging Face row. */
const BUCKETS: Record<Exclude<BucketName, 'huggingface:api'>, BucketDefinition> = {
  'github:core': { capacity: 500, refillPerSec: 4_500 / 3_600 }, // 5,000/h documented, 10% headroom
  'github:search': { capacity: 25, refillPerSec: 25 / 60 }, // 30/min documented
  'github:graphql': { capacity: 300, refillPerSec: 4_500 / 3_600 }, // 5,000 pts/h documented
  'npm:registry': { capacity: 10, refillPerSec: 5 }, // undocumented (verify)
  'npm:downloads': { capacity: 5, refillPerSec: 2 }, // undocumented (verify)
  'pypi:json': { capacity: 20, refillPerSec: 10 }, // no documented edge limit
  'pypi:stats': { capacity: 1, refillPerSec: 0.5 }, // IP rate limit, unpublished
  'arxiv:api': { capacity: 1, refillPerSec: 1 / 3 }, // ToS: one request per 3 s
  'mcp:registry': { capacity: 5, refillPerSec: 2 }, // undocumented (verify)
};

export interface BucketOptions {
  /** `HF_RATE_PER_5MIN`; capacity is 0.8 × the 5-minute budget (spec §7.4). */
  hfRatePer5Min?: number;
}

export function bucketSpec(name: BucketName, options: BucketOptions = {}): BucketSpec {
  if (name === 'huggingface:api') {
    const capacity = Math.round(0.8 * (options.hfRatePer5Min ?? 1_000));
    return { name, capacity, refillPerSec: capacity / 300 };
  }
  return { name, ...BUCKETS[name] };
}

/** Build a limiter against Redis (shared by every worker process, spec §7.4). */
export function createBucket(
  redis: Redis,
  name: BucketName,
  options: BucketOptions = {},
): RedisTokenBucket {
  return new RedisTokenBucket(redis, bucketSpec(name, options));
}

/**
 * Spec §7.3.1 — with several tokens the adapter round-robins and keeps one
 * core bucket per token (`rl:github:core:{tokenIdx}`), so the per-token quota
 * is never exceeded by the multitoken deployment.
 */
export function githubCoreBucketSpec(tokenIndex: number): BucketSpec {
  return { name: `github:core:${tokenIndex}`, ...BUCKETS['github:core'] };
}

/** The bucket every adapter uses for its main API endpoint (spec §7.4). */
export const SOURCE_PRIMARY_BUCKET: Record<Source, BucketName> = {
  github: 'github:core',
  npm: 'npm:registry',
  pypi: 'pypi:json',
  huggingface: 'huggingface:api',
  arxiv: 'arxiv:api',
  mcp: 'mcp:registry',
};
