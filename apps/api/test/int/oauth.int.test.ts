import { randomBytes, randomUUID } from 'node:crypto';

import { eq, like } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OAUTH_STATE_COOKIE, type OAuthProvider } from '@trendr/core';
import {
  authTokens,
  createDb,
  findOAuthAccount,
  insertAuthToken,
  linkOAuthAccount,
  users,
  type Connection,
} from '@trendr/db';
import type { EmailSender } from '@trendr/email';

import { buildApp } from '../../src/app.js';
import type { OAuthIdentity, OAuthProviderClient } from '../../src/services/oauth/providers.js';

/**
 * ADR-0034 acceptance over real Postgres + Redis: start stores the PKCE
 * verifier in Redis behind a hashed state, the callback consumes it once,
 * provider identities link to users, unverified magic-link placeholders are
 * claimed and their stale links revoked, and the normal rotating refresh
 * cookie is the only session artifact the browser receives.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const REDIS_URL = process.env.REDIS_URL ?? '';
const WEB_URL = 'http://localhost:3000';
const JWT_SECRET = 'int-oauth-jwt-secret-0123456789abcdef';
const EMAIL_PREFIX = 'int-oauth-api-';
const ADMIN_EMAIL = `${EMAIL_PREFIX}admin@example.test`;

const emailSender: EmailSender = { send: () => Promise.resolve({ id: 'int-oauth' }) };

let connection: Connection;
let redis: Redis;
let app: FastifyInstance;
let identity: Record<OAuthProvider, OAuthIdentity>;

beforeAll(async () => {
  connection = createDb(DATABASE_URL, { max: 2 });
  redis = new Redis(REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  await cleanup();
  identity = {
    google: {
      providerAccountId: 'google-initial',
      email: newEmail('initial-google'),
      emailVerified: true,
      displayName: 'Initial Google',
    },
    github: {
      providerAccountId: 'github-initial',
      email: newEmail('initial-github'),
      emailVerified: true,
      displayName: 'Initial GitHub',
    },
  };
  app = await buildApp({
    db: connection,
    redis,
    jwtSecret: JWT_SECRET,
    rateLimit: { max: 10_000 },
    metricsToken: 'int-metrics-token',
    auth: {
      emailSender,
      webPublicUrl: WEB_URL,
      adminEmails: [ADMIN_EMAIL],
      authRateLimitMax: 10_000,
      refreshRateLimitMax: 10_000,
      refreshIpRateLimitMax: 10_000,
      cookieSecure: true,
    },
    oauth: {
      providers: { google: fakeProvider('google'), github: fakeProvider('github') },
      webPublicUrl: WEB_URL,
      adminEmails: [ADMIN_EMAIL],
      cookieSecure: true,
      cookieSameSite: 'lax',
      oauthRateLimitMax: 10_000,
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
  const keys = await redis.keys('oauth:state:*');
  if (keys.length > 0) await redis.del(...keys);
  const buckets = await redis.keys('apirl:oauth:*');
  if (buckets.length > 0) await redis.del(...buckets);
}

function newEmail(label: string): string {
  return `${EMAIL_PREFIX}${label}-${randomUUID()}@example.test`;
}

function fakeProvider(id: OAuthProvider): OAuthProviderClient {
  return {
    id,
    label: id === 'google' ? 'Google' : 'GitHub',
    authorizationUrl(input) {
      const url = new URL(`https://${id}.example.test/authorize`);
      url.searchParams.set('state', input.state);
      url.searchParams.set('code_challenge', input.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      if (input.nonce !== null) url.searchParams.set('nonce', input.nonce);
      return url.toString();
    },
    fetchIdentity: () => Promise.resolve(identity[id]),
  };
}

function setCookies(response: LightMyRequestResponse): string[] {
  const raw = response.headers['set-cookie'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function cookiePair(response: LightMyRequestResponse, name: string): string {
  const header = setCookies(response).find((entry) => entry.startsWith(`${name}=`));
  if (header === undefined) throw new Error(`response did not set ${name}`);
  const pair = header.split(';', 1)[0];
  if (pair === undefined) throw new Error(`malformed ${name} cookie`);
  return pair;
}

function cookieHeader(response: LightMyRequestResponse, name: string): string {
  const header = setCookies(response).find((entry) => entry.startsWith(`${name}=`));
  if (header === undefined) throw new Error(`response did not set ${name}`);
  return header;
}

interface StartedFlow {
  state: string;
  cookie: string;
  /** Full `Set-Cookie` header, for attribute assertions. */
  setCookie: string;
  authorizationUrl: URL;
}

async function start(
  provider: OAuthProvider,
  returnTo?: string,
  target: FastifyInstance = app,
): Promise<StartedFlow> {
  const query = returnTo === undefined ? '' : `?return_to=${encodeURIComponent(returnTo)}`;
  const response = await target.inject({
    method: 'GET',
    url: `/v1/auth/oauth/${provider}/start${query}`,
  });
  expect(response.statusCode, response.body).toBe(302);
  const location = response.headers.location;
  if (typeof location !== 'string') throw new Error('start did not redirect');
  const authorizationUrl = new URL(location);
  const state = authorizationUrl.searchParams.get('state');
  if (state === null) throw new Error('authorization URL had no state');
  return {
    state,
    cookie: cookiePair(response, OAUTH_STATE_COOKIE),
    setCookie: cookieHeader(response, OAUTH_STATE_COOKIE),
    authorizationUrl,
  };
}

function callback(
  provider: OAuthProvider,
  flow: StartedFlow,
  overrides: { code?: string | null; state?: string; cookie?: string; extra?: string } = {},
): Promise<LightMyRequestResponse> {
  const code = overrides.code === undefined ? 'auth-code' : overrides.code;
  const state = overrides.state ?? flow.state;
  const params = new URLSearchParams();
  if (code !== null) params.set('code', code);
  params.set('state', state);
  if (overrides.extra !== undefined) params.set('error', overrides.extra);
  return app.inject({
    method: 'GET',
    url: `/v1/auth/oauth/${provider}/callback?${params.toString()}`,
    headers: { cookie: overrides.cookie ?? flow.cookie },
  });
}

function redirectError(response: LightMyRequestResponse): string | null {
  const location = response.headers.location;
  if (typeof location !== 'string') return null;
  return new URL(location).searchParams.get('error');
}

async function refresh(cookie: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    headers: { cookie, 'x-requested-with': 'trendr' },
  });
}

describe('OAuth start', () => {
  it('advertises only configured providers', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/auth/oauth/providers' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      providers: [
        { id: 'google', label: 'Google' },
        { id: 'github', label: 'GitHub' },
      ],
    });
  });

  it('stores only the state in the cookie and the verifier in Redis', async () => {
    const flow = await start('google', '/items/42?tab=scores');

    expect(flow.authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.authorizationUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.authorizationUrl.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const stateCookie = flow.setCookie;
    expect(stateCookie).toContain('HttpOnly');
    expect(stateCookie).toContain('Secure');
    expect(stateCookie).toContain('SameSite=Lax');
    expect(stateCookie).toContain('Path=/v1/auth/oauth');
    expect(stateCookie).not.toContain('code_verifier');
    expect(stateCookie).not.toContain('challenge');

    const keys = await redis.keys('oauth:state:*');
    expect(keys).toHaveLength(1);
    const raw = await redis.get(keys[0] ?? '');
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(flow.state);
    const payload = JSON.parse(raw ?? '{}') as {
      provider: string;
      codeVerifier: string;
      nonce: string;
      returnTo: string;
    };
    expect(payload.provider).toBe('google');
    expect(payload.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(payload.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(payload.returnTo).toBe('/items/42?tab=scores');
    expect(flow.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('rejects an unknown provider', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/auth/oauth/twitter/start' });
    expect(response.statusCode).toBe(400);
  });

  it('hides providers that are not configured', async () => {
    const scoped = await buildApp({
      db: connection,
      redis,
      jwtSecret: JWT_SECRET,
      rateLimit: { max: 10_000 },
      oauth: {
        providers: { google: fakeProvider('google') },
        webPublicUrl: WEB_URL,
        cookieSecure: true,
      },
    });
    try {
      const providers = await scoped.inject({ method: 'GET', url: '/v1/auth/oauth/providers' });
      expect(providers.json()).toEqual({ providers: [{ id: 'google', label: 'Google' }] });
      const github = await scoped.inject({
        method: 'GET',
        url: '/v1/auth/oauth/github/start',
      });
      expect(github.statusCode).toBe(404);
    } finally {
      await scoped.close();
    }
  });
});

describe('OAuth callback', () => {
  it('creates a verified user, links the identity and issues the refresh cookie', async () => {
    const email = newEmail('create');
    identity.google = {
      providerAccountId: `google-${randomUUID()}`,
      email,
      emailVerified: true,
      displayName: 'Ada Lovelace',
    };

    const flow = await start('google', '/dashboard');
    const response = await callback('google', flow);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${WEB_URL}/auth/oauth/callback?return_to=%2Fdashboard`);

    const refreshCookie = cookieHeader(response, 'dt_refresh');
    expect(refreshCookie).toContain('HttpOnly');
    expect(refreshCookie).toContain('Secure');
    expect(refreshCookie).toContain('SameSite=Lax');
    expect(refreshCookie).toContain('Path=/v1/auth');
    const stateCookie = cookieHeader(response, OAUTH_STATE_COOKIE);
    expect(stateCookie).toContain('Max-Age=0');

    const refreshed = await refresh(cookiePair(response, 'dt_refresh'));
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const session = refreshed.json<{
      accessToken: string;
      user: {
        id: string;
        email: string;
        displayName: string | null;
        emailVerifiedAt: string | null;
        lastLoginAt: string | null;
      };
    }>();
    expect(session.user).toMatchObject({
      email,
      displayName: 'Ada Lovelace',
      emailVerifiedAt: expect.any(String) as unknown,
      lastLoginAt: expect.any(String) as unknown,
    });
    expect(session.accessToken.length).toBeGreaterThan(20);

    const account = await findOAuthAccount(
      connection.db,
      'google',
      identity.google.providerAccountId,
    );
    expect(account).toMatchObject({
      userId: session.user.id,
      provider: 'google',
      providerEmail: email,
    });
    expect(account?.lastLoginAt).not.toBeNull();
  });

  it('consumes the state exactly once', async () => {
    identity.github = {
      providerAccountId: `github-${randomUUID()}`,
      email: newEmail('replay'),
      emailVerified: true,
      displayName: null,
    };
    const flow = await start('github');

    const first = await callback('github', flow);
    expect(first.statusCode).toBe(302);
    expect(redirectError(first)).toBeNull();

    const replay = await callback('github', flow);
    expect(replay.statusCode).toBe(302);
    expect(redirectError(replay)).toBe('invalid_state');
  });

  it('rejects a missing or mismatched state cookie', async () => {
    const flow = await start('github');

    const missing = await callback('github', flow, { cookie: '' });
    expect(redirectError(missing)).toBe('invalid_state');

    const mismatched = await callback('github', flow, {
      cookie: `${OAUTH_STATE_COOKIE}=not-the-state`,
    });
    expect(redirectError(mismatched)).toBe('invalid_state');

    // The mismatch did not consume the real state.
    identity.github = {
      providerAccountId: `github-${randomUUID()}`,
      email: newEmail('mismatch-recovery'),
      emailVerified: true,
      displayName: null,
    };
    const recovered = await callback('github', flow);
    expect(redirectError(recovered)).toBeNull();
  });

  it('maps provider cancellation and missing codes to stable error codes', async () => {
    const denied = await start('google');
    const cancelled = await app.inject({
      method: 'GET',
      url: `/v1/auth/oauth/google/callback?error=access_denied&state=${encodeURIComponent(denied.state)}`,
      headers: { cookie: denied.cookie },
    });
    expect(redirectError(cancelled)).toBe('access_denied');

    const replay = await callback('google', denied);
    expect(redirectError(replay)).toBe('invalid_state');

    const missingCode = await start('google');
    const noCode = await callback('google', missingCode, { code: null });
    expect(redirectError(noCode)).toBe('invalid_request');
  });

  it('rejects an identity the provider did not prove', async () => {
    identity.google = {
      providerAccountId: `google-${randomUUID()}`,
      email: newEmail('unverified'),
      emailVerified: false,
      displayName: null,
    };
    const flow = await start('google');
    const response = await callback('google', flow);
    expect(redirectError(response)).toBe('email_unverified');
  });

  it('sanitises return_to instead of redirecting off-site', async () => {
    identity.google = {
      providerAccountId: `google-${randomUUID()}`,
      email: newEmail('open-redirect'),
      emailVerified: true,
      displayName: null,
    };
    const flow = await start('google', 'https://evil.example/steal');
    const response = await callback('google', flow);
    expect(response.headers.location).toBe(`${WEB_URL}/auth/oauth/callback?return_to=%2Fdashboard`);
  });

  it('claims an unverified magic-link placeholder and revokes its stale links', async () => {
    const email = newEmail('claim');
    const [placeholder] = await connection.db
      .insert(users)
      .values({ email, displayName: null, role: 'user' })
      .returning();
    if (placeholder === undefined) throw new Error('placeholder insert failed');
    const staleLink = await insertAuthToken(connection.db, {
      userId: placeholder.id,
      kind: 'magic_link',
      tokenHash: randomBytes(32),
      expiresAt: new Date(Date.now() + 60_000),
    });

    identity.google = {
      providerAccountId: `google-${randomUUID()}`,
      email,
      emailVerified: true,
      displayName: 'Provider Name',
    };
    const flow = await start('google');
    const response = await callback('google', flow);
    expect(redirectError(response)).toBeNull();

    const [claimed] = await connection.db.select().from(users).where(eq(users.id, placeholder.id));
    expect(claimed?.emailVerifiedAt).not.toBeNull();
    expect(claimed?.displayName).toBe('Provider Name');
    expect(claimed?.lastLoginAt).not.toBeNull();

    const [stale] = await connection.db
      .select({ revokedAt: authTokens.revokedAt })
      .from(authTokens)
      .where(eq(authTokens.id, staleLink.id));
    expect(stale?.revokedAt).not.toBeNull();
  });

  it('recomputes the stored role from ADMIN_EMAILS', async () => {
    const [placeholder] = await connection.db
      .insert(users)
      .values({ email: ADMIN_EMAIL, displayName: null, role: 'user' })
      .returning();
    if (placeholder === undefined) throw new Error('admin placeholder insert failed');

    identity.github = {
      providerAccountId: `github-${randomUUID()}`,
      email: ADMIN_EMAIL,
      emailVerified: true,
      displayName: 'Admin',
    };
    const flow = await start('github');
    expect(redirectError(await callback('github', flow))).toBeNull();

    const [updated] = await connection.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, placeholder.id));
    expect(updated?.role).toBe('admin');
  });

  it('keeps the provider account stable when the provider email changes', async () => {
    const originalEmail = newEmail('stable-owner');
    const changedEmail = newEmail('stable-changed');
    const [user] = await connection.db
      .insert(users)
      .values({ email: originalEmail, emailVerifiedAt: new Date(), role: 'user' })
      .returning();
    if (user === undefined) throw new Error('user insert failed');
    const providerAccountId = `google-${randomUUID()}`;
    await linkOAuthAccount(connection.db, {
      userId: user.id,
      provider: 'google',
      providerAccountId,
      providerEmail: originalEmail,
      lastLoginAt: new Date(),
    });

    identity.google = {
      providerAccountId,
      email: changedEmail,
      emailVerified: true,
      displayName: null,
    };
    const flow = await start('google');
    const response = await callback('google', flow);
    expect(redirectError(response)).toBeNull();

    const account = await findOAuthAccount(connection.db, 'google', providerAccountId);
    expect(account?.userId).toBe(user.id);
    expect(account?.providerEmail).toBe(changedEmail);
    const [stillOriginal] = await connection.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, user.id));
    expect(stillOriginal?.email).toBe(originalEmail);
  });

  it('rejects a second provider account for the same Trendr user', async () => {
    const email = newEmail('conflict');
    const [user] = await connection.db
      .insert(users)
      .values({ email, emailVerifiedAt: new Date(), role: 'user' })
      .returning();
    if (user === undefined) throw new Error('user insert failed');
    await linkOAuthAccount(connection.db, {
      userId: user.id,
      provider: 'google',
      providerAccountId: `google-${randomUUID()}`,
      providerEmail: email,
      lastLoginAt: new Date(),
    });

    identity.google = {
      providerAccountId: `google-${randomUUID()}`,
      email,
      emailVerified: true,
      displayName: null,
    };
    const flow = await start('google');
    const response = await callback('google', flow);
    expect(redirectError(response)).toBe('account_conflict');
  });

  it('applies the dedicated OAuth limiter instead of the 5/min auth guard', async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const scoped = await buildApp({
      db: connection,
      redis,
      jwtSecret: JWT_SECRET,
      rateLimit: { max: 10_000 },
      oauth: {
        providers: { google: fakeProvider('google') },
        webPublicUrl: WEB_URL,
        cookieSecure: true,
        oauthRateLimitMax: 2,
      },
    });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const response = await scoped.inject({
          method: 'GET',
          url: '/v1/auth/oauth/google/start',
          remoteAddress: ip,
        });
        statuses.push(response.statusCode);
      }
      expect(statuses).toEqual([302, 302, 429]);
    } finally {
      await scoped.close();
      await redis.del(`apirl:oauth:${ip}`);
    }
  });
});
