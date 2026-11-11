import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import {
  OAUTH_RATE_LIMIT_MAX,
  OAUTH_RATE_LIMIT_WINDOW_SECONDS,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE_PATH,
  OAUTH_STATE_TTL_SECONDS,
  RateLimitedError,
  UnavailableError,
  redisKeys,
  sanitizeReturnTo,
  timingSafeStringEqual,
} from '@trendr/core';

import { CACHE_CONTROL } from '../plugins/etag.js';
import { clientIp } from '../plugins/rate-limit.js';
import {
  OAuthCallbackQuery,
  OAuthProviderParams,
  OAuthProvidersResponse,
  OAuthRedirectResponse,
  OAuthStartQuery,
} from '../schemas/oauth.js';
import { OAuthFlowError, type OAuthFailureCode } from '../services/oauth/errors.js';
import { oauthProviderSummaries, type OAuthProviderMap } from '../services/oauth/providers.js';
import {
  beginOAuth,
  completeOAuthLogin,
  consumeOAuthAuthorization,
  type OAuthServiceOptions,
} from '../services/oauth.service.js';
import { allowCounter } from './auth-counters.js';
import { setRefreshCookie, type RefreshCookieSameSite } from './auth-cookies.js';

/**
 * ADR-0034 — browser-facing OAuth login.
 *
 * The API owns the provider callback so the refresh cookie is set on the API
 * origin. The web app only starts the flow and, on return, calls
 * `/v1/auth/refresh` to pick up the session. `dt_oauth_state` holds the opaque
 * state only; the PKCE verifier and Google nonce live in Redis and are consumed
 * with `GETDEL`.
 */

export interface OAuthRoutesOptions {
  /** Only configured providers are advertised and startable. */
  providers?: OAuthProviderMap;
  webPublicUrl?: string;
  adminEmails?: readonly string[];
  refreshTtlDays?: number;
  cookieSecure?: boolean;
  cookieSameSite?: RefreshCookieSameSite;
  trustProxy?: boolean;
  trustCfConnectingIp?: boolean;
  /** Dedicated OAuth budget (default 20/min/IP); not the 5/min strict auth guard. */
  oauthRateLimitMax?: number;
  now?: () => Date;
}

export function registerOAuthRoutes(app: FastifyInstance, options: OAuthRoutesOptions = {}): void {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const trustProxy = options.trustProxy ?? false;
  const trustCfConnectingIp = options.trustCfConnectingIp ?? false;
  const webPublicUrl = options.webPublicUrl ?? 'http://localhost:3000';
  const cookieSecure = options.cookieSecure ?? false;
  const cookieSameSite = options.cookieSameSite ?? 'lax';
  const providers = options.providers ?? {};

  if (cookieSameSite === 'none' && !cookieSecure) {
    throw new Error('cookieSameSite "none" requires secure cookies');
  }

  const refreshCookieConfig = {
    sameSite: cookieSameSite,
    secure: cookieSecure,
    ttlDays: options.refreshTtlDays ?? 30,
  } as const;

  const stateCookieOptions = {
    path: OAUTH_STATE_COOKIE_PATH,
    httpOnly: true,
    secure: cookieSecure,
    // The callback is a top-level navigation from the provider, so Lax is
    // enough and works even when the refresh cookie needs SameSite=None.
    sameSite: 'lax',
    maxAge: OAUTH_STATE_TTL_SECONDS,
  } as const;

  const serviceOptions = (): OAuthServiceOptions => {
    if (!app.hasDecorator('db')) {
      throw new UnavailableError('OAuth login is not configured');
    }
    const deps: OAuthServiceOptions = {
      db: app.db,
      providers,
      adminEmails: options.adminEmails ?? [],
    };
    if (app.hasDecorator('redis')) deps.redis = app.redis;
    if (options.refreshTtlDays !== undefined) deps.refreshTtlDays = options.refreshTtlDays;
    if (options.now !== undefined) deps.now = options.now;
    return deps;
  };

  const oauthGuard = async (request: FastifyRequest): Promise<void> => {
    const ip = clientIp(request, trustProxy, trustCfConnectingIp);
    if (
      !(await allowCounter(
        app,
        redisKeys.oauthRateBucket(ip),
        OAUTH_RATE_LIMIT_WINDOW_SECONDS,
        options.oauthRateLimitMax ?? OAUTH_RATE_LIMIT_MAX,
      ))
    ) {
      throw new RateLimitedError('too many OAuth requests; try again in a minute');
    }
  };

  const clearStateCookie = (reply: FastifyReply): void => {
    reply.clearCookie(OAUTH_STATE_COOKIE, {
      path: OAUTH_STATE_COOKIE_PATH,
      secure: cookieSecure,
      sameSite: 'lax',
    });
  };

  const failureRedirect = (reply: FastifyReply, code: OAuthFailureCode): void => {
    const url = new URL('/auth/oauth/callback', webPublicUrl);
    url.searchParams.set('error', code);
    reply.redirect(url.toString(), 302);
  };

  server.get(
    '/v1/auth/oauth/providers',
    {
      config: { cacheControl: CACHE_CONTROL.privateNoStore },
      schema: {
        tags: ['auth'],
        summary: 'List the OAuth providers enabled on this deployment',
        response: { 200: OAuthProvidersResponse },
      },
    },
    () => ({ providers: oauthProviderSummaries(providers) }),
  );

  server.get(
    '/v1/auth/oauth/:provider/start',
    {
      config: { cacheControl: CACHE_CONTROL.privateNoStore },
      onRequest: oauthGuard,
      schema: {
        tags: ['auth'],
        summary: 'Start an OAuth authorization-code + PKCE login',
        params: OAuthProviderParams,
        querystring: OAuthStartQuery,
        response: { 302: OAuthRedirectResponse },
      },
    },
    async (request, reply) => {
      const { provider } = request.params;
      const authorization = await beginOAuth(serviceOptions(), provider, request.query.return_to);
      reply.setCookie(OAUTH_STATE_COOKIE, authorization.state, stateCookieOptions);
      return reply.redirect(authorization.authorizationUrl, 302);
    },
  );

  server.get(
    '/v1/auth/oauth/:provider/callback',
    {
      config: { cacheControl: CACHE_CONTROL.privateNoStore },
      onRequest: oauthGuard,
      schema: {
        tags: ['auth'],
        summary: 'OAuth provider callback; sets the rotating refresh cookie',
        params: OAuthProviderParams,
        querystring: OAuthCallbackQuery,
        response: { 302: OAuthRedirectResponse },
      },
    },
    async (request, reply) => {
      const { provider } = request.params;
      const query = request.query;

      try {
        if (providers[provider] === undefined) {
          failureRedirect(reply, 'oauth_failed');
          return;
        }

        const cookieState = request.cookies[OAUTH_STATE_COOKIE];
        clearStateCookie(reply);
        if (typeof cookieState !== 'string' || cookieState.length === 0) {
          failureRedirect(reply, 'invalid_state');
          return;
        }
        if (query.state === undefined || !timingSafeStringEqual(cookieState, query.state)) {
          failureRedirect(reply, 'invalid_state');
          return;
        }

        // Provider-side cancellation still burns the state so it cannot be
        // replayed with a stolen authorization code.
        if (query.error !== undefined) {
          await consumeOAuthAuthorization(serviceOptions(), provider, query.state);
          failureRedirect(
            reply,
            query.error === 'access_denied' ? 'access_denied' : 'oauth_failed',
          );
          return;
        }
        if (query.code === undefined) {
          failureRedirect(reply, 'invalid_request');
          return;
        }

        const payload = await consumeOAuthAuthorization(serviceOptions(), provider, query.state);
        if (payload === null) {
          failureRedirect(reply, 'invalid_state');
          return;
        }

        const session = await completeOAuthLogin(serviceOptions(), provider, {
          code: query.code,
          codeVerifier: payload.codeVerifier,
          nonce: payload.nonce,
        });
        setRefreshCookie(reply, session, refreshCookieConfig);
        // The web callback page performs a forced refresh before routing on;
        // the H-3 session hint does not exist yet for a first OAuth login.
        const destination = new URL('/auth/oauth/callback', webPublicUrl);
        destination.searchParams.set('return_to', sanitizeReturnTo(payload.returnTo));
        return await reply.redirect(destination.toString(), 302);
      } catch (error) {
        if (error instanceof OAuthFlowError) {
          request.log.warn({ err: error, provider, failure: error.code }, 'OAuth callback failed');
          failureRedirect(reply, error.code);
          return;
        }
        if (error instanceof UnavailableError) {
          request.log.warn({ err: error, provider }, 'OAuth callback dependency unavailable');
          failureRedirect(reply, 'provider_unavailable');
          return;
        }
        throw error;
      }
    },
  );
}
