# ADR-0035 — Security remediation for credentials, logs and proxy identity

- Status: Accepted
- Date: 2026-11-13
- Spec: §10.5 (authentication), §15 (security), §17.1 (deployment)
- Supersedes: nothing; hardens ADR-0020, ADR-0030 and ADR-0034

## Context

A follow-up review of the OAuth-era tree found four credential-handling gaps:

1. `db:seed` created a deterministic admin API key (`dt_live_seedkey1_…`) and
   shipped the seed inside the API image. Any database that had been seeded
   held a privileged key whose raw value could be derived from the repository.
2. The API-key and JWT hooks run as instance-level `onRequest` hooks; the
   route-level `@fastify/rate-limit` hook runs afterwards. A rejected
   credential therefore bypassed the limiter, and every random API-key prefix
   caused a database lookup and a Redis write.
3. One-time secrets travelled in query strings. nginx's default access log and
   Fastify's default `req.url` serializer recorded magic-link, unsubscribe and
   OAuth callback parameters. A magic link was replayable by anyone with log
   access.
4. The Render blueprint trusted the whole `X-Forwarded-For` chain (`true`).
   If the platform appends rather than overwrites, the left-most entry is
   caller-controlled and becomes the rate-limit/audit identity. A JWT admin
   also kept admin powers after demotion or account deletion until the
   access-token TTL expired.

## Decision

1. **Seed is development-only and random.**
   - `seed()` refuses `NODE_ENV=production` unless `allowProduction` (CLI:
     `SEED_ALLOW_PRODUCTION=true`) is explicitly set.
   - The seed API key is generated with `createApiKeyMaterial(pepper)` on every
     run; the deterministic material is removed.
   - Re-seeding updates the existing `seed-dev-key` row by `(user_id, name)`
     rather than matching a fixed prefix.
2. **Failed credentials get a pre-work budget.**
   - New key namespace `apirl:auth-fail:{api-key|bearer}:{ip}`.
   - Default 20 rejected credentials per IP per 60 seconds.
   - The check runs before parsing/lookup/verification; only failures are
     counted, so successful requests retain their normal tier.
3. **Never log query strings.**
   - Fastify's `req` serializer keeps method/path/host/remote address only.
   - nginx uses a `trendr` log format built from `$uri` with no query string
     and no Referer.
   - Magic-link tokens move from `?token=` to `#token=`; the web verifier reads
     the fragment and still accepts legacy query links.
4. **Trust exactly one proxy hop.**
   - New optional `TRUST_PROXY_HOPS` (1–10). When set, Fastify gets a trust
     function that trusts only that many hops. `render.yaml`,
     `docker-compose.prod.yml` and `.env.production.example` set `1`; the VPS
     nginx already overwrites `X-Forwarded-For`.
5. **Revalidate admin credentials against the database.**
   - `requireAdmin` re-reads `users.role` for both admin JWTs and admin-scope
     API keys when a database is available. A deleted or demoted admin gets
     401/403 immediately; tooling builds without a database keep the
     claim/scope fallback.
6. **Refresh transitive dependencies.** Overrides move Hono to `^4.13.16` and
   `@hono/node-server` to `^2.1.6`; `fast-xml-parser` moves to `^5.11.3`. The
   `deepmerge` advisory has no published patched 4.x release, so it remains a
   documented low-severity residual.
7. **Verify release signatures at deploy time.** `infra/scripts/verify-release-images.sh`
   checks all four GHCR images against the keyless identity from
   `publish.yml`; the VPS bootstrap runs it before `docker compose pull`, and
   the runbook requires `REQUIRE_COSIGN=1` for release and rollback. Render's
   image service cannot run cosign; its Blueprint should use a digest-pinned
   image or an external verification gate.

## Consequences

- Local seeding still creates a working admin key for Postman and the compose
  smoke test, but the key changes on every run and cannot be derived from the
  repository. Re-running the seed invalidates the previously printed key.
- A client that sends many bad keys or tokens now receives `429` after 20
  failures/minute; the existing `Retry-After` handler applies.
- Operators lose filter query strings from nginx access logs. The route,
  method, status and user agent remain. Application logs retain non-secret
  metrics and request ids.
- `TRUST_PROXY_HOPS=1` is correct for one nginx or one Render hop. A topology
  with an additional CDN/hop must raise it or use a trusted proxy-IP list.
- Admin JWT requests now perform one indexed user lookup. This is negligible
  for the low-volume admin surface and buys immediate revocation.

## Verification

- `packages/db/test/unit/seed.test.ts` and the seed integration test cover the
  production guard and key rotation.
- `apps/api/src/plugins/auth-failures.test.ts` covers the memory and Redis
  budgets; `apps/api/src/plugins/auth.test.ts` covers the bearer hook.
- `apps/api/test/int/api-key.int.test.ts` covers the 21st invalid key.
- `apps/api/test/int/admin.int.test.ts` covers demotion-by-stored-role.
- `apps/api/src/routes/stream.test.ts` and the SSE integration suite cover the
  atomic lease counter.
- `packages/logger/src/index.test.ts` asserts query strings are stripped.
- `packages/config/src/env.test.ts` covers `TRUST_PROXY_HOPS`.
- `infra/scripts/verify-release-images.sh` is exercised by the VPS bootstrap
  and the release/rollback runbook steps.
