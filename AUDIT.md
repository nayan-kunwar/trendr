# Trendr Code Audit

**Date:** 2026-10-23  
**Baseline:** `986d31d` (`fix(ci): send the CSRF header in the auth smoke`)  
**Scope:** `apps/api`, `apps/worker`, `apps/web`, `apps/mcp`, `packages/*`, database schema/repositories, and the Compose/development deployment  
**Mode:** Static review plus targeted reproduction. No application source files were changed during the audit; remediation changes are recorded in the status notes below.

This document supersedes `BUGS.md`. The previous file was reviewed first; none of its entries were confirmed as written against the current tree, so its claims were not carried forward. Findings below are independently evidenced.

> **Remediation status (2026-10-23):** `C-03` and `C-04` were fixed after the baseline audit below. The finding text describes the pre-fix code; their `Status` lines record the fixes and test coverage. The remaining findings are unchanged.

## Severity scale

| Level      | Meaning                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------- |
| **High**   | Breaks a core feature in a normal deployment, or can materially undermine availability/security |
| **Medium** | Confirmed correctness or availability defect with a realistic trigger                           |
| **Low**    | Limited impact, deployment-specific, or defense-in-depth gap                                    |
| **Info**   | Known design trade-off or hardening note, not counted as a new defect                           |

## Summary

| ID   | Severity | Area                 | Finding                                                                     | Status |
| ---- | -------- | -------------------- | --------------------------------------------------------------------------- | ------ |
| C-01 | Medium   | API / Redis trending | Cursor pagination drops items tied at the page boundary                     | Fixed  |
| C-02 | Medium   | API / SQL trending   | Filtered cursors are not pinned to a scoring run                            | Fixed  |
| C-03 | High     | API / SSE            | Hijacked SSE response omits `Access-Control-Allow-Origin`                   | Fixed  |
| C-04 | High     | API / operations     | `/readyz` reports hardcoded success without probing dependencies            | Fixed  |
| C-05 | Medium   | API / availability   | `minCurrent` can force an unbounded full-board scan                         | Fixed  |
| C-06 | Medium   | Auth / admin         | Removing an email from `ADMIN_EMAILS` never demotes the stored admin role   | Fixed  |
| C-07 | Low      | Worker / operations  | `/healthz` always returns HTTP 200, even when Redis is disconnected         | Fixed  |
| C-08 | Low      | Auth / rate limiting | Auth guard uses `request.ip` instead of the shared trusted-client-IP helper | Fixed  |

`C-01`–`C-05` are ordinary defects. `C-06`–`C-08` are deployment/policy-sensitive; all confirmed findings now have a remediation in the tree.

## Confirmed findings

### C-01 — Redis leaderboard cursor skips entries tied at the page boundary

- **Severity:** Medium
- **Area:** `GET /v1/trending`, Redis board path
- **Location:** `apps/api/src/routes/trending.ts:338-360`, `:420-423`; `apps/api/src/schemas/common.ts:11`
- **Evidence:** The cursor stores `{ r, s, i }` (run, score, member), but the next-page read uses only `s`:

  ```ts
  const max = cursor === undefined ? '+inf' : `(${cursor.s}`;
  await app.redis.zrevrangebyscore(key, max, '-inf', ...);
  ```

  The leading `(` makes the score bound exclusive. Redis orders equal scores by member lexicographically, so every member at the boundary score is excluded, including members that were not returned on the previous page. The stored `i` value is never used.

- **Impact:** A board with more than `limit` items sharing the boundary score cannot be fully paginated; the remaining tied items are silently skipped. This is most likely with normalized/low-cardinality scores and is a correctness failure of the public pagination contract.
- **Verification:** Confirmed by code inspection. The existing integration test at `apps/api/test/int/trending.int.test.ts:508-536` uses distinct scores and does not exercise ties. A Redis instance was not available for a live reproduction.
- **Recommended fix:** Add the member tie-break to the read: fetch the boundary score inclusively and discard members that sort at or before the last returned member, or use a rank/lexicographic cursor that carries both `(score, member)`. Add an integration test with at least `limit + 1` equal scores.
- **Status:** **Fixed 2026-10-23.** The Redis path now uses the cursor member's `ZREVRANK` and continues with `ZREVRANGE` at `rank + 1`, which is tie-safe even when an entire page shares one score. A missing cursor member returns `410 cursor-expired` instead of silently skipping it. `apps/api/test/int/trending.int.test.ts` now paginates a three-item equal-score board one item at a time and verifies all three unique entries and absolute ranks.

### C-02 — Filtered SQL leaderboard cursors are not pinned to a scoring run

- **Severity:** Medium
- **Area:** `GET /v1/trending`, SQL fallback path
- **Location:** `apps/api/src/routes/trending.ts:522`, `:546`, `:613-623`; `apps/api/src/schemas/common.ts:10-12`; documented behavior at `docs/SPEC_REVIEW.md:343-349`
- **Evidence:** The SQL cursor is encoded as `{ k, i }` (board score, item id) with no run id. `querySqlPage` always calls `loadCurrentRun()` and joins `score_runs_current`, so a cursor created against run A is evaluated against whichever run is current when page 2 arrives. The Redis path, by contrast, stores `r` and rejects a different run with `CursorExpiredError` (`trending.ts:340-345`).
- **Impact:** A scoring swap between pages can mix two runs into one logical page sequence. Items can be skipped or duplicated, `runId`/`computedAt` can change mid-pagination, and the documented 410 `cursor-expired` behavior is not honored for filtered requests.
- **Verification:** Confirmed by code inspection. The existing stability test (`trending.int.test.ts:682-722`) rescored **npm** while reading **github** pages, so it does not cover a rebuild of the same board. No database-backed execution was available.
- **Recommended fix:** Add the run id to the SQL cursor (or use a common cursor shape) and return `CursorExpiredError` when it differs from the current run. Alternatively, pin the SQL query to the cursor's run id. Add a same-scope rebuild test for `topic`/`kind`/`minCurrent`/`newOnly` filters.
- **Status:** **Fixed 2026-10-23.** The SQL cursor now carries `r` (the scoring-run identity); `querySqlPage` resolves the current run before reading and returns `410 cursor-expired` when the cursor's run differs. For `scope=all`, which spans one run per source, `r` is a fingerprint of the current per-source run set and the query is pinned to that captured set of run ids. Legacy cursors without `r` fail closed rather than being evaluated against a possibly different run. `apps/api/test/int/trending.int.test.ts` covers both a same-source rebuild (`kind=repo`) and a combined-board source swap (`minCurrent=90`), restores the fixture run in each case, and verifies the 410 response.

### C-03 — SSE responses bypass CORS headers

- **Severity:** High
- **Area:** `GET /v1/stream/leaderboard`; web live leaderboard
- **Location:** `apps/api/src/routes/stream.ts:144-151`; CORS registration at `apps/api/src/plugins/security.ts:46-63`; client `apps/web/src/components/live-leaderboard.tsx:90`; stream URL construction at `apps/web/src/lib/api.ts:34`, `:138`
- **Evidence:** The route calls `reply.hijack()` and writes response headers directly with `raw.writeHead()`. That bypasses the headers `@fastify/cors` attached to the Fastify reply. The SSE response therefore has no `Access-Control-Allow-Origin`, while the web app creates a cross-origin `EventSource` (default web origin `http://localhost:3000`, API `http://localhost:4000`; production deployments use separate public origins unless a same-origin proxy is configured).
- **Impact:** Browsers block the EventSource response as a CORS failure. The live leaderboard stays in its reconnect loop and never receives snapshots or updates. The initial server-rendered leaderboard still works, which makes the failure easy to miss.
- **Verification:** Reproduced with an isolated Fastify app and `@fastify/cors`: a hijacked route returned HTTP 200 but `Access-Control-Allow-Origin` was `null`. The real API could not be started with Redis in this environment, but the header path is identical.
- **Recommended fix:** Before `raw.writeHead`, set the appropriate `Access-Control-Allow-Origin` (and `Vary: Origin` when reflecting) for public GET requests, or avoid hijacking the reply until CORS has committed headers. Add an integration/HTTP test that asserts the SSE response carries the CORS header for the configured web origin.
- **Status:** **Fixed 2026-10-23.** `apps/api/src/routes/stream.ts` now snapshots `reply.getHeaders()` (including headers attached by `@fastify/cors`) and merges them into the raw `writeHead()` call before hijacking. `apps/api/test/int/stream.int.test.ts` asserts `Access-Control-Allow-Origin: *` on the SSE response and passes against the Testcontainers fixture. The full unit suite, typecheck, and lint also pass.

### C-04 — `/readyz` is hardcoded and cannot detect dependency failure

- **Severity:** High (operational)
- **Area:** API readiness and Compose health checking
- **Location:** `apps/api/src/routes/health.ts:3-13`; test `apps/api/src/app.test.ts:52-61`; Compose check `docker-compose.yml:60-66`
- **Evidence:** The route returns a constant body:

  ```ts
  app.get('/readyz', () => ({
    status: 'ready',
    checks: { db: 'ok', redis: 'ok', migrations: 'ok' },
  }));
  ```

  No database query, Redis command, or migration check is performed. The existing test asserts the same hardcoded values. Compose uses this endpoint as the API healthcheck, so a running API process is considered ready even if Postgres is unavailable, Redis is down, or migrations are missing.

- **Impact:** Orchestrators and Compose keep routing traffic to an API that cannot serve most requests. Failures surface as 500/503 responses instead of removing the instance from service. The source comment describes the checks as future Phase 1 work, and `docs/SPEC_REVIEW.md:296` refers to a future degraded report, but Phase 9 is complete and the endpoint currently claims success.
- **Verification:** Confirmed from route and Compose configuration; the endpoint was not exercised against a downed database because no database was available.
- **Recommended fix:** Inject real probes (for example `SELECT 1`, `PING`, and a migration-version check), return 503 with per-check failure details, and test both ready and degraded cases. Keep `/healthz` as a process-liveness endpoint if desired.
- **Status:** **Fixed 2026-10-23.** `apps/api/src/routes/health.ts` now probes PostgreSQL (`SELECT 1`), Redis (`PING`), and the Drizzle journal (`drizzle.__drizzle_migrations`) with a 2-second timeout per probe. It returns `200 { status: 'ready' }` only when all checks pass and `503 { status: 'degraded', checks }` otherwise. `apps/api/src/app.test.ts` covers absent dependencies and successful probes; `apps/api/test/int/health.int.test.ts` verifies the real ready path and a real Postgres/no-Redis degraded path against Testcontainers. Typecheck, lint, the full unit suite (77 files / 564 tests), and both targeted integration tests pass.

### C-05 — `minCurrent` can force an unbounded full-board scan

- **Severity:** Medium (availability)
- **Area:** `GET /v1/trending` public API
- **Location:** `apps/api/src/schemas/trending.ts:31`; `apps/api/src/routes/trending.ts:469-512`, `:550-607`
- **Evidence:** `minCurrent` has no upper bound (`z.coerce.number().int().nonnegative().optional()`). It is applied only after each SQL batch is hydrated by `loadCardItems()` and `loadCardSeries()`. If the value is above every item's current metric, every batch is filtered out, the scan advances by `limit + 1` rows, and the loop repeats until the entire board is exhausted (`trending.ts:591-607`). Each iteration performs multiple SQL queries, and distinct `minCurrent` values bypass the `q:{sha1}` cache.
- **Impact:** An unauthenticated caller can issue requests such as `?minCurrent=1000000000&limit=100` and make the API scan and hydrate the whole current board. At scale this is a cheap denial-of-service primitive against the public endpoint and its database.
- **Verification:** Confirmed by code inspection. The integration test at `trending.int.test.ts:604-627` uses a small board and a value that filters only one item, so it does not exercise the unbounded path. No database-backed load test was available.
- **Recommended fix:** Put a reasonable maximum on `minCurrent`, pre-filter in SQL using the current series value rather than filtering after hydration, or impose a bounded scan/time budget and return a clear error rather than scanning the whole board. Add a large-board test with a value above every current metric.
- **Status:** **Fixed 2026-10-23.** `apps/api/src/routes/trending.ts` now caps the SQL top-up loop at `MAX_SQL_SCAN_ROWS = 2_000` and throws a new `QueryTooBroadError` (`422`, `query-too-broad`) when the budget is exhausted before a page fills. The budget is injectable for tests; `apps/api/test/int/trending.int.test.ts` uses a two-row budget with `minCurrent=1000000` and asserts the problem+json response, while the existing top-up coverage still verifies the normal path. `docs/SPEC_REVIEW.md` documents the budget and the narrower-filter remedy.

### C-06 — Admin role is never revoked when an email is removed from `ADMIN_EMAILS`

- **Severity:** Medium (security / policy-dependent)
- **Area:** Authentication and authorization
- **Location:** `packages/db/src/repositories/users.repo.ts:23-65`; `apps/api/src/services/auth.service.ts:47-54`, `:101-106`
- **Evidence:** `ensureUserForLogin()` promotes an existing user to `admin` when `isAdmin` is true, but its non-admin path simply returns the existing row. `markUserVerified()` only adds `role: 'admin'` when `isAdmin` is true; it has no `else` branch to demote. Consequently, a user whose email is removed from `ADMIN_EMAILS` remains `role = 'admin'` in the database and receives an admin JWT on future logins/refreshes.
- **Impact:** If `ADMIN_EMAILS` is the source of truth for administrator access, removing an address does not revoke that account's admin API and job controls. Access persists until the role is changed manually or the row is deleted. This is a revocation failure, not merely a display issue.
- **Verification:** Confirmed by code inspection; no demotion path exists in the reviewed repositories/routes.
- **Recommended fix:** Treat the configured email list as authoritative on issuance/verification and set the role explicitly to `admin` or `user` each time, or provide a separate explicit role grant/revoke workflow and document that removing an email does not revoke a stored role. If demotion is added, consider invalidating active access tokens (currently valid for the configured 15-minute TTL).
- **Status:** **Fixed 2026-10-23.** `ADMIN_EMAILS` is now authoritative: `ensureUserForLogin()` and `markUserVerified()` explicitly set `admin`/`user`, and `rotateRefreshToken()` re-evaluates the list and calls the new `setUserRole()` before minting the refreshed session. `apps/api/test/int/auth.int.test.ts` verifies both refresh-time and fresh magic-link demotion. Existing access JWTs keep their signed role until the 15-minute TTL expires; this is documented in `docs/SPEC_REVIEW.md`.

### C-07 — Worker `/healthz` always returns HTTP 200

- **Severity:** Low (operational)
- **Area:** Worker observability / Compose health check
- **Location:** `apps/worker/src/metrics-server.ts:87-93`; `apps/worker/src/main.ts:174-178`; `docker-compose.yml:85-91`
- **Evidence:** The worker health handler always calls `respond(response, 200, ...)` and hardcodes `status: 'ok'` in the body. `getHealth()` does report `redis: 'disconnected'` and `schedulerRegistered: false`, but those values do not affect the status code. Compose checks only `r.ok`.
- **Impact:** A worker that has lost Redis (and therefore cannot process BullMQ jobs) remains "healthy" to Compose and will not be restarted or flagged. Monitoring must parse the body rather than rely on the healthcheck.
- **Verification:** Confirmed in code; the existing worker test explicitly expects a 200 when `redis` is `'disconnected'` (`apps/worker/test/int/metrics-server.int.test.ts:36-43`), so the behavior is intentional/liveness-oriented but is used as dependency health in Compose.
- **Recommended fix:** Decide whether this is liveness or readiness. If it is readiness, return 503 when Redis is disconnected or the scheduler is not registered, and add a separate liveness endpoint if needed. Update the Compose check accordingly.
- **Status:** **Fixed 2026-10-23.** `/healthz` remains liveness and still reports the structured state; a new `/readyz` returns 200 only when Redis is connected and 503 `degraded` otherwise. Compose now checks `/readyz`, and `apps/worker/test/int/metrics-server.int.test.ts` covers both readiness states while retaining the `/healthz` liveness expectations. Scheduler registration is reported in the body; it is not used as a readiness gate because non-scheduler worker roles legitimately register none.

### C-08 — Auth rate limiting does not use the shared trusted-client-IP helper

- **Severity:** Low (deployment-sensitive)
- **Area:** `/v1/auth/*` rate limiting
- **Location:** `apps/api/src/routes/auth.ts:114-117`, `:303-325`; helper at `apps/api/src/plugins/rate-limit.ts:27-36`
- **Evidence:** `authRequestGuard()` calls `allowAuthRequest(app, request.ip, ...)`. The general rate limiter uses `clientIp(request, trustProxy)`, which trusts `CF-Connecting-IP` only when `TRUST_PROXY` is enabled. Auth therefore behaves differently depending on how Fastify's `trustProxy` setting interacts with the actual edge proxy.
- **Impact:** With a proxy and `TRUST_PROXY=false`, all users can collapse into one 5-requests/minute bucket (availability). With `trustProxy=true` and insufficient proxy hygiene, forwarding headers can be used to rotate identities and bypass the auth limit (abuse, including magic-link email spam). The per-email limit still limits messages to any one address, but does not stop broad enumeration/spam.
- **Verification:** Confirmed by code inspection; no live proxy setup was available to reproduce either direction.
- **Recommended fix:** Pass the same `trustProxy` setting into the auth route and key the guard with `clientIp(request, trustProxy)`, matching the general limiter. Document the required proxy header behavior and add tests for both trusted and untrusted modes.
- **Status:** **Fixed 2026-10-23.** `registerAuthRoutes` now receives the app's `trustProxy` setting and uses `clientIp()` for both the auth guard key and the magic-link audit IP instead of raw `request.ip`. `apps/api/src/app.test.ts` verifies that distinct trusted `CF-Connecting-IP` values get separate buckets and that the header is ignored when the proxy is untrusted. `docs/SPEC_REVIEW.md` documents the shared derivation.

## Known or accepted gaps

These are real limitations, but they are documented or intentionally tested in the current tree. They are listed separately so they are not presented as newly discovered defects. `K-01` has since been resolved; the remaining entries are still accepted.

### K-01 — Combined-board `entry.score` differs between HTTP paths and SSE (resolved)

- **Location:** `docs/SPEC_REVIEW.md:350-354`; `apps/worker/src/scoring/publish-leaderboards.ts:323-332`; `apps/api/src/routes/trending.ts:397`; test `apps/api/test/int/trending.int.test.ts:719-757`
- **Behavior:** The combined board's Redis ZSET is scored by `zScore`, but the combined board is published without cards. The HTTP Redis path hydrates missing entries with `useZScore = false`, so it serves `finalScore`; the SQL filtered path serves `zScore`. The SSE snapshot reads the ZSET scores directly, so it serves `zScore`. `LeaderboardEntrySchema` says the combined board should carry `zScore` (`packages/core/src/leaderboard.ts:45-46`).
- **Status:** **Fixed 2026-10-23.** The Redis read now treats the ZSET score as authoritative for every combined-board entry, including entries whose cards came from a source board, and hydrates missing combined entries with `z_score`. The integration test asserts that Redis and SQL combined reads return identical `(externalId, rank, score)` tuples.

### K-02 — Trigram search fallback is intentionally sequential

- **Location:** `packages/db/src/repositories/search.repo.ts` (trigram fallback); `docs/SPEC_REVIEW.md:472-480`
- **Behavior:** The fallback uses `word_similarity(lower($q), lower(display_name)) > 0` and excludes FTS matches. The documentation states that this scan is sequential by design and should be revisited as the item count grows. It is a scaling/availability risk for unusual low-hit queries, not an unnoticed functional bug.

### K-03 — Some upstream homepages are stored as raw URLs

- **Location:** `packages/sources/src/npm/npm.adapter.ts:222`, `:271`; `packages/sources/src/pypi/pypi.adapter.ts:177-188`, `:237`; `packages/sources/src/github/github.adapter.ts:181`; API schema `apps/api/src/schemas/items.ts:40`; render `apps/web/src/components/item/item-facts.tsx:52-56`
- **Behavior:** These adapters pass the upstream homepage through `cleanString()` but do not require an `http:`/`https:` scheme. The API exposes it as a nullable plain string, and the web renders it as an anchor. React 19 blocks `javascript:` execution and the web CSP is restrictive, so the practical impact is limited to unusual-scheme navigation/phishing rather than script execution. arXiv and MCP already use `safeHomepage`/`safeHttpUrl`; GitHub/npm/PyPI do not.
- **Recommendation:** Reuse an `http:`/`https:` URL validator for every adapter and reject everything else; add `rel="noopener noreferrer"` where links open a new tab (the item-facts link already has it).

### K-04 — Metrics bearer tokens are compared with `!==`

- **Location:** `apps/api/src/plugins/metrics.ts:92`; `apps/worker/src/metrics-server.ts:97`
- **Behavior:** The metrics endpoints compare the full `Authorization` string directly. The tokens are supposed to be high-entropy, so a practical timing attack is unlikely; use `crypto.timingSafeEqual` with a length guard as defense-in-depth.

### K-05 — Compose development defaults are not safe for public exposure

- **Location:** `docker-compose.yml:19-31` (Postgres/Redis published), `:116` (MCP published); optional MCP auth at `apps/mcp/src/http.ts:52-61`; `.env.example:22`
- **Behavior:** The development stack publishes Postgres `5432`, Redis `6379`, and MCP `4100` on the host and uses development credentials/configuration. Redis has no authentication and can inject leaderboard events or manipulate queues/cache if reachable; Postgres exposes all data. This is documented local-development configuration, not a code defect, but it must not be used as a production deployment topology.

## Hardening recommendations

1. **SSE headers (C-03 addressed):** The fix copies plugin headers before hijacking. Retain that behavior and add `Vary: Origin` if the public policy ever reflects an origin; keep security headers in the copied set.
2. **Readiness (C-04 addressed):** Keep the dependency probes fail-closed and retain degraded/503 coverage as dependencies evolve. Keep liveness and readiness distinct.
3. **Auth/admin revocation (C-06 addressed):** `ADMIN_EMAILS` is authoritative on issuance, verification, and refresh. Existing access JWTs retain their role until the 15-minute TTL; add token-family invalidation if immediate revocation is required.
4. **Public query bounds (C-05 addressed):** The SQL top-up loop is capped at 2,000 scanned rows and returns 422 `query-too-broad` when a selective filter exhausts the budget. Keep large-board coverage and revisit the budget if the public board grows.
5. **Search scaling:** Revisit the documented sequential trigram fallback before large item counts; use `EXPLAIN` to confirm index use.
6. **Rate limiting:** Use one trusted-client-IP implementation for all tiers; document proxy requirements. Note that the general limiter is fail-open when Redis is unavailable (`docs/SPEC_REVIEW.md:301-305`).
7. **Link hygiene:** Restrict stored/rendered URLs to `http`/`https`.
8. **Deployment:** Do not expose Postgres, Redis, or the MCP port publicly; require MCP authentication outside local development and keep the default credentials out of shared environments.
9. **Metrics:** Use constant-time bearer comparison even though the token is high-entropy.

## Verification notes and limitations

- Repository state at audit baseline: `986d31d`; no application source files were modified during the audit. The `C-01`–`C-04` fixes and their tests were added afterward.
- `C-03` was reproduced with a minimal Fastify + `@fastify/cors` hijack route (HTTP 200, `access-control-allow-origin` absent). The fix now passes the real `apps/api/test/int/stream.int.test.ts` case against Testcontainers.
- `C-01` and `C-02` were confirmed by code inspection at audit time and are now covered by Redis/Postgres integration tests: equal-score pagination, same-source SQL cursor rebuild, and combined-board source swap. `C-05`/`C-06` are covered by targeted integration tests, and `C-07`/`C-08` by unit/integration tests. At audit time, database/Redis-backed integration execution was not possible: native PostgreSQL on `5432` rejected the `trendr:trendr` credentials, no Docker containers were running, and no Redis was listening on `6379`.
- During remediation, Testcontainers Postgres/Redis became available: `apps/api/test/int/trending.int.test.ts` (14 tests), `apps/api/test/int/auth.int.test.ts` (6 tests), `apps/api/test/int/stream.int.test.ts` (2 tests), and `apps/api/test/int/health.int.test.ts` (ready plus Postgres-only degraded) pass. The worker metrics-server integration test (6 tests), the full unit suite (77 files / 566 tests), and API/worker typecheck and lint pass.
- Release-gate verification on 2026-10-23: monorepo typecheck and lint, the full unit suite (77 files / 566 tests), the full integration suite (30 files / 149 tests), and the production build pass. Contract probes were skipped by design because `CONTRACT=1` and upstream tokens were not configured. `K-01` is covered by the combined-board Redis/SQL consistency assertion.
- The existing tests generally use small fixtures and distinct scores; the gaps noted above explain why the remaining defects were not caught.
- `BUGS.md` has been removed and replaced by this audit.
