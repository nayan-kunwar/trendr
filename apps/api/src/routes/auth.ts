import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { EmailSender } from '@trendr/email';
import {
  JWT_ACCESS_TTL_SECONDS,
  RateLimitedError,
  UnauthorizedError,
  UnavailableError,
  hashToken,
} from '@trendr/core';
import { deleteUser, findUserById, updateUserDisplayName, type UserRecord } from '@trendr/db';

import { requireUser } from '../plugins/auth.js';
import { CACHE_CONTROL } from '../plugins/etag.js';
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

/**
 * Spec §10.5 — magic-link authentication, 15-minute access JWTs, rotating
 * 30-day refresh tokens in an httpOnly `dt_refresh` cookie scoped to
 * `/v1/auth`, and the `/v1/me` profile. Issuance is indistinguishable for
 * known and unknown emails (always 202); only the email's SHA-256 is stored.
 */

const REFRESH_COOKIE = 'dt_refresh';
const REFRESH_COOKIE_PATH = '/v1/auth';
const MAGIC_LINKS_PER_EMAIL_PER_HOUR = 3;

/** SameSite mode for the refresh cookie (env: COOKIE_SAME_SITE). */
export type RefreshCookieSameSite = 'lax' | 'strict' | 'none';

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

/** Per-process fallback when Redis is absent (tests/tooling). */
const memoryMagicLinkCounters = new Map<string, { count: number; resetAt: number }>();
const memoryAuthCounters = new Map<string, { count: number; resetAt: number }>();

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
  /** Spec §10.5 auth tier: 5 requests/min per IP across `/v1/auth/*`. */
  authRateLimitMax?: number;
  /** Env TRUST_PROXY: use the same trusted-client-IP derivation as the global limiter. */
  trustProxy?: boolean;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRoutesOptions = {}): void {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const trustProxy = options.trustProxy ?? false;
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

  const setRefreshCookie = (reply: FastifyReply, session: AuthSession): void => {
    const ttlDays = options.refreshTtlDays ?? 30;
    reply.setCookie(
      REFRESH_COOKIE,
      session.refreshToken,
      refreshCookieOptions(cookieSameSite, cookieSecure, ttlDays),
    );
  };

  const clearRefreshCookie = (reply: FastifyReply): void => {
    // Match the attributes used when setting it so the deletion is accepted
    // in browsers that partition or reject mismatched cookies.
    reply.clearCookie(REFRESH_COOKIE, {
      path: REFRESH_COOKIE_PATH,
      secure: cookieSecure,
      sameSite: cookieSameSite,
    });
  };

  const guard = {
    onRequest: requireUser,
    config: { cacheControl: CACHE_CONTROL.privateNoStore },
  };

  const authRequestGuard = async (request: FastifyRequest): Promise<void> => {
    const ip = clientIp(request, trustProxy);
    if (!(await allowAuthRequest(app, ip, options.authRateLimitMax ?? 5))) {
      throw new RateLimitedError('too many authentication requests; try again in a minute');
    }
  };

  server.post(
    '/v1/auth/magic-link',
    {
      config: {
        cacheControl: CACHE_CONTROL.privateNoStore,
      },
      onRequest: authRequestGuard,
      schema: {
        body: MagicLinkBody,
        response: { 202: AuthMessageResponse },
      },
    },
    async (request, reply) => {
      const email = request.body.email.trim().toLowerCase();
      if (!(await allowMagicLink(app, email, options.now?.() ?? new Date()))) {
        throw new RateLimitedError('too many sign-in links requested for this email');
      }
      try {
        await issueMagicLink(serviceOptions(), {
          email,
          ip: clientIp(request, trustProxy),
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
      onRequest: authRequestGuard,
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
      onRequest: authRequestGuard,
      schema: { response: { 200: AuthSessionResponse } },
    },
    async (request, reply) => {
      const raw = getRefreshCookie(request);
      const session = await rotateRefreshToken(serviceOptions(), raw);
      if (session === null) {
        clearRefreshCookie(reply);
        throw new UnauthorizedError('invalid or expired refresh token');
      }
      setRefreshCookie(reply, session);
      return reply.send(sessionBody(session));
    },
  );

  server.post(
    '/v1/auth/logout',
    {
      config: {
        cacheControl: CACHE_CONTROL.privateNoStore,
      },
      onRequest: authRequestGuard,
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

async function allowMagicLink(app: FastifyInstance, email: string, now: Date): Promise<boolean> {
  const key = `apirl:magic:${hashToken(email).toString('hex')}`;

  if (app.hasDecorator('redis')) {
    try {
      const count = await app.redis.incr(key);
      if (count === 1) await app.redis.expire(key, 3600);
      return count <= MAGIC_LINKS_PER_EMAIL_PER_HOUR;
    } catch {
      // Redis is a best-effort limiter; fall through to the process-local map.
    }
  }

  const existing = memoryMagicLinkCounters.get(key);
  if (existing === undefined || existing.resetAt <= now.getTime()) {
    memoryMagicLinkCounters.set(key, { count: 1, resetAt: now.getTime() + 3_600_000 });
    return true;
  }
  existing.count += 1;
  return existing.count <= MAGIC_LINKS_PER_EMAIL_PER_HOUR;
}

/** Spec §10.5 auth tier: 5 requests/min per IP, shared by every `/v1/auth/*` route. */
async function allowAuthRequest(app: FastifyInstance, ip: string, max: number): Promise<boolean> {
  if (max <= 0) return true;
  const key = `apirl:auth:${ip}`;
  const now = Date.now();

  if (app.hasDecorator('redis')) {
    try {
      const count = await app.redis.incr(key);
      if (count === 1) await app.redis.expire(key, 60);
      return count <= max;
    } catch {
      // Degrade to the process-local counter when Redis is unavailable.
    }
  }

  const existing = memoryAuthCounters.get(key);
  if (existing === undefined || existing.resetAt <= now) {
    memoryAuthCounters.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  existing.count += 1;
  return existing.count <= max;
}
