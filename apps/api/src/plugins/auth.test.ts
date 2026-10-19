import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { ForbiddenError, JWT_AUDIENCE, JWT_ISSUER, UnauthorizedError } from '@trendr/core';

import type { AuthenticatedApiKey } from './api-key.js';
import { registerAuth, requireAdmin, type AuthenticatedUser } from './auth.js';

/**
 * Task 4.6 unit coverage for the §10.5 token/admin contract that the int test
 * cannot pin precisely: the signing defaults (iss/aud/15 min), issuer and
 * audience enforcement, and the guard's promise-returning contract.
 */

const SECRET = 'unit-auth-secret-0123456789abcdef';
const TOKEN = {
  user: { sub: '11111111-1111-4111-8111-111111111111', role: 'user' as const },
  admin: { sub: '22222222-2222-4222-8222-222222222222', role: 'admin' as const },
};
/** The decorated `request.authUser` shape (JWT `sub` becomes `id`). */
const AUTH_USER: Record<keyof typeof TOKEN, AuthenticatedUser> = {
  user: { id: TOKEN.user.sub, role: 'user' },
  admin: { id: TOKEN.admin.sub, role: 'admin' },
};

async function buildAuthApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(registerAuth, { secret: SECRET });
  app.get('/whoami', (request) => ({ user: request.authUser ?? null }));
  app.get('/admin', { onRequest: requireAdmin }, () => ({ ok: true }));
  await app.ready();
  return app;
}

function fakeRequest(parts: {
  apiKey?: AuthenticatedApiKey;
  authUser?: AuthenticatedUser;
}): FastifyRequest {
  return parts as unknown as FastifyRequest;
}

const READ_KEY: AuthenticatedApiKey = {
  id: '33333333-3333-4333-8333-333333333333',
  userId: TOKEN.user.sub,
  scopes: ['read'],
  rateLimitPerMin: 120,
};
const ADMIN_KEY: AuthenticatedApiKey = { ...READ_KEY, scopes: ['read', 'admin'] };

describe('requireAdmin (spec §10.1/§10.5)', () => {
  it('returns a promise and stalls nothing when it passes (Fastify hook contract)', async () => {
    const pending = requireAdmin(fakeRequest({ authUser: AUTH_USER.admin }));
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toBeUndefined();
  });

  it('rejects anonymous callers with 401', async () => {
    await expect(requireAdmin(fakeRequest({}))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects authenticated non-admins with 403', async () => {
    await expect(requireAdmin(fakeRequest({ authUser: AUTH_USER.user }))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(requireAdmin(fakeRequest({ apiKey: READ_KEY }))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('accepts admin-scope keys and admin JWTs', async () => {
    await expect(requireAdmin(fakeRequest({ apiKey: ADMIN_KEY }))).resolves.toBeUndefined();
    await expect(requireAdmin(fakeRequest({ authUser: AUTH_USER.admin }))).resolves.toBeUndefined();
  });
});

describe('registerAuth (spec §10.5, §15)', () => {
  it('signs with the spec defaults: iss, aud and the 15-minute access TTL', async () => {
    const app = await buildAuthApp();
    try {
      const token = app.jwt.sign(TOKEN.user);
      const claims = app.jwt.decode<{ iss: string; aud: string; iat: number; exp: number }>(token);
      expect(claims?.iss).toBe(JWT_ISSUER);
      expect(claims?.aud).toBe(JWT_AUDIENCE);
      expect(claims?.exp).toBeDefined();
      expect(claims?.iat).toBeDefined();
      // JWT_ACCESS_TTL ('15m', spec §10.5) — seconds since the sign defaults.
      expect((claims?.exp ?? 0) - (claims?.iat ?? 0)).toBe(15 * 60);
    } finally {
      await app.close();
    }
  });

  it('decorates request.authUser for valid bearer tokens only', async () => {
    const app = await buildAuthApp();
    try {
      const valid = await app.inject({
        method: 'GET',
        url: '/whoami',
        headers: { authorization: `Bearer ${app.jwt.sign(TOKEN.admin)}` },
      });
      expect(valid.statusCode).toBe(200);
      expect(valid.json<{ user: unknown }>().user).toEqual(AUTH_USER.admin);

      const anonymous = await app.inject({ method: 'GET', url: '/whoami' });
      expect(anonymous.statusCode).toBe(200);
      expect(anonymous.json<{ user: unknown }>().user).toBeNull();

      const malformed = await app.inject({
        method: 'GET',
        url: '/whoami',
        headers: { authorization: 'Bearer not-a-jwt' },
      });
      expect(malformed.statusCode).toBe(401);

      const basic = await app.inject({
        method: 'GET',
        url: '/whoami',
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      });
      expect(basic.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects tokens with a foreign issuer or audience', async () => {
    const app = await buildAuthApp();
    try {
      const foreignIssuer = app.jwt.sign(TOKEN.admin, { iss: 'not-trendr' });
      const foreignAudience = app.jwt.sign(TOKEN.admin, { aud: 'not-trendr-api' });
      for (const token of [foreignIssuer, foreignAudience]) {
        const response = await app.inject({
          method: 'GET',
          url: '/whoami',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it('guards a route: user JWT → 403, admin JWT → 200', async () => {
    const app = await buildAuthApp();
    try {
      const user = await app.inject({
        method: 'GET',
        url: '/admin',
        headers: { authorization: `Bearer ${app.jwt.sign(TOKEN.user)}` },
      });
      expect(user.statusCode).toBe(403);

      const admin = await app.inject({
        method: 'GET',
        url: '/admin',
        headers: { authorization: `Bearer ${app.jwt.sign(TOKEN.admin)}` },
      });
      expect(admin.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
