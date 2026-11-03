# ADR-0023 — Refresh rate-limit bucket and session hint

- Status: Accepted (Phase 2)
- Date: 2026-11-03
- Spec: §10.5 (deviation, recorded as R-53)
- Finding: H-3

## Context

Spec §10.5 defines a 5 requests/min per-IP bucket for `/v1/auth/*`. That is
appropriate for magic-link issuance and verification, where the goal is to
bound email sends and token guessing. The same bucket also covered
`POST /v1/auth/refresh`, which the web client sends on every hard load for every
visitor — including visitors who have no cookie. The sixth refresh in a minute
returned 429, and the old client treated any non-OK response as signed out:

- behind NAT/CGNAT a handful of visitors could exhaust the bucket and make
  signed-in users appear signed out;
- a refresh-happy user could exhaust it alone;
- anonymous visitors consumed the same budget without having a session at all.

## Decision

1. **The strict bucket stays where it protects sign-in.** Magic-link, verify and
   logout keep `apirl:auth:{ip}` at 5/min per IP (`AUTH_RATE_LIMIT_MAX`).
   Refresh no longer touches that key.

2. **Refresh gets a per-session budget of 60/min.** The key is
   `apirl:auth:refresh:{first 16 hex chars of sha256(cookie)}`. The raw token is
   never a key, so a Redis dump does not expose a usable credential. Sixty is
   comfortably above legitimate page loads and far below the budget needed to
   brute-force a 32-byte token.

3. **A coarse per-IP guard of 120/min precedes the session bucket.** Random
   cookies would otherwise mint an unbounded number of session keys. The IP
   guard (`apirl:auth:refresh:ip:{ip}`) is checked first, so a flood creates at
   most 120 session keys per minute per IP. Both counters are fixed 60 s
   windows.

4. **Anonymous refresh skips both auth buckets.** A request without a
   `dt_refresh` cookie cannot rotate anything and is answered 401 without
   creating a key. The global API limiter (60/min anonymous) still bounds
   overall traffic.

5. **The web client keeps `trendr.hasSession` in localStorage.** It is a
   non-sensitive boolean hint, never a credential: set after verification or a
   successful refresh, cleared on a definitive 401, sign-out or account
   deletion. With no hint, `refreshSession()` resolves to `null` without a
   network call, so anonymous page loads no longer hit the auth endpoint.

6. **Transient failures never destroy a valid session.** 429, 5xx, network
   errors and malformed success bodies leave the access token and hint intact
   and return no user for that attempt. Only a definitive 401 (other than
   `refresh-rotated`) clears them.

7. **Limits are code constants with test-only overrides.** Production keeps
   60/120; integration tests lower `refreshRateLimitMax` /
   `refreshIpRateLimitMax` through `AuthRoutesOptions` without adding env vars
   or new deployment knobs.

## Consequences

- The spec's “auth 5/min per IP for `/v1/auth/*`” now applies to magic-link,
  verify and logout; refresh has its own §10.5-adjacent budget. This is the
  deliberate deviation recorded as R-53.
- A user with a pre-existing cookie but no `trendr.hasSession` hint appears
  signed out until the next successful sign-in. The hint is shared by all tabs
  of the origin; the cookie itself is untouched and is replaced on the next
  login.
- Clearing site data while keeping a valid cookie has the same effect. The hint
  is an optimization; losing it can only cause one extra sign-in, never a
  security change.
- The IP guard is deliberately coarser than the session budget. A shared NAT
  with more than 120 refresh requests in a minute still hits 429, but that is
  far above normal browsing and remains a transient response that does not sign
  anyone out.
- The global anonymous limiter still caps refresh at 60/min/IP for visitors
  without a bearer token; the auth-specific budget is the one that guarantees
  the sign-in bucket cannot be exhausted by refresh.

## Tests

Integration (`apps/api/test/int/auth.int.test.ts`): refresh succeeds when the
strict bucket is already maxed; the session bucket trips at its configured
limit; anonymous refresh does not consume a bucket; random cookies trip the IP
guard. Web unit tests cover hint set/clear, 429/network preservation, and the
`refresh-rotated` retry.
