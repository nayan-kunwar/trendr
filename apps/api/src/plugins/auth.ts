import jwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';

import {
  ForbiddenError,
  JWT_ACCESS_TTL,
  JWT_AUDIENCE,
  JWT_ISSUER,
  UnauthorizedError,
} from '@trendr/core';

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
}

export const registerAuth = fp<AuthPluginOptions>(
  async (app, { secret }) => {
    await app.register(jwt, {
      secret,
      sign: { iss: JWT_ISSUER, aud: JWT_AUDIENCE, expiresIn: JWT_ACCESS_TTL },
      verify: { allowedIss: JWT_ISSUER, allowedAud: JWT_AUDIENCE },
    });

    app.addHook('onRequest', async (request) => {
      const header = request.headers.authorization;
      if (header === undefined) {
        return;
      }
      const [scheme, token] = header.split(' ', 2);
      if (scheme !== 'Bearer' || token === undefined || token.length === 0) {
        throw new UnauthorizedError('invalid authorization header');
      }

      let verified: unknown;
      try {
        verified = await request.jwtVerify();
      } catch {
        throw new UnauthorizedError('invalid or expired access token');
      }
      const claims = verified as { sub?: unknown; role?: unknown };
      if (typeof claims.sub !== 'string' || (claims.role !== 'admin' && claims.role !== 'user')) {
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
 * Deliberately `async` although there is nothing to await: Fastify's hook
 * runner only advances the chain when a hook returns a promise or calls
 * `done`, so a synchronous `(request) => void` guard would stall every
 * authorised request forever (observed while building task 4.6).
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Fastify hook contract, see comment.
export async function requireAdmin(request: FastifyRequest): Promise<void> {
  if (request.apiKey !== undefined) {
    if (!request.apiKey.scopes.includes('admin')) {
      throw new ForbiddenError('admin scope required');
    }
    return;
  }
  if (request.authUser === undefined) {
    throw new UnauthorizedError('admin authentication required');
  }
  if (request.authUser.role !== 'admin') {
    throw new ForbiddenError('admin role required');
  }
}
