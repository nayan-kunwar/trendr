/**
 * Spec §10.5 — access-JWT claim values. The API verifies `iss`/`aud` on every
 * bearer token (task 4.6 admin auth) and the magic-link flow (task 7.1) signs
 * with the same pair.
 */

export const JWT_ISSUER = 'trendr';
export const JWT_AUDIENCE = 'trendr-api';

/** Spec §10.5: 15-minute access tokens. */
export const JWT_ACCESS_TTL = '15m';
