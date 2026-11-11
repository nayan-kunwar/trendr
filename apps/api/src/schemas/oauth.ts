import { z } from 'zod';

import { OAUTH_PROVIDERS } from '@trendr/core';

/**
 * ADR-0034 — OAuth 2.0 Authorization Code + PKCE login. Provider callbacks are
 * browser navigations, so their failures are web redirects, not problem+json.
 */

export const OAuthProviderParams = z.object({
  provider: z.enum(OAUTH_PROVIDERS),
});

export const OAuthStartQuery = z.object({
  /** Same-origin path to open after sign-in; sanitised server-side. */
  return_to: z.string().max(512).optional(),
});

export const OAuthCallbackQuery = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(16).max(512).optional(),
  error: z.string().max(256).optional(),
  error_description: z.string().max(1024).optional(),
});

export const OAuthProviderDto = z.object({
  id: z.enum(OAUTH_PROVIDERS),
  label: z.string(),
});

export const OAuthProvidersResponse = z.object({
  providers: z.array(OAuthProviderDto),
});

/** Empty 302 body; declared so the OpenAPI document shows the redirect status. */
export const OAuthRedirectResponse = z.unknown();
