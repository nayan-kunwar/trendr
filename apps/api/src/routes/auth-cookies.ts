import type { FastifyReply } from 'fastify';

import type { AuthSession } from '../services/auth.service.js';

/**
 * The rotating refresh cookie is shared by magic-link verification and OAuth
 * callbacks, so its attributes live in one place (spec §10.5, ADR-0034).
 */

export const REFRESH_COOKIE = 'dt_refresh';
export const REFRESH_COOKIE_PATH = '/v1/auth';

/** SameSite mode for the refresh cookie (env: COOKIE_SAME_SITE). */
export type RefreshCookieSameSite = 'lax' | 'strict' | 'none';

export interface RefreshCookieConfig {
  sameSite: RefreshCookieSameSite;
  secure: boolean;
  ttlDays: number;
}

/** Attributes for the rotating refresh cookie (exported for unit tests). */
export function refreshCookieOptions(
  sameSite: RefreshCookieSameSite,
  secure: boolean,
  ttlDays: number,
): {
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: RefreshCookieSameSite;
  maxAge: number;
} {
  return {
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    secure,
    sameSite,
    maxAge: ttlDays * 24 * 60 * 60,
  };
}

export function setRefreshCookie(
  reply: FastifyReply,
  session: AuthSession,
  config: RefreshCookieConfig,
): void {
  reply.setCookie(
    REFRESH_COOKIE,
    session.refreshToken,
    refreshCookieOptions(config.sameSite, config.secure, config.ttlDays),
  );
}

export function clearRefreshCookie(reply: FastifyReply, config: RefreshCookieConfig): void {
  // Match the attributes used when setting it so the deletion is accepted
  // in browsers that partition or reject mismatched cookies.
  reply.clearCookie(REFRESH_COOKIE, {
    path: REFRESH_COOKIE_PATH,
    secure: config.secure,
    sameSite: config.sameSite,
  });
}
