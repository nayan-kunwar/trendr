import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

import {
  OAUTH_PROVIDER_LABELS,
  OAUTH_PROVIDERS,
  normalizeEmail,
  type OAuthProvider,
} from '@trendr/core';

import { OAuthFlowError } from './errors.js';

/**
 * Provider adapters for Google (OIDC ID token) and GitHub (REST profile +
 * `/user/emails`). Both use Authorization Code + PKCE S256. The browser never
 * sees a provider token and none are persisted.
 *
 * GitHub PKCE: supported and recommended since 2025-07-14, S256 only
 * (https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/).
 */

export interface OAuthIdentity {
  /** Immutable provider subject: Google `sub`, GitHub numeric `id` as a string. */
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
}

export interface OAuthAuthorizationInput {
  state: string;
  codeChallenge: string;
  /** Google OIDC nonce; `null` for GitHub. */
  nonce: string | null;
}

export interface OAuthTokenInput {
  code: string;
  codeVerifier: string;
  nonce: string | null;
}

export interface OAuthProviderClient {
  id: OAuthProvider;
  label: string;
  authorizationUrl(input: OAuthAuthorizationInput): string;
  fetchIdentity(input: OAuthTokenInput): Promise<OAuthIdentity>;
}

export type OAuthProviderMap = Partial<Record<OAuthProvider, OAuthProviderClient>>;

export type OAuthFetch = typeof fetch;

const REQUEST_TIMEOUT_MS = 5_000;
const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;
const GITHUB_AUTHORIZATION_ENDPOINT = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

export const DEFAULT_OAUTH_USER_AGENT = 'Trendr/1.0 (+https://github.com/nayan-kunwar/trendr)';

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export interface CreateOAuthProvidersOptions {
  apiPublicUrl: string;
  google?: OAuthCredentials;
  github?: OAuthCredentials;
  fetch?: OAuthFetch;
  /** Test hook; production uses Google's JWKS endpoint. */
  googleJwks?: JWTVerifyGetKey;
  userAgent?: string;
  googleAuthorizationEndpoint?: string;
  googleTokenEndpoint?: string;
  githubAuthorizationEndpoint?: string;
  githubTokenEndpoint?: string;
  githubApiBaseUrl?: string;
}

export interface GoogleClientOptions extends OAuthCredentials {
  redirectUri: string;
  fetch?: OAuthFetch;
  jwks?: JWTVerifyGetKey;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
}

export interface GithubClientOptions extends OAuthCredentials {
  redirectUri: string;
  fetch?: OAuthFetch;
  userAgent?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  apiBaseUrl?: string;
}

const GoogleTokenResponseSchema = z.object({
  id_token: z.string().min(1),
  access_token: z.string().optional(),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
});

const GithubTokenResponseSchema = z.object({
  access_token: z.string().min(1).optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const GithubUserSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  name: z.string().nullable().optional(),
  // Deliberately ignored: the profile email may be null, private or unverified.
  email: z.string().nullable().optional(),
});

const GithubEmailSchema = z.object({
  email: z.email(),
  primary: z.boolean(),
  verified: z.boolean(),
  visibility: z.string().nullable().optional(),
});

const GithubEmailsSchema = z.array(GithubEmailSchema);

export function createGoogleClient(options: GoogleClientOptions): OAuthProviderClient {
  const fetchImpl = options.fetch ?? fetch;
  const jwks = options.jwks ?? createRemoteJWKSet(GOOGLE_JWKS_URL);
  const authorizationEndpoint = options.authorizationEndpoint ?? GOOGLE_AUTHORIZATION_ENDPOINT;
  const tokenEndpoint = options.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT;

  return {
    id: 'google',
    label: OAUTH_PROVIDER_LABELS.google,
    authorizationUrl(input) {
      const url = new URL(authorizationEndpoint);
      url.search = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: options.redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state: input.state,
        code_challenge: input.codeChallenge,
        code_challenge_method: 'S256',
        access_type: 'online',
        prompt: 'select_account',
        ...(input.nonce === null ? {} : { nonce: input.nonce }),
      }).toString();
      return url.toString();
    },
    async fetchIdentity(input) {
      const body = new URLSearchParams({
        code: input.code,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        redirect_uri: options.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: input.codeVerifier,
      });
      const response = await fetchWithTimeout(fetchImpl, tokenEndpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
      if (!response.ok) throw providerStatusError('google', response.status);

      const parsed = GoogleTokenResponseSchema.safeParse(await readJson(response));
      if (!parsed.success) {
        throw new OAuthFlowError('oauth_failed', 'Google token response was malformed');
      }

      const payload = await verifyGoogleIdToken(parsed.data.id_token, jwks, options.clientId);
      if (input.nonce === null || payload.nonce !== input.nonce) {
        throw new OAuthFlowError('oauth_failed', 'Google ID token nonce did not match');
      }
      if (payload.email_verified !== true) {
        throw new OAuthFlowError('email_unverified', 'Google email is not verified');
      }
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new OAuthFlowError('oauth_failed', 'Google ID token had no subject');
      }
      if (typeof payload.email !== 'string' || payload.email.length === 0) {
        throw new OAuthFlowError('email_unverified', 'Google ID token had no email');
      }

      return {
        providerAccountId: payload.sub,
        email: normalizeEmail(payload.email),
        emailVerified: true,
        displayName: displayNameFrom(payload.name),
      };
    },
  };
}

export function createGithubClient(options: GithubClientOptions): OAuthProviderClient {
  const fetchImpl = options.fetch ?? fetch;
  const userAgent = options.userAgent ?? DEFAULT_OAUTH_USER_AGENT;
  const authorizationEndpoint = options.authorizationEndpoint ?? GITHUB_AUTHORIZATION_ENDPOINT;
  const tokenEndpoint = options.tokenEndpoint ?? GITHUB_TOKEN_ENDPOINT;
  const apiBaseUrl = (options.apiBaseUrl ?? GITHUB_API_BASE_URL).replace(/\/$/, '');

  return {
    id: 'github',
    label: OAUTH_PROVIDER_LABELS.github,
    authorizationUrl(input) {
      const url = new URL(authorizationEndpoint);
      url.search = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: options.redirectUri,
        scope: 'read:user user:email',
        state: input.state,
        code_challenge: input.codeChallenge,
        code_challenge_method: 'S256',
      }).toString();
      return url.toString();
    },
    async fetchIdentity(input) {
      const body = new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code: input.code,
        redirect_uri: options.redirectUri,
        code_verifier: input.codeVerifier,
      });
      const tokenResponse = await fetchWithTimeout(fetchImpl, tokenEndpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': userAgent,
        },
        body: body.toString(),
      });
      if (!tokenResponse.ok) throw providerStatusError('github', tokenResponse.status);

      const tokenParsed = GithubTokenResponseSchema.safeParse(await readJson(tokenResponse));
      if (!tokenParsed.success || tokenParsed.data.access_token === undefined) {
        throw new OAuthFlowError('oauth_failed', 'GitHub token response was malformed');
      }
      const accessToken = tokenParsed.data.access_token;

      const headers = {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${accessToken}`,
        'x-github-api-version': GITHUB_API_VERSION,
        'user-agent': userAgent,
      };
      const [userResponse, emailsResponse] = await Promise.all([
        fetchWithTimeout(fetchImpl, `${apiBaseUrl}/user`, { headers }),
        fetchWithTimeout(fetchImpl, `${apiBaseUrl}/user/emails`, { headers }),
      ]);
      if (!userResponse.ok) throw providerStatusError('github', userResponse.status);
      if (!emailsResponse.ok) throw providerStatusError('github', emailsResponse.status);

      const userParsed = GithubUserSchema.safeParse(await readJson(userResponse));
      const emailsParsed = GithubEmailsSchema.safeParse(await readJson(emailsResponse));
      if (!userParsed.success || !emailsParsed.success) {
        throw new OAuthFlowError('oauth_failed', 'GitHub profile response was malformed');
      }

      // GitHub's profile email is not proof of ownership: require the exact
      // primary + verified entry from the dedicated emails endpoint.
      const primary = emailsParsed.data.find((entry) => entry.primary && entry.verified);
      if (primary === undefined) {
        throw new OAuthFlowError('email_unverified', 'GitHub has no primary verified email');
      }

      return {
        providerAccountId: String(userParsed.data.id),
        email: normalizeEmail(primary.email),
        emailVerified: true,
        displayName: displayNameFrom(userParsed.data.name) ?? userParsed.data.login,
      };
    },
  };
}

export function createOAuthProviders(options: CreateOAuthProvidersOptions): OAuthProviderMap {
  const apiPublicUrl = options.apiPublicUrl.replace(/\/$/, '');
  const providers: OAuthProviderMap = {};

  if (options.google !== undefined) {
    providers.google = createGoogleClient({
      ...options.google,
      redirectUri: `${apiPublicUrl}/v1/auth/oauth/google/callback`,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.googleJwks === undefined ? {} : { jwks: options.googleJwks }),
      ...(options.googleAuthorizationEndpoint === undefined
        ? {}
        : { authorizationEndpoint: options.googleAuthorizationEndpoint }),
      ...(options.googleTokenEndpoint === undefined
        ? {}
        : { tokenEndpoint: options.googleTokenEndpoint }),
    });
  }
  if (options.github !== undefined) {
    providers.github = createGithubClient({
      ...options.github,
      redirectUri: `${apiPublicUrl}/v1/auth/oauth/github/callback`,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
      ...(options.githubAuthorizationEndpoint === undefined
        ? {}
        : { authorizationEndpoint: options.githubAuthorizationEndpoint }),
      ...(options.githubTokenEndpoint === undefined
        ? {}
        : { tokenEndpoint: options.githubTokenEndpoint }),
      ...(options.githubApiBaseUrl === undefined ? {} : { apiBaseUrl: options.githubApiBaseUrl }),
    });
  }

  return providers;
}

export function oauthProviderSummaries(
  providers: OAuthProviderMap,
): { id: OAuthProvider; label: string }[] {
  return OAUTH_PROVIDERS.filter((id) => providers[id] !== undefined).map((id) => ({
    id,
    label: OAUTH_PROVIDER_LABELS[id],
  }));
}

async function verifyGoogleIdToken(
  idToken: string,
  jwks: JWTVerifyGetKey,
  clientId: string,
): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: [...GOOGLE_ISSUERS],
      audience: clientId,
      requiredClaims: ['exp', 'iat', 'sub', 'aud', 'iss'],
      clockTolerance: '5s',
    });
    return payload;
  } catch (error) {
    throw new OAuthFlowError('oauth_failed', 'Google ID token verification failed', {
      cause: error,
    });
  }
}

async function fetchWithTimeout(
  fetchImpl: OAuthFetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new OAuthFlowError('provider_unavailable', 'OAuth provider request failed', {
      cause: error,
    });
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function providerStatusError(provider: OAuthProvider, status: number): OAuthFlowError {
  if (status === 429 || status >= 500) {
    return new OAuthFlowError('provider_unavailable', `${provider} is temporarily unavailable`);
  }
  return new OAuthFlowError('oauth_failed', `${provider} rejected the authorization code`);
}

function displayNameFrom(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 80);
}
