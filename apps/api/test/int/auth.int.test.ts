import { randomUUID } from 'node:crypto';

import { eq, like } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashToken } from '@trendr/core';
import { authTokens, createDb, users, type Connection } from '@trendr/db';
import { SmtpEmailSender } from '@trendr/email';

import { buildApp } from '../../src/app.js';
import type { AuthRoutesOptions } from '../../src/routes/auth.js';

/**
 * Task 7.1 acceptance over real Postgres + Redis + Mailpit: magic links are
 * delivered, single-use, and expire; verification sets `email_verified_at` and
 * returns a 15-minute access JWT; refresh tokens rotate and reuse revokes the
 * whole family; logout revokes it; unknown emails are indistinguishable.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const REDIS_URL = process.env.REDIS_URL ?? '';
const SMTP_URL = process.env.SMTP_URL ?? '';
const MAILPIT_URL = process.env.MAILPIT_URL ?? '';

const JWT_SECRET = 'int-auth-jwt-secret-0123456789abcdef';
const EMAIL_PREFIX = 'int-auth-';
const ADMIN_EMAIL = `${EMAIL_PREFIX}admin@example.test`;
const adminEmails: string[] = [ADMIN_EMAIL];

let connection: Connection;
let redis: Redis;
let app: FastifyInstance;

beforeAll(async () => {
  if (SMTP_URL === '' || MAILPIT_URL === '') {
    throw new Error('auth integration tests require the Mailpit fixture');
  }
  connection = createDb(DATABASE_URL, { max: 2 });
  redis = new Redis(REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  await cleanup();
  app = await buildApp({
    db: connection,
    redis,
    jwtSecret: JWT_SECRET,
    rateLimit: { max: 1_000 },
    metricsToken: 'int-metrics-token',
    auth: {
      emailSender: new SmtpEmailSender('Trendr <digest@localhost>', SMTP_URL),
      webPublicUrl: 'http://localhost:3000',
      adminEmails,
      authRateLimitMax: 1_000,
      cookieSecure: true,
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await cleanup();
  await connection.pool.end();
  redis.disconnect();
});

async function cleanup(): Promise<void> {
  await connection.db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
  const keys = await redis.keys('apirl:*');
  if (keys.length > 0) await redis.del(...keys);
}

function newEmail(label: string): string {
  return `${EMAIL_PREFIX}${label}-${randomUUID()}@example.test`;
}

async function requestLink(email: string): Promise<{ statusCode: number; body: unknown }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/magic-link',
    payload: { email },
  });
  return { statusCode: response.statusCode, body: response.json() };
}

async function latestMessageTo(email: string): Promise<{ Text: string; HTML: string }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=50`);
    const body = (await response.json()) as {
      messages?: { ID: string; To?: { Address?: string }[] }[];
    };
    const match = body.messages?.find((message) =>
      message.To?.some((recipient) => recipient.Address?.toLowerCase() === email),
    );
    if (match !== undefined) {
      const detail = await fetch(`${MAILPIT_URL}/api/v1/message/${match.ID}`);
      return (await detail.json()) as { Text: string; HTML: string };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no Mailpit message arrived for ${email}`);
}

function extractToken(text: string): string {
  const match = /\/auth\/verify#token=([A-Za-z0-9_-]+)/.exec(text);
  if (match?.[1] === undefined) throw new Error('magic-link email had no token');
  return match[1];
}

function refreshCookie(response: Awaited<ReturnType<FastifyInstance['inject']>>): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (header === undefined) throw new Error('response did not set a cookie');
  const value = header.split(';', 1)[0]?.split('=')[1];
  if (value === undefined || value.length === 0) throw new Error('empty refresh cookie');
  return value;
}

async function login(email: string): Promise<{
  accessToken: string;
  cookie: string;
  token: string;
}> {
  const issued = await requestLink(email);
  expect(issued.statusCode, JSON.stringify(issued.body)).toBe(202);
  const message = await latestMessageTo(email);
  const token = extractToken(message.Text);
  const verified = await app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { token },
  });
  expect(verified.statusCode, verified.body).toBe(200);
  const body = verified.json<{ accessToken: string }>();
  return { accessToken: body.accessToken, cookie: refreshCookie(verified), token };
}

function refresh(
  target: FastifyInstance,
  cookie: string | undefined,
  remoteAddress?: string,
): Promise<LightMyRequestResponse> {
  return target.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    headers: {
      ...(cookie === undefined ? {} : { cookie: `dt_refresh=${cookie}` }),
      'x-requested-with': 'trendr',
    },
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
  });
}

async function withAuthApp(
  auth: Partial<AuthRoutesOptions>,
  run: (scoped: FastifyInstance) => Promise<void>,
): Promise<void> {
  const scoped = await buildApp({
    db: connection,
    redis,
    jwtSecret: JWT_SECRET,
    rateLimit: { max: 1_000 },
    auth: {
      emailSender: new SmtpEmailSender('Trendr <digest@localhost>', SMTP_URL),
      webPublicUrl: 'http://localhost:3000',
      adminEmails,
      authRateLimitMax: 1_000,
      cookieSecure: true,
      ...auth,
    },
  });
  try {
    await scoped.ready();
    await run(scoped);
  } finally {
    await scoped.close();
  }
}

function problemType(response: LightMyRequestResponse): string {
  const body: unknown = response.json();
  if (
    typeof body === 'object' &&
    body !== null &&
    'type' in body &&
    typeof body.type === 'string'
  ) {
    return body.type;
  }
  throw new Error(`response was not a problem document: ${response.body}`);
}

describe('magic-link auth and refresh rotation (task 7.1)', () => {
  it('delivers a single-use link, verifies the user, and restores /v1/me', async () => {
    const email = newEmail('flow');
    const issued = await requestLink(email);
    expect(issued).toEqual({ statusCode: 202, body: { ok: true } });

    const unverified = await connection.db
      .select({ verifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.email, email));
    expect(unverified[0]?.verifiedAt).toBeNull();

    const message = await latestMessageTo(email);
    expect(message.Text).toContain('expires in 15 minutes');
    const token = extractToken(message.Text);

    const verified = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify',
      payload: { token },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    const session = verified.json<{
      accessToken: string;
      expiresIn: number;
      user: { id: string; email: string; role: string; emailVerifiedAt: string | null };
    }>();
    expect(session.expiresIn).toBe(900);
    expect(session.accessToken.split('.')).toHaveLength(3);
    expect(session.user).toMatchObject({ email, role: 'user' });
    expect(session.user.emailVerifiedAt).not.toBeNull();

    const cookieHeader = verified.headers['set-cookie'];
    const setCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    expect(setCookie).toContain('dt_refresh=');
    expect(setCookie).toContain('Path=/v1/auth');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Secure');

    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ email: string; displayName: string | null }>()).toMatchObject({
      email,
      displayName: null,
    });

    const anonymousMe = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(anonymousMe.statusCode).toBe(401);

    const reused = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify',
      payload: { token },
    });
    expect(reused.statusCode).toBe(401);

    const cookie = refreshCookie(verified);
    const rotated = await refresh(app, cookie);
    expect(rotated.statusCode, rotated.body).toBe(200);
    const rotatedCookie = refreshCookie(rotated);
    expect(rotatedCookie).not.toBe(cookie);

    // H-2: replaying the immediately previous token is a benign race. It is a
    // typed 401 with no token material, does not revoke the family and must not
    // clear the browser's now-current cookie.
    const oldAgain = await refresh(app, cookie);
    expect(oldAgain.statusCode).toBe(401);
    expect(problemType(oldAgain)).toBe('https://trendr.dev/problems/refresh-rotated');
    expect(oldAgain.headers['retry-after']).toBeDefined();
    expect(oldAgain.headers['set-cookie']).toBeUndefined();

    const metrics = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer int-metrics-token' },
    });
    expect(metrics.body).toMatch(/trendr_auth_refresh_reuse_total\{outcome="grace"\} [1-9]/);

    // The successor issued before the replay is still valid.
    const newestNow = await refresh(app, rotatedCookie);
    expect(newestNow.statusCode, newestNow.body).toBe(200);
    const newestCookie = refreshCookie(newestNow);

    // Outside the 15 s grace, the same replay is theft and revokes the family.
    await connection.db
      .update(authTokens)
      .set({ usedAt: new Date(Date.now() - 16_000) })
      .where(eq(authTokens.tokenHash, hashToken(cookie)));
    const theft = await refresh(app, cookie);
    expect(theft.statusCode).toBe(401);
    expect(problemType(theft)).toBe('https://trendr.dev/problems/unauthorized');

    const metricsAfterTheft = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer int-metrics-token' },
    });
    expect(metricsAfterTheft.body).toMatch(
      /trendr_auth_refresh_reuse_total\{outcome="theft"\} [1-9]/,
    );

    const newestAfterTheft = await refresh(app, newestCookie);
    expect(newestAfterTheft.statusCode).toBe(401);

    const freshNewest = await refresh(app, 'not-a-real-token');
    expect(freshNewest.statusCode).toBe(401);
  });

  it('serializes parallel refreshes with one cookie without revoking the family (H-2)', async () => {
    const { cookie } = await login(newEmail('parallel'));

    const [first, second] = await Promise.all([refresh(app, cookie), refresh(app, cookie)]);
    const responses = [first, second];
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([200, 401]);

    const winner = responses.find((response) => response.statusCode === 200);
    const loser = responses.find((response) => response.statusCode === 401);
    if (winner === undefined || loser === undefined) throw new Error('parallel refresh failed');
    expect(problemType(loser)).toBe('https://trendr.dev/problems/refresh-rotated');
    expect(loser.headers['set-cookie']).toBeUndefined();

    const successor = refreshCookie(winner);
    const retried = await refresh(app, successor);
    expect(retried.statusCode, retried.body).toBe(200);
  });

  it('gives refresh a separate bucket and skips anonymous refreshes (H-3)', async () => {
    const remoteAddress = '198.51.100.201';
    await redis.del(`apirl:auth:${remoteAddress}`);

    const { cookie } = await login(newEmail('refresh-bucket'));
    await withAuthApp(
      { authRateLimitMax: 1, refreshRateLimitMax: 2, refreshIpRateLimitMax: 1_000 },
      async (scoped) => {
        // The strict sign-in bucket is max 1; refresh must not consume it.
        const first = await refresh(scoped, cookie, remoteAddress);
        expect(first.statusCode, first.body).toBe(200);

        // The bucket is keyed by the presented cookie: replaying the rotated
        // cookie is grace on the second hit and rate limited on the third.
        const replay = await refresh(scoped, cookie, remoteAddress);
        expect(replay.statusCode).toBe(401);
        expect(problemType(replay)).toBe('https://trendr.dev/problems/refresh-rotated');

        const blocked = await refresh(scoped, cookie, remoteAddress);
        expect(blocked.statusCode).toBe(429);
        expect(blocked.headers['content-type']).toContain('application/problem+json');

        // A legitimate rotation gets a fresh bucket and still works.
        const successor = refreshCookie(first);
        const rotated = await refresh(scoped, successor, remoteAddress);
        expect(rotated.statusCode, rotated.body).toBe(200);
      },
    );
  });

  it('lets anonymous refresh skip the buckets entirely (H-3)', async () => {
    const remoteAddress = '198.51.100.202';
    await withAuthApp({ refreshRateLimitMax: 1, refreshIpRateLimitMax: 1 }, async (scoped) => {
      for (let index = 0; index < 3; index += 1) {
        const anonymous = await refresh(scoped, undefined, remoteAddress);
        expect(anonymous.statusCode).toBe(401);
      }

      const { cookie } = await login(newEmail('anonymous-skip'));
      const first = await refresh(scoped, cookie, remoteAddress);
      expect(first.statusCode, first.body).toBe(200);
    });
  });

  it('caps random-cookie floods with a coarse per-IP refresh guard (H-3)', async () => {
    const remoteAddress = '198.51.100.203';
    await redis.del(`apirl:auth:refresh:ip:${remoteAddress}`);
    await withAuthApp({ refreshRateLimitMax: 60, refreshIpRateLimitMax: 2 }, async (scoped) => {
      for (let index = 0; index < 2; index += 1) {
        const response = await refresh(scoped, `random-${randomUUID()}`, remoteAddress);
        expect(response.statusCode).toBe(401);
      }
      const blocked = await refresh(scoped, `random-${randomUUID()}`, remoteAddress);
      expect(blocked.statusCode).toBe(429);
    });
  });

  it('patches and clears the display name for the authenticated user', async () => {
    const { accessToken } = await login(newEmail('profile'));

    const patched = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { displayName: '  Ada Lovelace  ' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json<{ displayName: string }>().displayName).toBe('Ada Lovelace');

    const cleared = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { displayName: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<{ displayName: string | null }>().displayName).toBeNull();
  });

  it('promotes ADMIN_EMAILS and revokes the family on logout', async () => {
    const { accessToken, cookie } = await login(ADMIN_EMAIL);
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.json<{ role: string }>().role).toBe('admin');

    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: `dt_refresh=${cookie}`, 'x-requested-with': 'trendr' },
    });
    expect(logout.statusCode).toBe(204);

    const refresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: `dt_refresh=${cookie}`, 'x-requested-with': 'trendr' },
    });
    expect(refresh.statusCode).toBe(401);
  });

  it('demotes a stored admin when the address leaves ADMIN_EMAILS', async () => {
    const { accessToken, cookie } = await login(ADMIN_EMAIL);
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.json<{ role: string }>().role).toBe('admin');

    adminEmails.splice(0, adminEmails.length);
    try {
      // A refresh rotates the session and re-evaluates the authoritative list.
      const refreshed = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { cookie: `dt_refresh=${cookie}`, 'x-requested-with': 'trendr' },
      });
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      expect(refreshed.json<{ user: { role: string } }>().user.role).toBe('user');

      // A fresh magic-link flow also issues a user token after demotion.
      const demoted = await login(ADMIN_EMAIL);
      const demotedMe = await app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${demoted.accessToken}` },
      });
      expect(demotedMe.json<{ role: string }>().role).toBe('user');
    } finally {
      adminEmails.push(ADMIN_EMAIL);
    }
  });

  it('rejects an expired magic link', async () => {
    const email = newEmail('expired');
    const issued = await requestLink(email);
    expect(issued.statusCode).toBe(202);
    const message = await latestMessageTo(email);
    const token = extractToken(message.Text);

    const [user] = await connection.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    if (user === undefined) throw new Error('expired-link user missing');
    await connection.db
      .update(authTokens)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(authTokens.userId, user.id));

    const verified = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify',
      payload: { token },
    });
    expect(verified.statusCode).toBe(401);
  });

  it('limits magic-link issuance per email without revealing account existence', async () => {
    const email = newEmail('limit');
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      statuses.push((await requestLink(email)).statusCode);
    }
    expect(statuses).toEqual([202, 202, 202, 429]);

    const unknown = await requestLink(newEmail('unknown'));
    expect(unknown).toEqual({ statusCode: 202, body: { ok: true } });
  });
});
