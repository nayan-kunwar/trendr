import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { describe, expect, it } from 'vitest';

import { createGithubClient, createGoogleClient } from './providers.js';
import { OAuthFlowError } from './errors.js';

/**
 * ADR-0034 — provider adapters are tested against recorded shapes of the real
 * APIs: Google's OIDC ID token (signature, iss/aud/exp/nonce, email_verified)
 * and GitHub's `/user` + `/user/emails` pair (primary + verified only).
 */

const CLIENT_ID = 'client-id.apps.example.test';
const CLIENT_SECRET = 'client-secret';
const REDIRECT_URI = 'https://api.example.test/v1/auth/oauth/google/callback';
const TOKEN_ENDPOINT = 'https://provider.example.test/token';
const CODE_VERIFIER = 'v'.repeat(43);

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function fetchRecorder(handler: (url: string) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? undefined });
    return handler(url);
  };
  return { fetch: fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Narrow a recorded fetch body without relying on `String(object)`. */
function tokenRequestBody(call: FetchCall | undefined): URLSearchParams {
  const body = call?.init?.body;
  if (typeof body !== 'string') {
    throw new Error('token request body was not a string');
  }
  return new URLSearchParams(body);
}

async function googleFixture(
  overrides: {
    email?: string;
    emailVerified?: boolean;
    nonce?: string;
    issuer?: string;
    audience?: string;
    expiresIn?: string;
    subject?: string;
    name?: string;
  } = {},
): Promise<{
  idToken: string;
  jwks: JWTVerifyGetKey;
}> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const jwks = createLocalJWKSet({
    keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }],
  });
  const idToken = await new SignJWT({
    email: overrides.email ?? 'ada@example.test',
    email_verified: overrides.emailVerified ?? true,
    nonce: overrides.nonce ?? 'nonce-value',
    name: overrides.name ?? 'Ada Lovelace',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(overrides.issuer ?? 'https://accounts.google.com')
    .setAudience(overrides.audience ?? CLIENT_ID)
    .setSubject(overrides.subject ?? 'google-subject-1')
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? '5m')
    .sign(privateKey);
  return { idToken, jwks };
}

describe('Google provider adapter', () => {
  it('builds an S256 authorization URL with a nonce and OIDC scopes', () => {
    const client = createGoogleClient({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      jwks: createLocalJWKSet({ keys: [] }),
    });
    const url = new URL(
      client.authorizationUrl({ state: 'state-1', codeChallenge: 'challenge-1', nonce: 'nonce-1' }),
    );

    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBe('nonce-1');
  });

  it('exchanges the code with the verifier and verifies the ID token', async () => {
    const fixture = await googleFixture({ nonce: 'nonce-1' });
    const { fetch, calls } = fetchRecorder(() => jsonResponse({ id_token: fixture.idToken }));
    const client = createGoogleClient({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      tokenEndpoint: TOKEN_ENDPOINT,
      jwks: fixture.jwks,
      fetch,
    });

    const identity = await client.fetchIdentity({
      code: 'auth-code',
      codeVerifier: CODE_VERIFIER,
      nonce: 'nonce-1',
    });

    expect(identity).toEqual({
      providerAccountId: 'google-subject-1',
      email: 'ada@example.test',
      emailVerified: true,
      displayName: 'Ada Lovelace',
    });
    expect(calls).toHaveLength(1);
    const [tokenCall] = calls;
    expect(tokenCall?.url).toBe(TOKEN_ENDPOINT);
    const body = tokenRequestBody(tokenCall);
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('code_verifier')).toBe(CODE_VERIFIER);
    expect(body.get('client_secret')).toBe(CLIENT_SECRET);
    expect(body.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(body.get('grant_type')).toBe('authorization_code');
  });

  it.each([
    ['nonce mismatch', { nonce: 'other-nonce' }, 'oauth_failed'],
    ['unverified email', { emailVerified: false }, 'email_unverified'],
    ['wrong issuer', { issuer: 'https://evil.example' }, 'oauth_failed'],
    ['wrong audience', { audience: 'someone-else' }, 'oauth_failed'],
    ['expired token', { expiresIn: '-5m' }, 'oauth_failed'],
  ] as const)('rejects %s', async (_label, overrides, expectedCode) => {
    const fixture = await googleFixture({ nonce: 'nonce-1', ...overrides });
    const { fetch } = fetchRecorder(() => jsonResponse({ id_token: fixture.idToken }));
    const client = createGoogleClient({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      tokenEndpoint: TOKEN_ENDPOINT,
      jwks: fixture.jwks,
      fetch,
    });

    await expect(
      client.fetchIdentity({ code: 'auth-code', codeVerifier: CODE_VERIFIER, nonce: 'nonce-1' }),
    ).rejects.toMatchObject({
      code: expectedCode,
    });
  });

  it('maps a token-endpoint outage to provider_unavailable', async () => {
    const { fetch } = fetchRecorder(() => jsonResponse({ error: 'server_error' }, 503));
    const client = createGoogleClient({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      tokenEndpoint: TOKEN_ENDPOINT,
      jwks: createLocalJWKSet({ keys: [] }),
      fetch,
    });

    await expect(
      client.fetchIdentity({ code: 'auth-code', codeVerifier: CODE_VERIFIER, nonce: 'nonce-1' }),
    ).rejects.toBeInstanceOf(OAuthFlowError);
    await expect(
      client.fetchIdentity({ code: 'auth-code', codeVerifier: CODE_VERIFIER, nonce: 'nonce-1' }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
  });
});

describe('GitHub provider adapter', () => {
  it('builds an S256 authorization URL with the email scope', () => {
    const client = createGithubClient({
      clientId: 'gh-client',
      clientSecret: 'gh-secret',
      redirectUri: 'https://api.example.test/v1/auth/oauth/github/callback',
    });
    const url = new URL(
      client.authorizationUrl({ state: 'state-2', codeChallenge: 'challenge-2', nonce: null }),
    );

    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('gh-client');
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
    expect(url.searchParams.get('state')).toBe('state-2');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-2');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBeNull();
  });

  it('uses the primary verified entry from /user/emails, not the profile email', async () => {
    const apiBaseUrl = 'https://api.github.test';
    const { fetch, calls } = fetchRecorder((url) => {
      if (url === TOKEN_ENDPOINT)
        return jsonResponse({ access_token: 'gh-token', token_type: 'bearer' });
      if (url === `${apiBaseUrl}/user`) {
        return jsonResponse({
          id: 583231,
          login: 'octocat',
          name: 'The Octocat',
          email: 'unverified-profile@example.test',
        });
      }
      if (url === `${apiBaseUrl}/user/emails`) {
        return jsonResponse([
          { email: 'unverified-profile@example.test', primary: false, verified: false },
          { email: 'octocat@example.test', primary: true, verified: true },
        ]);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const client = createGithubClient({
      clientId: 'gh-client',
      clientSecret: 'gh-secret',
      redirectUri: 'https://api.example.test/v1/auth/oauth/github/callback',
      tokenEndpoint: TOKEN_ENDPOINT,
      apiBaseUrl,
      fetch,
    });

    const identity = await client.fetchIdentity({
      code: 'auth-code',
      codeVerifier: CODE_VERIFIER,
      nonce: null,
    });

    expect(identity).toEqual({
      providerAccountId: '583231',
      email: 'octocat@example.test',
      emailVerified: true,
      displayName: 'The Octocat',
    });
    expect(calls.map((call) => call.url).sort()).toEqual(
      [TOKEN_ENDPOINT, `${apiBaseUrl}/user`, `${apiBaseUrl}/user/emails`].sort(),
    );
    const tokenBody = tokenRequestBody(calls[0]);
    expect(tokenBody.get('code_verifier')).toBe(CODE_VERIFIER);
    const apiCall = calls.find((call) => call.url === `${apiBaseUrl}/user`);
    const headers = new Headers(apiCall?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer gh-token');
    expect(headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(headers.get('user-agent')).toContain('Trendr/1.0');
  });

  it('rejects a GitHub account without a primary verified email', async () => {
    const apiBaseUrl = 'https://api.github.test';
    const { fetch } = fetchRecorder((url) => {
      if (url === TOKEN_ENDPOINT) return jsonResponse({ access_token: 'gh-token' });
      if (url === `${apiBaseUrl}/user`) return jsonResponse({ id: 7, login: 'octocat' });
      if (url === `${apiBaseUrl}/user/emails`) {
        return jsonResponse([{ email: 'octocat@example.test', primary: true, verified: false }]);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const client = createGithubClient({
      clientId: 'gh-client',
      clientSecret: 'gh-secret',
      redirectUri: 'https://api.example.test/v1/auth/oauth/github/callback',
      tokenEndpoint: TOKEN_ENDPOINT,
      apiBaseUrl,
      fetch,
    });

    await expect(
      client.fetchIdentity({ code: 'auth-code', codeVerifier: CODE_VERIFIER, nonce: null }),
    ).rejects.toMatchObject({ code: 'email_unverified' });
  });

  it('rejects a token response without an access token', async () => {
    const { fetch } = fetchRecorder(() =>
      jsonResponse({ error: 'bad_verification_code', error_description: 'invalid code' }),
    );
    const client = createGithubClient({
      clientId: 'gh-client',
      clientSecret: 'gh-secret',
      redirectUri: 'https://api.example.test/v1/auth/oauth/github/callback',
      tokenEndpoint: TOKEN_ENDPOINT,
      fetch,
    });

    await expect(
      client.fetchIdentity({ code: 'auth-code', codeVerifier: CODE_VERIFIER, nonce: null }),
    ).rejects.toMatchObject({ code: 'oauth_failed' });
  });
});
