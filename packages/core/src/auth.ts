import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Spec §10.5 — access-JWT claim values. The API verifies `iss`/`aud` on every
 * bearer token (task 4.6 admin auth) and the magic-link flow (task 7.1) signs
 * with the same pair.
 */

export const JWT_ISSUER = 'trendr';
export const JWT_AUDIENCE = 'trendr-api';

/** Spec §10.5: 15-minute access tokens. */
export const JWT_ACCESS_TTL = '15m';
export const JWT_ACCESS_TTL_SECONDS = 15 * 60;

/** Spec §10.5: magic links expire after 15 minutes. */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

/** Spec §10.5: refresh tokens are 32 random bytes. */
export const REFRESH_TOKEN_BYTES = 32;

export type UnsubscribePurpose = 'digest' | 'alerts' | 'all';
export const UNSUBSCRIBE_PURPOSES: readonly UnsubscribePurpose[] = ['digest', 'alerts', 'all'];
export const UNSUBSCRIBE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Generate a URL-safe opaque token; only its SHA-256 hash is stored. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Spec §10.5: magic-link/refresh rows store `sha256(token)`, never the raw token. */
export function hashToken(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Constant-time comparison for secret strings (bearer tokens, HMACs). The
 * length guard keeps `timingSafeEqual` from throwing when the inputs differ in
 * length; equal-length inputs are compared without an early exit.
 */
export function timingSafeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface UnsubscribeTokenInput {
  userId: string;
  purpose: UnsubscribePurpose;
  /** Absolute expiry in milliseconds since the epoch. */
  expiresAt: number;
  secret: string;
}

/**
 * Spec §13.4: `base64url(userId.purpose.exp) + "." + HMAC-SHA256(payload)`.
 * The payload is the base64url string itself, so verification does not need
 * a DB lookup.
 */
export function signUnsubscribeToken(input: UnsubscribeTokenInput): string {
  const payload = `${input.userId}.${input.purpose}.${input.expiresAt}`;
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  return `${encoded}.${hmacBase64Url(input.secret, encoded)}`;
}

export interface VerifiedUnsubscribeToken {
  userId: string;
  purpose: UnsubscribePurpose;
  expiresAt: number;
}

/** Returns null for malformed, tampered, or expired tokens. */
export function verifyUnsubscribeToken(
  token: string,
  secret: string,
  now = Date.now(),
): VerifiedUnsubscribeToken | null {
  const [encoded, signature, ...rest] = token.split('.');
  if (encoded === undefined || signature === undefined || rest.length > 0) {
    return null;
  }
  const expected = hmacBase64Url(secret, encoded);
  if (!timingSafeStringEqual(signature, expected)) {
    return null;
  }

  let payload: string;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const [userId, purpose, expiry, ...extra] = payload.split('.');
  if (
    userId === undefined ||
    purpose === undefined ||
    expiry === undefined ||
    extra.length > 0 ||
    !UNSUBSCRIBE_PURPOSES.includes(purpose as UnsubscribePurpose)
  ) {
    return null;
  }
  const expiresAt = Number(expiry);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    return null;
  }
  return { userId, purpose: purpose as UnsubscribePurpose, expiresAt };
}

/** Monday (UTC) of the week containing `date`, as `YYYY-MM-DD`. */
export function weekStartUtc(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // getUTCDay(): Sunday = 0; shift so Monday = 0.
  const offset = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - offset);
  return day.toISOString().slice(0, 10);
}

function hmacBase64Url(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}
