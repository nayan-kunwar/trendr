import { createHash } from 'node:crypto';

import type { LeaderboardScope, Metric, Source, Window } from './types.js';

/**
 * Spec §9.1 — the single source of truth for every Redis key this application
 * writes. Callers never build key strings by hand.
 */

const LANG_ALL = '_all';

export const redisKeys = {
  /** `lb:{scope}:{window}:{lang}` — ZSET member = itemId, score = final_score (source boards) or z_score (`all`). */
  leaderboard: (scope: LeaderboardScope, window: Window, lang: string = LANG_ALL): string =>
    `lb:${scope}:${window}:${lang}`,

  /** `lbmeta:{scope}:{window}` — HASH runId/computedAt/count/version (ETag source). */
  leaderboardMeta: (scope: LeaderboardScope, window: Window): string => `lbmeta:${scope}:${window}`,

  /** `card:{itemId}:{window}` — LeaderboardEntry JSON minus rank (6 h). */
  card: (itemId: bigint | string, window: Window): string => `card:${itemId}:${window}`,

  /** `item:{itemId}` — Item detail DTO (300 s, api read-through). */
  item: (itemId: bigint | string): string => `item:${itemId}`,

  /** `hist:{itemId}:{metric}:{granularity}:{rangeKey}` — history points (900 s). */
  history: (
    itemId: bigint | string,
    metric: Metric,
    granularity: 'hour' | 'day',
    rangeKey: string,
  ): string => `hist:${itemId}:${metric}:${granularity}:${rangeKey}`,

  /** `q:{sha1(normalizedQuery)}` — filtered `/v1/trending` results (60 s; search 120 s). */
  queryCache: (normalizedQuery: string): string =>
    `q:${createHash('sha1').update(normalizedQuery).digest('hex')}`,

  /** `rl:{bucket}` — upstream token-bucket HASH (spec §7.4). */
  rateBucket: (bucket: string): string => `rl:${bucket}`,

  /** `rl:{bucket}:pause` — epoch-ms marker until which the bucket stays closed. */
  ratePause: (bucket: string): string => `rl:${bucket}:pause`,

  /** `etag:github:{itemId}` — last REST ETag (7 d). */
  etagGithub: (itemId: bigint | string): string => `etag:github:${itemId}`,

  /** `lock:score:{source}` — scoring-run lock, value = holder jobId (120 s). */
  scoreLock: (source: Source): string => `lock:score:${source}`,

  /** `lock:arxiv:conn` — arXiv single-connection mutex (30 s). */
  arxivConnectionLock: (): string => 'lock:arxiv:conn',

  /** `mcp:registry:cursor_ts` — last registry `updatedAt` seen (no TTL). */
  mcpRegistryCursor: (): string => 'mcp:registry:cursor_ts',
} as const;

/** Key prefix for inbound API rate limiting, owned by `@fastify/rate-limit` (spec §9.1). */
export const API_RATE_LIMIT_KEY_PREFIX = 'apirl:';

/** `events:leaderboard` PUB/SUB channel — leaderboard diff events (scoring → api SSE). */
export const LEADERBOARD_EVENTS_CHANNEL = 'events:leaderboard';
