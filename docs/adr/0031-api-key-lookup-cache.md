# ADR-0031 — API-key lookup cache and edge flood guard

- Status: Accepted (Phase 6)
- Date: 2026-11-03
- Spec: §10.5 (rate-limit tiers), §9.3 (degradation), §15
- Finding: M-2

## Context

`X-API-Key` authentication runs as an `onRequest` hook before
`@fastify/rate-limit`, because the limiter's budget is
`apiKey.rateLimitPerMin` and the key must be resolved first. Each request with
a key therefore did one `findApiKeyByPrefix` query before any rate-limit
counter moved. An attacker could send a stream of distinct well-formed
prefixes (or the same unknown prefix) and turn the API into a database
amplifier with no per-identity budget involved.

Two layers were missing: a cache for the lookup, and a guard before Node.

## Decision

1. **60 s Redis cache** (`apikey:lookup:{prefix}`). Positive entries store the
   authentication fields (`id`, `userId`, `scopes`, `rateLimitPerMin`,
   `keyHash` base64, `revokedAt`, `expiresAt`); a miss is cached as `"0"` so a
   repeated unknown prefix costs no query either. The JSON is validated with
   Zod because it crosses a process boundary. Redis failures fall through to
   the database and only log.
2. **Explicit invalidation.** `revokeApiKeyForCurrentUser` deletes the entry
   after the database update, so a revoked key stops working on the next
   request. Creation needs no invalidation (new prefix); user deletion keeps a
   stale entry for at most 60 s, and the key still fails later authorization
   against the missing user.
3. **Edge guard in nginx.** `limit_req_zone ... rate=50r/s` (burst 100) and
   `limit_conn_zone` (20 concurrent) apply to `/v1/`; `/v1/stream/` gets a
   10-connection cap but no request rate limit (long-lived streams). Both
   answer 429, like the API.
4. **Plugin order stays.** The per-key budget cannot be computed before the key
   is resolved, so the limiter stays after the API-key hook; the cache and the
   edge guard address the amplification instead of reordering.

## Consequences

- Repeated requests with one key, and repeated requests with an unknown
  prefix, stop hitting Postgres per request.
- A scope/budget change made directly in the database is visible within 60 s;
  revocation is immediate.
- The edge returns nginx's 429 (HTML, `text/html`) for a flood rather than
  problem+json. That is a deliberate trade at the outermost layer; the API
  still returns problem+json for its own limits.
- One extra Redis GET per keyed request. It is a single round trip against a
  store the rate limiter already uses, and it fails open to the old path.

## Verification

- `apps/api/test/int/api-key.int.test.ts`: a valid key writes
  `apikey:lookup:{prefix}` with a TTL ≤ 60 s; revoking through the service
  deletes it and the next request with that key gets 401.
- `nginx -t` on the updated `infra/nginx/trendr.conf` (validated in a
  throwaway container with placeholder certificates and range includes).
