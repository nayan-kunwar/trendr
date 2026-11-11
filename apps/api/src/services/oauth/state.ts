import type { Redis } from 'ioredis';
import { z } from 'zod';

import {
  OAUTH_PROVIDERS,
  OAUTH_STATE_TTL_SECONDS,
  oauthStateHash,
  redisKeys,
  UnavailableError,
} from '@trendr/core';

import { OAuthFlowError } from './errors.js';

/**
 * The authorization request lives in Redis under `oauth:state:<sha256(state)>`
 * for ten minutes. The cookie carries only the opaque state, so the PKCE
 * verifier and Google nonce never reach the browser (ADR-0034).
 */

export const OAuthStatePayloadSchema = z.strictObject({
  provider: z.enum(OAUTH_PROVIDERS),
  codeVerifier: z.string().min(43).max(128),
  nonce: z.string().min(16).max(128).nullable(),
  returnTo: z.string().max(512),
  createdAt: z.number().int().nonnegative(),
});

export type OAuthStatePayload = z.infer<typeof OAuthStatePayloadSchema>;

export async function storeOAuthState(
  redis: Redis,
  state: string,
  payload: OAuthStatePayload,
): Promise<void> {
  try {
    await redis.set(
      redisKeys.oauthState(oauthStateHash(state)),
      JSON.stringify(payload),
      'EX',
      OAUTH_STATE_TTL_SECONDS,
    );
  } catch (error) {
    throw new UnavailableError('OAuth state store is unavailable', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * `GETDEL` makes the state single-use even when two callbacks race: exactly one
 * caller receives the payload, the other gets `null`.
 */
export async function consumeOAuthState(
  redis: Redis,
  state: string,
): Promise<OAuthStatePayload | null> {
  let raw: string | null;
  try {
    raw = await redis.getdel(redisKeys.oauthState(oauthStateHash(state)));
  } catch (error) {
    throw new OAuthFlowError('provider_unavailable', 'OAuth state store is unavailable', {
      cause: error,
    });
  }
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    const payload = OAuthStatePayloadSchema.safeParse(parsed);
    return payload.success ? payload.data : null;
  } catch {
    return null;
  }
}
