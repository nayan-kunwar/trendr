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

  /**
   * `lbprev:{scope}:{window}:{lang}:{runId}` — copy of the board before the
   * run's swap, kept for rank-entry alert evaluation (48 h).
   */
  leaderboardPrevious: (
    scope: LeaderboardScope,
    window: Window,
    lang: string,
    runId: bigint | string,
  ): string => `lbprev:${scope}:${window}:${lang}:${String(runId)}`,

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

  /** `etag:pypi:{project}` — last PyPI JSON ETag (7 d). */
  etagPypi: (project: string): string => `etag:pypi:${project}`,

  /** `lock:score:{source}` — scoring-run lock, value = holder jobId (120 s). */
  scoreLock: (source: Source): string => `lock:score:${source}`,

  /** `lock:arxiv:conn` — arXiv single-connection mutex (30 s). */
  arxivConnectionLock: (): string => 'lock:arxiv:conn',

  /** `mcp:registry:cursor_ts` — last registry `updatedAt` seen (no TTL). */
  mcpRegistryCursor: (): string => 'mcp:registry:cursor_ts',

  /** `apikey:last-used:{id}` — NX marker so `api_keys.last_used_at` writes at most once a minute (spec §10.5). */
  apiKeyLastUsed: (id: string): string => `apikey:last-used:${id}`,

  /** M-2: `apikey:lookup:{prefix}` — short-lived API-key row cache (60 s), invalidated on revoke. */
  apiKeyLookup: (prefix: string): string => `apikey:lookup:${prefix}`,

  /** `apirl:magic:{sha256(email)}` — per-address magic-link issuance (3/h, §10.5). */
  magicLinkBucket: (emailHash: string): string => `apirl:magic:${emailHash}`,

  /** `apirl:auth:{ip}` — strict 5/min sign-in bucket shared by magic-link/verify/logout. */
  authRateBucket: (ip: string): string => `apirl:auth:${ip}`,

  /** `apirl:auth:refresh:{sha256-prefix}` — per-session refresh budget (60/min, H-3). */
  authRefreshBucket: (sessionHashPrefix: string): string =>
    `apirl:auth:refresh:${sessionHashPrefix}`,

  /** `apirl:auth:refresh:ip:{ip}` — coarse guard against random-cookie floods (H-3). */
  authRefreshIpBucket: (ip: string): string => `apirl:auth:refresh:ip:${ip}`,

  /** `apirl:oauth:{ip}` — dedicated OAuth start/callback bucket (20/min). */
  oauthRateBucket: (ip: string): string => `apirl:oauth:${ip}`,

  /**
   * `apirl:auth-fail:{api-key|bearer}:{ip}` — failed-credential guard checked
   * before the API-key/JWT hooks do database or crypto work. It counts only
   * rejected credentials, so valid traffic keeps its normal tier.
   */
  authFailureBucket: (kind: 'api-key' | 'bearer', ip: string): string =>
    `apirl:auth-fail:${kind}:${ip}`,

  /**
   * `oauth:state:<sha256(state)>` — ten-minute authorization request
   * (provider, PKCE verifier, nonce, returnTo). Consumed with GETDEL so each
   * state is single-use; the raw state is never a Redis key.
   */
  oauthState: (stateHash: string): string => `oauth:state:${stateHash}`,

  /** `apirl:sse:{keyId|ip}` — concurrent SSE stream counter with INCR/DECR (spec §9.1, §10.5). */
  sseConnections: (identity: string): string => `apirl:sse:${identity}`,

  /** `rl:last:{source}:{resource}` — last upstream rate-limit headers a worker saw (§10.1 admin). */
  rateLimitLast: (source: Source, resource: string): string => `rl:last:${source}:${resource}`,

  /** `dlq:retry:{jobId}` — per-DLQ-entry retry counter for the `.retry{n}` suffix (§10.1). */
  dlqRetry: (jobId: string): string => `dlq:retry:${jobId}`,
} as const;

/** Key prefix for inbound API rate limiting, owned by `@fastify/rate-limit` (spec §9.1). */
export const API_RATE_LIMIT_KEY_PREFIX = 'apirl:';

/** `events:leaderboard` PUB/SUB channel — leaderboard diff events (scoring → api SSE). */
export const LEADERBOARD_EVENTS_CHANNEL = 'events:leaderboard';
