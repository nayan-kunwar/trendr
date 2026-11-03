# ADR-0033 — Production configuration guardrails

- Status: Accepted (Phase 6)
- Date: 2026-11-03
- Spec: §15 (environment table), §10.5 (token lifetimes)
- Findings: M-7, L-6

## Context

`packages/config/src/env.ts` validated types and a few cross-field rules, but a
production process could boot with values that make it unusable or unsafe:

- `API_PUBLIC_URL`/`WEB_PUBLIC_URL`/`CORS_ORIGINS` on plain `http://`, so the
  `Secure` refresh cookie is never sent by a browser.
- Placeholder secrets copied from `.env.production.example`
  (`change-me`, `<generate>`, `example`) still satisfy `min(32)`.
- `EMAIL_PROVIDER=log` (prints magic links and digests to the log) or the
  default `smtp://mailpit:1025` in production, where no such host exists.
- `JWT_ACCESS_TTL_SEC`/`REFRESH_TTL_DAYS` were unbounded integers, so a typo
  could issue a ten-year access token.

The failure mode was a green `/healthz` with broken sign-in, links and email.

## Decision

1. **Bounds belong in the base schema (L-6).** `JWT_ACCESS_TTL_SEC` is 60–3600 s
   and `REFRESH_TTL_DAYS` is 1–90 days. The spec defaults (900 s / 30 d) are
   unchanged, and the bounds apply in every environment so tests and local runs
   catch a bad value too.
2. **Production-only guardrails (M-7)** live in `EnvSchema.superRefine`:
   - the four secrets (`JWT_SECRET`, `API_KEY_PEPPER`, `UNSUBSCRIBE_SECRET`,
     `METRICS_TOKEN`) must not match a placeholder pattern
     (`change-me`, `replace-me`, `placeholder`, `example`, `your-…`, bare
     `test`/`dev`/`secret`/`password`);
   - `API_PUBLIC_URL` and `WEB_PUBLIC_URL` must start with `https://`;
   - every `CORS_ORIGINS` entry must start with `https://`;
   - `EMAIL_PROVIDER=log` is rejected;
   - `smtp` delivery to `mailpit`/`localhost`/`127.0.0.1` is rejected.

All issues are reported together by `readEnv`, which `loadEnv` prints before
exiting, so an operator sees every problem in one boot.

3. **No entropy check.** The pattern catches copy-paste defaults, which is the
   realistic mistake; judging the strength of a generated secret belongs to the
   secret manager, not the schema.

## Consequences

- A production deploy with a placeholder or an `http://` origin fails at boot
  with a precise message instead of serving a broken sign-in.
- The Render blueprint (`render.yaml`) already satisfies all of this: https
  hosts, `resend`, generated secrets.
- Shortening the access token below 60 s or the refresh below one day is no
  longer possible through the environment. That is intentional; a shorter-lived
  access token needs a code change and its own test.
- The placeholder list is deliberately conservative: a real secret containing
  the word `example` would be rejected, and the fix is to generate another one.

## Verification

- `packages/config/src/env.test.ts`: production accepts `PRODUCTION_VALID`,
  rejects a placeholder `JWT_SECRET`, an `http://` public URL, an `http://`
  CORS origin, `EMAIL_PROVIDER=log` and `smtp://mailpit`; the TTL bounds reject
  10 s / 86 400 s access tokens and 0 / 365-day refresh windows.
