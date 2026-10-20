import type { Redis } from 'ioredis';

import { env } from '@trendr/config';
import type { Logger } from '@trendr/logger';
import {
  createBucket,
  createGitHubAdapter,
  createGitHubBuckets,
  createNpmAdapter,
  createRedisEtagStore,
  registerAdapter,
} from '@trendr/sources';

/**
 * Spec §3.3 — boot-time adapter registration for ingest workers. Sources
 * without credentials stay unregistered: their jobs fail non-retryably
 * (`AdapterNotRegisteredError` → DLQ) instead of hammering upstream API hosts.
 * npm is credential-free, so it registers regardless of the GitHub token set.
 */
export function registerIngestAdapters(redis: Redis, logger: Logger): void {
  registerAdapter(
    createNpmAdapter({
      userAgent: env.HTTP_USER_AGENT,
      minWeeklyDownloads: env.NPM_MIN_WEEKLY_DOWNLOADS,
      downloadsBucket: createBucket(redis, 'npm:downloads'),
    }),
  );
  logger.info('npm adapter registered');

  const tokens = env.GITHUB_TOKENS ?? [];
  if (tokens.length === 0) {
    logger.warn('GITHUB_TOKENS is empty — the github adapter is not registered');
    return;
  }
  registerAdapter(
    createGitHubAdapter({
      tokens,
      userAgent: env.HTTP_USER_AGENT,
      reserve: env.GITHUB_RESERVE,
      backfillMaxPages: env.BACKFILL_GITHUB_MAX_PAGES,
      buckets: createGitHubBuckets(redis, tokens.length),
      etags: createRedisEtagStore(redis),
    }),
  );
  logger.info({ tokens: tokens.length }, 'github adapter registered');
}
