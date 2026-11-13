import jwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';

import {
  ForbiddenError,
  JWT_ACCESS_TTL_SECONDS,
  JWT_AUDIENCE,
  JWT_ISSUER,
  RateLimitedError,
  UnauthorizedError,
} from '@trendr/core';
import { findUserById } from '@trendr/db';

import { authFailureBudgetExhausted, noteAuthFailure } from './auth-failures.js';

/**
 * Spec §10.5 — access-token authentication. Every `Authorization: Bearer`
 * request is verified in an `onRequest` hook (issuer/audience/expiry), so the
 * rate limiter can pick the §10.5 user/admin tier and the admin routes can
 * authorise before any handler runs. Task 7.1 adds the magic-link issuance on
 * top of this verification; the signing defaults here are already the §10.5
 * ones (15-minute tokens, `iss=trendr`, `aud=trendr-api`).
 */

export type AuthRole = 'user' | 'admin';

export interface AuthenticatedUser {
  /** JWT `sub` — the `users.id` UUID. */
  id: string;
  role: AuthRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Present when a valid access JWT authenticated the request (spec §10.5). */
    authUser?: AuthenticatedUser;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: AuthRole };
    user: { sub: string; role: AuthRole; iat?: number; exp?: number };
  }
}

export interface AuthPluginOptions {
  /** JWT_SECRET (spec §15). */
  secret: string;
  /** Access-token lifetime in seconds (env JWT_ACCESS_TTL_SEC, spec default 900). */
  accessTtlSeconds?: number;
  /** Trusted-proxy flags for the failed-credential guard. */
  trustProxy?: boolean;
  trustCfConnectingIp?: boolean;
  /** Rejected bearer tokens allowed per IP per window; 0 disables the guard (tests). */
  failureMax?: number;
  /** Failed-credential window in seconds. */
  failureWindowSeconds?: number;
}

export const registerAuth = fp<AuthPluginOptions>(
  async (
    app,
    {
      secret,
      accessTtlSeconds,
      trustProxy = false,
      trustCfConnectingIp = false,
      failureMax,
      failureWindowSeconds,
    },
  ) => {
    const failureOptions = {
      trustProxy,
      trustCfConnectingIp,
      ...(failureMax === undefined ? {} : { max: failureMax }),
      ...(failureWindowSeconds === undefined ? {} : { windowSeconds: failureWindowSeconds }),
    } as const;
    await app.register(jwt, {
      secret,
      sign: {
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
        expiresIn: accessTtlSeconds ?? JWT_ACCESS_TTL_SECONDS,
      },
      verify: { allowedIss: JWT_ISSUER, allowedAud: JWT_AUDIENCE },
    });

    app.addHook('onRequest', async (request) => {
      const header = request.headers.authorization;
      if (header === undefined) {
        return;
      }
      // Spec §14.5: `/metrics` is guarded by METRICS_TOKEN, not a JWT, and
      // Prometheus sends `Authorization: Bearer <METRICS_TOKEN>` — verifying
      // that as an access token would make every scrape 401 (observed against
      // the Compose stack, where jwtSecret is always set).
      if (request.url.split('?', 1)[0] === '/metrics') {
        return;
      }

      // This instance-level hook runs before the route-level rate limiter;
      // reject invalid credentials before spending a signature verification.
      if (await authFailureBudgetExhausted(app, request, 'bearer', failureOptions)) {
        throw new RateLimitedError('too many invalid access tokens; try again in a minute');
      }

      const [scheme, token] = header.split(' ', 2);
      if (scheme !== 'Bearer' || token === undefined || token.length === 0) {
        await noteAuthFailure(app, request, 'bearer', failureOptions);
        throw new UnauthorizedError('invalid authorization header');
      }

      let verified: unknown;
      try {
        verified = await request.jwtVerify();
      } catch {
        await noteAuthFailure(app, request, 'bearer', failureOptions);
        throw new UnauthorizedError('invalid or expired access token');
      }
      const claims = verified as { sub?: unknown; role?: unknown };
      if (typeof claims.sub !== 'string' || (claims.role !== 'admin' && claims.role !== 'user')) {
        await noteAuthFailure(app, request, 'bearer', failureOptions);
        throw new UnauthorizedError('invalid access token claims');
      }
      request.authUser = { id: claims.sub, role: claims.role };
    });
  },
  { name: 'auth' },
);

/**
 * Spec §10.1/§10.5 — admin authorisation for `/v1/admin/*`: an `admin`-scope
 * API key or a JWT whose role claim is `admin`. Missing credentials are 401;
 * authenticated non-admins are 403 (the task 4.6 acceptance).
 *
 * `async` is required both by Fastify's hook contract (a synchronous
 * `(request) => void` guard would stall the chain) and by the optional stored-
 * role lookup below.
 */
export async function requireAdmin(request: FastifyRequest): Promise<void> {
  if (request.apiKey !== undefined) {
    if (!request.apiKey.scopes.includes('admin')) {
      throw new ForbiddenError('admin scope required');
    }
    // The key carries an explicit scope, but the owning account remains the
    // authority. A demoted admin's key stops working immediately.
    if (request.server.hasDecorator('db')) {
      const user = await findUserById(request.server.db, request.apiKey.userId);
      if (user === null) {
        throw new UnauthorizedError('API-key owner no longer exists');
      }
      if (user.role !== 'admin') {
        throw new ForbiddenError('admin role required');
      }
    }
    return;
  }
  if (request.authUser === undefined) {
    throw new UnauthorizedError('admin authentication required');
  }
  if (request.authUser.role !== 'admin') {
    throw new ForbiddenError('admin role required');
  }

  // A JWT role claim is a 15-minute snapshot. Re-read the account when the
  // deployment has a database so removing an admin (or deleting the account)
  // takes effect immediately rather than waiting for the access token to
  // expire. Unit tests that build the auth plugin without a database fall back
  // to the claim.
  if (request.server.hasDecorator('db')) {
    const user = await findUserById(request.server.db, request.authUser.id);
    if (user === null) {
      throw new UnauthorizedError('admin account no longer exists');
    }
    if (user.role !== 'admin') {
      throw new ForbiddenError('admin role required');
    }
  }
}

/**
 * Spec §10.5 — user-authenticated surfaces (`/v1/me/*`, watchlists, alerts,
 * digest preferences, API keys). API keys are deliberately not accepted here:
 * account management requires a live JWT session.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Fastify hook contract, see requireAdmin.
export async function requireUser(request: FastifyRequest): Promise<void> {
  if (request.authUser === undefined) {
    throw new UnauthorizedError('authentication required');
  }
}
