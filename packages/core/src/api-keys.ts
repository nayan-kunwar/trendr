import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Public API-key helpers (spec §10.5, §15):
 * `X-API-Key: dt_live_<8-char prefix>_<32 base62 chars>`. Only the prefix is
 * stored in clear (`api_keys.prefix`); the full key is kept as
 * `HMAC-SHA256(API_KEY_PEPPER, key)`.
 */

/** Header carrying a public API key (spec §15). */
export const API_KEY_HEADER = 'x-api-key';

/** Table prefix of every public API key, `dt_live_` (spec §15). */
export const API_KEY_SCHEME = 'dt_live_';

/** Characters after the scheme that form the stored prefix. */
export const API_KEY_PREFIX_CHARS = 8;

/** Random secret characters after the prefix separator (base62). */
export const API_KEY_SECRET_CHARS = 32;

const API_KEY_PATTERN = /^(dt_live_[A-Za-z0-9]{8})_([A-Za-z0-9]{32})$/;

export interface ParsedApiKey {
  /** `dt_live_XXXXXXXX` — the unique lookup value (`api_keys.prefix`). */
  prefix: string;
}

/** Strict shape check; malformed keys return null and the API answers 401. */
export function parseApiKey(raw: string): ParsedApiKey | null {
  const match = API_KEY_PATTERN.exec(raw);
  const prefix = match?.[1];
  return prefix === undefined ? null : { prefix };
}

/** Spec §15: `key_hash = HMAC-SHA256(API_KEY_PEPPER, full key)`. */
export function hashApiKey(pepper: string, raw: string): Buffer {
  return createHmac('sha256', pepper).update(raw).digest();
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Unbiased random base62 string using rejection sampling (248 = 4 × 62). */
export function randomBase62(length: number): string {
  let result = '';
  while (result.length < length) {
    for (const byte of randomBytes(Math.max(8, length - result.length))) {
      if (byte < 248) {
        result += BASE62.charAt(byte % BASE62.length);
        if (result.length === length) break;
      }
    }
  }
  return result;
}

export interface ApiKeyMaterial {
  /** Full key, returned to the user exactly once. */
  raw: string;
  /** `dt_live_XXXXXXXX`, stored in clear for lookup. */
  prefix: string;
  /** HMAC-SHA256(pepper, raw), stored in `api_keys.key_hash`. */
  hash: Buffer;
}

/** Spec §15 key format: `dt_live_<8-char prefix>_<32 random base62 chars>`. */
export function createApiKeyMaterial(pepper: string): ApiKeyMaterial {
  const prefix = `${API_KEY_SCHEME}${randomBase62(API_KEY_PREFIX_CHARS)}`;
  const raw = `${prefix}_${randomBase62(API_KEY_SECRET_CHARS)}`;
  return { raw, prefix, hash: hashApiKey(pepper, raw) };
}

/**
 * Constant-time hash comparison. The length guard keeps `timingSafeEqual`
 * from throwing when a malformed stored row has the wrong digest length.
 */
export function apiKeyHashesMatch(expected: Uint8Array, actual: Uint8Array): boolean {
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}
