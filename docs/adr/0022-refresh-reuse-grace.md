# ADR-0022 — Refresh reuse grace window

- Status: Accepted (Phase 2)
- Date: 2026-11-03
- Spec: §10.5 (deviation, recorded as R-52)
- Finding: H-2

## Context

Spec §10.5 says that reusing an already-used refresh token revokes the whole
token family. That is the right response to theft, but the web client calls
`POST /v1/auth/refresh` on every hard load and the previous single-flight guard
(`refreshInFlight`) only covered one tab. Two tabs, a session restore, or a
retried request could present the same cookie at the same time:

1. the first request rotates the token and sets `used_at`;
2. the second blocks on `FOR UPDATE`, sees `used_at`, revokes the family —
   including the successor the first request just issued;
3. the route clears the refresh cookie, so every tab is signed out and needs a
   new magic link.

This is a routine race, not an attack. The family-level response must stay for
genuine reuse, but immediately destroying a valid session on a multi-tab race
is a availability bug.

## Decision

1. **A 15 s grace window classifies the immediately previous token as a race.**
   `rotateRefreshToken` returns a typed outcome:
   - `rotated` — a new session was issued;
   - `grace` — the token was used no more than 15 s ago and its row is not
     revoked;
   - `invalid` — with a reason (`missing`, `unknown`, `expired`, `revoked`,
     `reused`), so the caller can distinguish theft from an ordinary bad cookie.

2. **The grace response carries no token material.** The route answers
   `401 application/problem+json` with type
   `https://trendr.dev/problems/refresh-rotated` and `Retry-After: 1`. It does
   **not** clear the browser cookie: the winner's `Set-Cookie` is already the
   current cookie in the shared jar.

3. **Outside the window the spec behaviour is unchanged.** A used token older
   than 15 s revokes every token in its family and returns `unauthorized`. A
   token whose family was already revoked (logout or earlier theft) stays dead.

4. **The web client retries once on `refresh-rotated`.** It waits 150 ms so the
   other tab's `Set-Cookie` can land, then posts again with the current cookie.
   Concurrent refreshes are serialized with the Web Locks API
   (`trendr.auth.refresh`); browsers without Web Locks get a best-effort
   BroadcastChannel announcement, with the typed retry as the correctness
   backstop. A refresh that is still `grace` after the retry returns no user
   but preserves the access token and session hint.

5. **Observability.** Every grace and theft-classified reuse increments
   `trendr_auth_refresh_reuse_total{outcome="grace"|"theft"}`. A sustained rise
   in `theft` is a credential-replay signal; a rise in `grace` indicates client
   refresh stampedes.

## Consequences

- A stolen used token replayed inside the grace window is answered with 401 and
  does not obtain a session. It also does not trigger revocation during those
  15 s; replayed after the window, it revokes the family as before. The window
  is short and carries no credential material.
- A completely lost rotation response still requires re-authentication. Returning
  the successor token from the old cookie would require storing raw token
  material, which §10.5 forbids.
- Multi-tab reloads no longer sign the user out. Each tab that refreshes after
  another tab still rotates the chain once; the family stays valid because the
  serialized requests present the current cookie.
- The spec's absolute phrase “reusing a used refresh token revokes the whole
  family” now has a 15 s exception; §10.4's session contract is otherwise
  unchanged.

## Tests

Integration (`apps/api/test/int/auth.int.test.ts`): parallel refresh with one
cookie yields one 200 and one typed `refresh-rotated` 401, the successor still
works, the grace response sets no cookie, and reuse after backdating `used_at`
16 s revokes the family. Web unit tests, added with the client half of the fix,
cover the single retry, the preserved session on repeated grace, and the Web
Locks single-flight.
