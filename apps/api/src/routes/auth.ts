import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { EmailSender } from '@trendr/email';
import {
  JWT_ACCESS_TTL_SECONDS,
  RateLimitedError,
  RefreshRotatedError,
  UnauthorizedError,
  UnavailableError,
  hashToken,
  redisKeys,
} from '@trendr/core';
import { deleteUser, findUserById, updateUserDisplayName, type UserRecord } from '@trendr/db';

import { requireUser } from '../plugins/auth.js';
import { CACHE_CONTROL } from '../plugins/etag.js';
import type { RefreshReuseOutcome } from '../plugins/metrics.js';
import { clientIp } from '../plugins/rate-limit.js';
import {
  AuthMessageResponse,
  AuthSessionResponse,
  MagicLinkBody,
  MePatchBody,
  MeResponse,
  VerifyMagicLinkBody,
  type AuthSessionBody,
  type MeBody,
} from '../schemas/auth.js';
import {
  issueMagicLink,
  revokeRefreshSession,
  rotateRefreshToken,
  verifyMagicLink,
  type AuthServiceOptions,
  type AuthSession,
} from '../services/auth.service.js';
import { allowCounter } from './auth-counters.js';
import {
  REFRESH_COOKIE,
  clearRefreshCookie as clearSessionRefreshCookie,
  setRefreshCookie as setSessionRefreshCookie,
  type RefreshCookieSameSite,
} from './auth-cookies.js';

// Kept as a re-export for the existing auth route tests.
export { REFRESH_COOKIE, REFRESH_COOKIE_PATH, refreshCookieOptions } from './auth-cookies.js';
export type { RefreshCookieSameSite } from './auth-cookies.js';

/**
 * Spec §10.5 — magic-link authentication, 15-minute access JWTs, rotating
 * 30-day refresh tokens in an httpOnly `dt_refresh` cookie scoped to
 * `/v1/auth`, and the `/v1/me` profile. Issuance is indistinguishable for
 * known and unknown emails (always 202); only the email's SHA-256 is stored.
 */

const MAGIC_LINKS_PER_EMAIL_PER_HOUR = 3;
const AUTH_WINDOW_SECONDS = 60;
const MAGIC_LINK_WINDOW_SECONDS = 3_600;

/** H-3: refresh is machine-driven, so it gets its own per-session budget. */
export const REFRESH_SESSION_MAX = 60;
/** H-3: coarse per-IP guard so random cookies cannot create unbounded keys. */
export const REFRESH_IP_MAX = 120;

export interface AuthRoutesOptions {
  /** Omitted only by tooling builds (OpenAPI export). */
  emailSender?: EmailSender;
  /** WEB_PUBLIC_URL, used to build the magic-link URL. */
  webPublicUrl?: string;
  /** ADMIN_EMAILS: these accounts are promoted on issuance/verification. */
  adminEmails?: readonly string[];
  refreshTtlDays?: number;
  accessTokenTtlSeconds?: number;
  /** Secure cookies in production; false only for local http development. */
  cookieSecure?: boolean;
  /**
   * Cookie SameSite mode (env: COOKIE_SAME_SITE). Default `lax` works for the
   * single-origin VPS and for custom subdomains of one registrable domain.
   * Cross-site origins (e.g. two `*.onrender.com` hosts, which the Public
   * Suffix List treats as separate sites) need `none` plus `cookieSecure`.
   */
  cookieSameSite?: RefreshCookieSameSite;
  /** Spec §10.5 auth tier: 5 requests/min per IP for magic-link/verify/logout. */
  authRateLimitMax?: number;
  /** H-3: per-session refresh budget (default 60/min); override for tests. */
  refreshRateLimitMax?: number;
  /** H-3: coarse per-IP refresh guard (default 120/min); override for tests. */
  refreshIpRateLimitMax?: number;
  /** Env TRUST_PROXY: use the same trusted-client-IP derivation as the global limiter. */
  trustProxy?: boolean;
  /** Env TRUST_CF_CONNECTING_IP: only a trusted proxy writes that header (M-12). */
  trustCfConnectingIp?: boolean;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRoutesOptions = {}): void {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const trustProxy = options.trustProxy ?? false;
  const trustCfConnectingIp = options.trustCfConnectingIp ?? false;
  const cookieSecure = options.cookieSecure ?? false;
  const cookieSameSite = options.cookieSameSite ?? 'lax';

  // SameSite=None is only honoured by browsers on Secure cookies. `main.ts`
  // derives Secure from NODE_ENV=production, and the env schema rejects this
  // combination outside production; keep the direct-call path honest too.
  if (cookieSameSite === 'none' && !cookieSecure) {
    throw new Error('cookieSameSite "none" requires secure cookies');
  }

  const serviceOptions = (): AuthServiceOptions => {
    if (!app.hasDecorator('db') || options.emailSender === undefined) {
      throw new UnavailableError('authentication is not configured');
    }
    const deps: AuthServiceOptions = {
      db: app.db,
      emailSender: options.emailSender,
      webPublicUrl: options.webPublicUrl ?? 'http://localhost:3000',
      adminEmails: options.adminEmails ?? [],
    };
    if (options.refreshTtlDays !== undefined) deps.refreshTtlDays = options.refreshTtlDays;
    if (options.now !== undefined) deps.now = options.now;
    return deps;
  };

  const signAccessToken = (user: UserRecord): string =>
    app.jwt.sign({ sub: user.id, role: user.role });

  const sessionBody = (session: AuthSession): AuthSessionBody => ({
    accessToken: signAccessToken(session.user),
    expiresIn: options.accessTokenTtlSeconds ?? JWT_ACCESS_TTL_SECONDS,
    user: toAuthUser(session.user),
  });

  const refreshCookieConfig = {
    sameSite: cookieSameSite,
    secure: cookieSecure,
    ttlDays: options.refreshTtlDays ?? 30,
  } as const;

  const setRefreshCookie = (reply: FastifyReply, session: AuthSession): void => {
    setSessionRefreshCookie(reply, session, refreshCookieConfig);
  };

  const clearRefreshCookie = (reply: FastifyReply): void => {
    clearSessionRefreshCookie(reply, refreshCookieConfig);
  };

  const guard = {
    onRequest: requireUser,
    config: { cacheControl: CACHE_CONTROL.privateNoStore },
  };

  const strictAuthGuard = async (request: FastifyRequest): Promise<void> => {
    const ip = clientIp(request, trustProxy, trustCfConnectingIp);
    if (
      !(await allowCounter(
        app,
        redisKeys.authRateBucket(ip),
        AUTH_WINDOW_SECONDS,
        options.authRateLimitMax ?? 5,
      ))
    ) {
      throw new RateLimitedError('too many authentication requests; try again in a minute');
    }
  };

  /**
   * H-3: refresh keeps the cookie-authenticated request path usable on every
   * page load. Anonymous calls (no cookie) skip the limiter entirely so every
   * visitor does not create a key; the session hash gets 60/min and a coarse
   * per-IP guard stops random-cookie floods before they mint more keys.
   */
  const refreshGuard = async (request: FastifyRequest): Promise<void> => {
    const raw = getRefreshCookie(request);
    if (raw === undefined) return;

    const ip = clientIp(request, trustProxy, trustCfConnectingIp);
    const ipAllowed = await allowCounter(
      app,
      redisKeys.authRefreshIpBucket(ip),
      AUTH_WINDOW_SECONDS,
      options.refreshIpRateLimitMax ?? REFRESH_IP_MAX,
    );
    if (!ipAllowed) {
      throw new RateLimitedError('too many refresh attempts; try again shortly');
    }
    const sessionAllowed = await allowCounter(
      app,
      redisKeys.authRefreshBucket(refreshSessionHash(raw)),
      AUTH_WINDOW_SECONDS,
      options.refreshRateLimitMax ?? REFRESH_SESSION_MAX,
    );
    if (!sessionAllowed) {
      throw new RateLimitedError('too many refresh attempts; try again shortly');
    }
  };

  server.post(
    '/v1/auth/magic-link',
    {
      config: {
        cacheControl: CACHE_CONTROL.privateNoStore,
      },
      onRequest: strictAuthGuard,
      schema: {
        body: MagicLinkBody,
        response: { 202: AuthMessageResponse },
      },
    },
    async (request, reply) => {
      const email = request.body.email.trim().toLowerCase();
      if (
        !(await allowCounter(
          app,
          redisKeys.magicLinkBucket(hashToken(email).toString('hex')),
          MAGIC_LINK_WINDOW_SECONDS,
          MAGIC_LINKS_PER_EMAIL_PER_HOUR,
        ))
      ) {
        throw new RateLimitedError('too many sign-in links requested for this email');
      }
      try {
        await issueMagicLink(serviceOptions(), {
          email,
          ip: clientIp(request, trustProxy, trustCfConnectingIp),
          userAgent: request.headers['user-agent'] ?? null,
        });
      } catch (error) {
        // Never distinguish delivery/account failures from success (§10.5).
        request.log.error({ err: error }, 'magic link delivery failed');
      }
      return reply.code(202).send({ ok: true });
    },
  );

  server.post(
    '/v1/auth/verify',
    {
      config: {
        cacheControl: CACHE_CONTROL.privateNoStore,
      },
      onRequest: strictAuthGuard,
      schema: {
        body: VerifyMagicLinkBody,
        response: { 200: AuthSessionResponse },
      },
    },
    async (request, reply) => {
      const session = await verifyMagicLink(serviceOptions(), request.body.token);
      if (session === null) {
        throw new UnauthorizedError('invalid or expired magic link');
      }
      setRefreshCookie(reply, session);
      return reply.send(sessionBody(session));
    },
  );

  server.post(
    '/v1/auth/refresh',
    {
      config: {
        cacheControl: CACHE_CONTROL.privateNoStore,
      },
      onRequest: refreshGuard,
      schema: { response: { 200: AuthSessionResponse } },
    },
    async (request, reply) => {
      const raw = getRefreshCookie(request);
      const outcome = await rotateRefreshToken(serviceOptions(), raw);
      if (outcome.status === 'grace') {
        observeRefreshReuse(app, 'grace');
        reply.header('retry-after', '1');
        throw new RefreshRotatedError(
          'refresh token was just rotated; retry with the current cookie',
        );
      }
      if (outcome.status === 'invalid') {
        if (outcome.reason === 'reused') observeRefreshReuse(app, 'theft');
        clearRefreshCookie(reply);
        throw new UnauthorizedError('invalid or expired refresh token');
      }
      setRefreshCookie(reply, outcome.session);
      return reply.send(sessionBody(outcome.session));
    },
  );

  server.post(
    '/v1/auth/logout',
    {
      config: {
        cacheControl: CACHE_CONTROL.privateNoStore,
      },
      onRequest: strictAuthGuard,
    },
    async (request, reply) => {
      await revokeRefreshSession(app.db, getRefreshCookie(request), options.now?.() ?? new Date());
      clearRefreshCookie(reply);
      return reply.code(204).send();
    },
  );

  server.get(
    '/v1/me',
    {
      ...guard,
      schema: { response: { 200: MeResponse } },
    },
    async (request) => {
      const user = await requireCurrentUser(app, request);
      return toAuthUser(user);
    },
  );

  server.patch(
    '/v1/me',
    {
      ...guard,
      schema: {
        body: MePatchBody,
        response: { 200: MeResponse },
      },
    },
    async (request) => {
      const current = await requireCurrentUser(app, request);
      if (request.body.displayName === undefined) return toAuthUser(current);
      const updated = await updateUserDisplayName(app.db, current.id, request.body.displayName);
      return toAuthUser(updated);
    },
  );

  server.delete(
    '/v1/me',
    {
      ...guard,
    },
    async (request, reply) => {
      const current = await requireCurrentUser(app, request);
      await deleteUser(app.db, current.id);
      clearRefreshCookie(reply);
      return reply.code(204).send();
    },
  );
}

function toAuthUser(user: UserRecord): MeBody {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}

async function requireCurrentUser(
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<UserRecord> {
  if (request.authUser === undefined) throw new UnauthorizedError('authentication required');
  if (!app.hasDecorator('db')) throw new UnavailableError('database is not configured');
  const user = await findUserById(app.db, request.authUser.id);
  if (user === null) throw new UnauthorizedError('account no longer exists');
  return user;
}

function getRefreshCookie(request: FastifyRequest): string | undefined {
  const cookie = request.cookies[REFRESH_COOKIE];
  return typeof cookie === 'string' && cookie.length > 0 ? cookie : undefined;
}

/** H-2/H-3: stable, short key for one refresh session (never the raw token). */
function refreshSessionHash(rawToken: string): string {
  return hashToken(rawToken).subarray(0, 8).toString('hex');
}

/** H-2: the metric plugin is optional in tooling builds and route unit tests. */
function observeRefreshReuse(app: FastifyInstance, outcome: RefreshReuseOutcome): void {
  if (app.hasDecorator('observeRefreshReuse')) {
    app.observeRefreshReuse(outcome);
  }
}
