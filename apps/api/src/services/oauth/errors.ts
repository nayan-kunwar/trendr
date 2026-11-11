/**
 * Internal control flow for the OAuth callback. The callback answers with a
 * redirect to the web app, not an RFC 7807 body, so these codes are deliberately
 * separate from the API's `AppError` hierarchy. They never include provider
 * tokens, codes or raw error descriptions.
 */

export const OAUTH_FAILURE_CODES = [
  'access_denied',
  'invalid_state',
  'invalid_request',
  'email_unverified',
  'account_conflict',
  'provider_unavailable',
  'oauth_failed',
] as const;

export type OAuthFailureCode = (typeof OAUTH_FAILURE_CODES)[number];

export class OAuthFlowError extends Error {
  override readonly name = 'OAuthFlowError';

  constructor(
    readonly code: OAuthFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
