import { createHash } from 'node:crypto';

import { randomToken } from './auth.js';

/**
 * OAuth 2.0 Authorization Code + PKCE (RFC 7636) primitives shared by the API
 * routes and tests. Provider-specific protocol details live in
 * `apps/api/src/services/oauth/`.
 *
 * GitHub supports PKCE S256 since 2025-07-14 (GitHub changelog); it is
 * recommended but not required there. Google supports S256 for web clients.
 */

export const OAUTH_PROVIDERS = ['google', 'github'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export const OAUTH_PROVIDER_LABELS: Readonly<Record<OAuthProvider, string>> = {
  google: 'Google',
  github: 'GitHub',
};

/** The authorization request (state + verifier) expires after ten minutes. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const OAUTH_STATE_TTL_SECONDS = OAUTH_STATE_TTL_MS / 1000;

/** Cookie holding only the opaque state; the verifier lives in Redis. */
export const OAUTH_STATE_COOKIE = 'dt_oauth_state';
export const OAUTH_STATE_COOKIE_PATH = '/v1/auth/oauth';

/** Dedicated OAuth limiter: 20 start/callback requests per minute per IP. */
export const OAUTH_RATE_LIMIT_MAX = 20;
export const OAUTH_RATE_LIMIT_WINDOW_SECONDS = 60;

/** 32 random bytes base64url = 43 characters, inside RFC 7636's 43–128 range. */
const PKCE_VERIFIER_BYTES = 32;
const MAX_RETURN_TO_LENGTH = 512;
const DEFAULT_RETURN_TO = '/dashboard';

export interface PkcePair {
  /** Secret sent only in the token request; stored in Redis, never in a cookie. */
  verifier: string;
  /** `BASE64URL(SHA256(ASCII(verifier)))`, sent to the provider. */
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = randomToken(PKCE_VERIFIER_BYTES);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** `oauth:state:<sha256(state)>`; the raw state is only in the cookie/URL. */
export function oauthStateHash(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

/**
 * Accept only a same-origin absolute path. Rejects scheme-relative URLs
 * (`//evil.example`), backslashes (`/\\evil.example`, which some browsers
 * normalise to `//`), control characters and overlong values.
 */
export function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_RETURN_TO;
  if (value.length === 0 || value.length > MAX_RETURN_TO_LENGTH) return DEFAULT_RETURN_TO;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return DEFAULT_RETURN_TO;
  }
  // Character-code check instead of a control-character regex (no-control-regex):
  // C0 controls and DEL are never valid in a browser path.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return DEFAULT_RETURN_TO;
  }
  return value;
}

/** A random opaque state (32 bytes base64url). */
export function createOAuthState(): string {
  return randomToken(32);
}
