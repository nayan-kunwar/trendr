import type { Redis } from 'ioredis';

import { env } from '@trendr/config';
import type { RateLimitWaitObserver } from '@trendr/core';
import type { Logger } from '@trendr/logger';
import {
  createArxivAdapter,
  createBucket,
  createGitHubAdapter,
  createGitHubBuckets,
  createHuggingFaceAdapter,
  createMcpAdapter,
  createNpmAdapter,
  createPypiAdapter,
  createRedisArxivConnectionLock,
  createRedisEtagStore,
  createRedisMcpCursor,
  createRedisPypiEtagStore,
  effectiveHfRatePer5Min,
  registerAdapter,
} from '@trendr/sources';

/**
 * Spec §3.3 — boot-time adapter registration for ingest workers. Sources
 * without credentials stay unregistered: their jobs fail non-retryably
 * (`AdapterNotRegisteredError` → DLQ) instead of hammering upstream API hosts.
 * npm and PyPI are credential-free, so they register regardless of the GitHub
 * token set.
 */
export interface RegisterIngestAdaptersOptions {
  /** §14.1 rate-limit wait histogram hook. */
  onRateLimitWait?: RateLimitWaitObserver;
}

export function registerIngestAdapters(
  redis: Redis,
  logger: Logger,
  options: RegisterIngestAdaptersOptions = {},
): void {
  const waitOpts = options.onRateLimitWait === undefined ? {} : { onWait: options.onRateLimitWait };
  registerAdapter(
    createNpmAdapter({
      userAgent: env.HTTP_USER_AGENT,
      minWeeklyDownloads: env.NPM_MIN_WEEKLY_DOWNLOADS,
      downloadsBucket: createBucket(redis, 'npm:downloads', waitOpts),
    }),
  );
  logger.info('npm adapter registered');

  registerAdapter(
    createPypiAdapter({
      userAgent: env.HTTP_USER_AGENT,
      minWeeklyDownloads: env.PYPI_MIN_WEEKLY_DOWNLOADS,
      statsBucket: createBucket(redis, 'pypi:stats', waitOpts),
      etags: createRedisPypiEtagStore(redis),
    }),
  );
  logger.info('pypi adapter registered');

  const hfToken = env.HF_TOKEN?.trim() ?? '';
  registerAdapter(
    createHuggingFaceAdapter({
      userAgent: env.HTTP_USER_AGENT,
      ...(hfToken === '' ? {} : { token: hfToken }),
      includeDatasets: env.HF_INCLUDE_DATASETS,
      includeSpaces: env.HF_INCLUDE_SPACES,
    }),
  );
  logger.info(
    { includeDatasets: env.HF_INCLUDE_DATASETS, includeSpaces: env.HF_INCLUDE_SPACES },
    'huggingface adapter registered',
  );

  const hfRatePer5Min = effectiveHfRatePer5Min(env.HF_RATE_PER_5MIN, hfToken !== '');
  registerAdapter(
    createArxivAdapter({
      userAgent: env.HTTP_USER_AGENT,
      hfBucket: createBucket(redis, 'huggingface:api', { hfRatePer5Min, ...waitOpts }),
      ...(hfToken === '' ? {} : { hfToken }),
      connectionLock: createRedisArxivConnectionLock(redis),
    }),
  );
  logger.info({ hfRatePer5Min }, 'arxiv adapter registered');

  const tokens = env.GITHUB_TOKENS ?? [];
  registerAdapter(
    createMcpAdapter({
      userAgent: env.HTTP_USER_AGENT,
      cursorStore: createRedisMcpCursor(redis),
      npmBucket: createBucket(redis, 'npm:registry', waitOpts),
      ...(tokens.length === 0
        ? {}
        : {
            github: {
              tokens,
              searchBucket: createBucket(redis, 'github:search', waitOpts),
              reserve: env.GITHUB_RESERVE,
            },
          }),
    }),
  );
  logger.info({ githubFallback: tokens.length > 0 }, 'mcp adapter registered');

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
      buckets: createGitHubBuckets(redis, tokens.length, options.onRateLimitWait),
      etags: createRedisEtagStore(redis),
    }),
  );
  logger.info({ tokens: tokens.length }, 'github adapter registered');
}
