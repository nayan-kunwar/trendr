# ADR-0034 — Google and GitHub OAuth login

- Status: Accepted
- Date: 2026-11-11
- Spec: §10.5 (authentication), §15 (environment), §18 task 7.1 (accounts)
- Supersedes: nothing; extends the magic-link flow

## Context

Trendr shipped with email magic links only. Product wants one-click sign-in with
Google and GitHub, but the security properties of the existing flow must not
regress:

- access tokens stay in memory; the rotating `dt_refresh` cookie remains the
  only long-lived browser credential;
- auth endpoints are rate limited and validate every external input;
- no provider access/refresh token is needed after login, so none should be
  stored;
- the web and API may be deployed on different origins (VPS, Render).

The flow must also coexist with magic links. Requesting a magic link creates an
unverified `users` row (a placeholder). An OAuth login with a verified provider
email may claim that row; otherwise the original link requester could later
sign in to an account someone else proved ownership of.

## Decision

### Protocol and endpoints

Both providers use OAuth 2.0 Authorization Code + PKCE (RFC 7636, S256). The API
owns the callback so the refresh cookie is set on the API origin:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/auth/oauth/providers` | Enabled providers (`[{id,label}]`) for the web UI |
| GET | `/v1/auth/oauth/:provider/start` | Create state + PKCE, redirect to the provider |
| GET | `/v1/auth/oauth/:provider/callback` | Consume state, exchange the code, set `dt_refresh`, redirect to the web |

`:provider` is the `google|github` enum. Callback URLs derive from
`API_PUBLIC_URL` (`/v1/auth/oauth/{provider}/callback`), so there is no separate
redirect-URI environment variable. `return_to` is a same-origin absolute path,
sanitized in `@trendr/core` (`sanitizeReturnTo`); scheme-relative URLs,
backslashes, control characters and overlong values fall back to `/dashboard`.

The callback always redirects to the web app:

- success → `${WEB_PUBLIC_URL}/auth/oauth/callback?return_to=…`;
- failure → `${WEB_PUBLIC_URL}/auth/oauth/callback?error=<code>`.

The web callback page calls `refreshSession({ force: true })` before routing on.
The H-3 `trendr.hasSession` hint is still absent on a first OAuth login, so a
normal anonymous refresh would be skipped.

Failure codes are stable and deliberately coarse:
`access_denied`, `invalid_state`, `invalid_request`, `email_unverified`,
`account_conflict`, `provider_unavailable`, `oauth_failed`. Provider error
descriptions, codes, tokens and raw upstream bodies never reach the browser.

### State and PKCE storage

`dt_oauth_state` is an httpOnly cookie containing **only** the random state.
The PKCE verifier and Google nonce live in Redis:

- key `oauth:state:<sha256(state)>` (the raw state is never a Redis key);
- value is a Zod-validated `{provider, codeVerifier, nonce, returnTo, createdAt}`;
- TTL 10 minutes;
- consumed with `GETDEL`, so exactly one callback can use a state even when two
  requests race.

The state cookie is `SameSite=Lax`, `Path=/v1/auth/oauth`, and `Secure` in
production. Lax is sufficient because the provider callback is a top-level
navigation; the refresh cookie can independently be `SameSite=None` for a
split-site deployment.

### Provider identity rules

**Google** uses the OIDC ID token from the token endpoint. The API verifies the
signature against Google's JWKS (`jose`), then `iss` (both accepted spellings),
`aud` (the configured client id), `exp`, `iat`, `sub`, and the nonce stored with
the state. `email_verified` must be exactly `true`. The immutable subject is
`sub`.

**GitHub** uses the REST API. The profile email is ignored because it can be
null, private or unverified; the API calls `/user/emails` and accepts only an
entry where `primary === true && verified === true`. The immutable subject is
the numeric user `id` (stored as text). Scope is `read:user user:email`.

GitHub PKCE was confirmed against the official changelog:
<https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/>
(2025-07-14). It supports and recommends S256, but does not require PKCE. Trendr
sends it for both providers.

### Account linking

`oauth_accounts` stores `(provider, provider_account_id)` as the stable login
key and `(user_id, provider)` as a unique pair, so a user can link both
providers but only one account per provider. `provider_email` is informational;
it is updated on each login and never used to move an existing link.

Callback decision matrix, inside one transaction:

1. Existing `(provider, provider_account_id)` → log into that user, refresh
   `provider_email`/`last_login_at`, and ignore a changed provider email.
2. No link, verified provider email matches an existing user → link it. This is
   safe because the provider proved ownership of the address.
3. No link, no user → create a verified user with the provider display name.
4. Existing user already has a different account for the same provider →
   `account_conflict` (never silently replace a link).

When the matched user is an unverified magic-link placeholder, the login also:

- sets `email_verified_at`;
- fills `display_name` only when it is null;
- recomputes `role` from `ADMIN_EMAILS`;
- sets `last_login_at`;
- revokes every unused magic link for that user, so the original link requester
  cannot later take over the claimed account.

No provider access or refresh token is stored.

### Rate limiting

OAuth start and callback use a dedicated fixed-window counter,
`apirl:oauth:{ip}`, at 20 requests/minute/IP. They are **not** behind the
5/minute `strictAuthGuard` used by magic-link, verify and logout: a browser may
legitimately navigate start → provider → callback plus retries, and a shared
5/minute bucket would make the flow unusable. Refresh keeps its existing
per-session and per-IP budgets.

This is a deliberate deviation from the spec's blanket `/v1/auth/*` strict
limiter and is recorded as R-33 in `docs/SPEC_REVIEW.md`.

### Configuration

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` are optional. A provider is enabled only when **both**
halves are non-empty; half a pair is a boot error, and empty strings count as
unset. `GET /v1/auth/oauth/providers` advertises only enabled providers, and the
web hides the rest. `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` are OAuth app
credentials and are distinct from the worker's `GITHUB_TOKENS` PATs.

## Consequences

- The browser sees only the opaque state and the normal refresh cookie. An XSS
  cannot read the PKCE verifier, Google nonce, provider tokens or refresh token.
- A stolen state cookie alone is useless without the Redis payload; a stolen
  authorization code alone is useless without the verifier.
- Provider email changes do not move an existing login, but a new provider
  account for an already-linked user is rejected rather than silently merged.
- Cross-site deployments still depend on third-party cookies for the refresh
  step. Safari blocks them on the default `*.onrender.com` hosts. For a
  browser-complete deployment use custom subdomains under one registrable
  domain (`app.example.com`, `api.example.com`) and `COOKIE_SAME_SITE=lax`; see
  the runbook's Render cookie checklist. A BFF/proxy remains the fallback if
  third-party cookies must be avoided entirely.
- Live provider verification is owner-infrastructure work: the code path is
  covered with a locally generated RSA key/JWKS and recorded GitHub response
  shapes, but a real Google/GitHub client id and callback registration are
  needed for an end-to-end acceptance run.

## Alternatives considered

- **Store the verifier in a signed cookie.** Rejected: a readable cookie would
  expose the verifier to XSS, and a signed cookie still needs replay/single-use
  semantics that Redis `GETDEL` gives directly.
- **Keep the callback in the web app.** Rejected: the refresh cookie belongs to
  the API origin, and the web server would need to proxy token exchange and
  session creation.
- **Trust the GitHub profile email.** Rejected: it is not proof of ownership.
- **Store provider tokens for later API calls.** Rejected: Trendr does not call
  the provider after login, so storing them only adds breach impact.
- **Put OAuth under the 5/minute strict limiter.** Rejected for usability; the
  dedicated 20/minute bucket still bounds abuse and keeps the stricter guard on
  credential-issuing endpoints.

## Names introduced

`oauth_provider_t`, `oauth_accounts`, `oauth_accounts_provider_account_uq`,
`oauth_accounts_user_provider_uq`, `oauth:state:{sha256(state)}`,
`apirl:oauth:{ip}`, `dt_oauth_state`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. These are
recorded in `docs/SPEC_REVIEW.md` because `TRENDR_SPEC.md` is frozen.
