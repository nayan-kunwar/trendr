# ADR-0020 — Phase 9 security hardening choices

- Status: Accepted (Phase 9)
- Date: 2026-10-22
- Spec: §15

## Context

The existing API already had Helmet/CORS, secure cookies in production, token
hashing, API-key scoping and rate limits. Phase 9 needed to close the remaining
checklist gaps without changing public API semantics: CSP, CSRF, strict request
bodies, public-GET CORS, a 64 kB body limit, SQL injection guardrails, and CI
secret/fixture checks.

## Decision

1. **CSRF uses `X-Requested-With: trendr`.** A `preHandler` rejects unsafe
   methods only when the `dt_refresh` cookie is present and the header is
   missing. Bearer/API-key requests are unaffected. Refresh and logout now send
   the header from the web client; auth integration tests exercise it.
2. **CORS uses a delegator, not hundreds of route overrides.** The delegator
   returns `{ origin: '*', credentials: false }` for public `GET`/`HEAD` under
   `/v1/*` outside `/v1/me`, `/v1/admin` and `/v1/auth`, and the configured
   allowlist with credentials elsewhere. This preserves the spec's route-level
   effect while keeping one policy source.
3. **Bodies are strict and bounded globally.** `bodyLimit: 64 * 1024` is set on
   the Fastify instance; all request-body schemas are `z.strictObject` where
   they are plain objects (nested discriminated unions extend existing strict
   validation at the service layer). Unknown properties produce a 400 problem.
4. **CSP is nonce-based in the web middleware.** Next receives a fresh nonce on
   each request and applies it to its bootstrap/chunk scripts; the API sets a
   deny-all CSP because it serves JSON only. No third-party script origins are
   allowed.
5. **Correlation ids are accepted and echoed.** Fastify uses
   `requestIdHeader: 'x-request-id'`; an `onSend` hook writes the final id back
   even for errors, and RFC 7807 bodies include it.
6. **`sql.raw` is lint-banned.** The ESLint rule fails any dynamic raw SQL; the
   one test-only compile-time literal carries an inline justification comment.
7. **CI owns the automation.** gitleaks (full history), `pnpm audit --prod
   --audit-level high`, the aggregate fixture-token test, `promtool check rules`
   and the observability smoke test run in CI. Turnstile remains optional and
   deferred (R-42); magic-link issuance still has per-email/per-IP limits and a
   generic 202.

## Consequences

- Browsers must send the custom CSRF header for cookie-authenticated writes;
  non-browser clients using the refresh cookie need to do the same.
- Public GET responses no longer send `Access-Control-Allow-Credentials`.
- XHR/fetch callers cannot send unknown body fields; malformed payloads are
  rejected instead of silently stripped.
- Any future raw SQL needs a reviewed inline disable, making dynamic queries
  visible in code review.
