# Production-readiness review remediation

**Date:** 2026-11-03  
**Status:** In progress — Phases 1–5 verified locally; Phases 6–9 planned  
**Reviewed commit:** `2ad0396` (2026-11-02)  
**Source:** `Trendr production-readiness review.pdf` (9 pages)  
**Scope:** all 27 findings — 0 Critical, 4 High, 12 Medium, 11 Low.

Related documents: [`SPEC_REVIEW.md`](./SPEC_REVIEW.md), [`REMEDIATION_PLAN.md`](./REMEDIATION_PLAN.md),
[`runbook.md`](./runbook.md), [`docs/adr/`](./adr), [`TRENDR_SPEC.md`](../TRENDR_SPEC.md).

## Summary

The review's verdict is **“Ready with conditions.”** The foundation is sound — strict TypeScript,
layered API, idempotent ingestion, SSRF allowlist, user-scoped queries and a working observability
stack. The findings concentrate at the seams: the proxy/IP trust boundary, the refresh-session
lifecycle, one ingestion edge case, and operations (backups, release gating, retention).

The review box had no Docker, Postgres or Redis, so its High findings were reasoned from code and
**not executed**. This repository environment does have Docker, so the first implementation step
is to reproduce H-2 and H-4 as failing integration tests before changing production code.

## Review limitations

- The PDF stops mid-sentence on page 9 at “the unpinned actions and the”. The Recommendations,
  Final verdict and Scope sections are missing.
- Only the four High findings have detailed write-ups. Medium and Low findings exist as
  table-level one-liners; every remediation below was derived from that one-liner plus code
  inspection.
- The review ran unit tests on Node 24.22.1 (the repo targets Node 22), and could not run the
  Testcontainers suite. Its unit-test result (79 files / 577 tests) matches the local baseline.
- The review could not execute any finding. The High findings and the SQL/index findings were
  re-checked against the code and query plans here; each remaining finding gets a reproduction
  test in its phase before the fix lands.

## How to read this document

Each finding has a phase and a status. Status values are `Planned`, `In progress`, `Fixed`,
`Verified` and `Deferred`. A finding is only `Verified` when its regression test and the phase
gates pass; live-deployment acceptance is tracked separately in
[`REMEDIATION_PLAN.md`](./REMEDIATION_PLAN.md).

---

## Findings ledger

### High

| ID  | Finding | Evidence | Planned remediation | Phase | Status |
| --- | --- | --- | --- | --- | --- |
| H-1 | Per-IP controls trust a client-supplied `CF-Connecting-IP`; the origin is reachable directly | `apps/api/src/plugins/rate-limit.ts:28-35`; `infra/nginx/trendr.conf:68-116`; `infra/scripts/bootstrap-vps.sh:99-105` | nginx overwrites the header after `real_ip`; API accepts only a parseable IP and falls back to `request.ip`; UFW allows 80/443 only from Cloudflare ranges | 1 | Verified |
| H-2 | Refresh reuse detection has no grace window, so concurrent refreshes revoke the whole family | `apps/api/src/services/auth.service.ts:116-148`; `apps/web/src/lib/auth.ts:33-39`; `apps/web/src/components/auth-provider.tsx:30-40` | 15 s grace returns a typed 401 without revoking or clearing; Web Locks single-flight across tabs; typed one-shot client retry; parallel-refresh test | 2 | Verified |
| H-3 | One 5/min-per-IP auth bucket is shared with the refresh call that runs on every page load | `apps/api/src/routes/auth.ts:162-167,352-374` | Keep 5/min on magic-link, verify and logout; refresh gets 60/min per presented-cookie hash plus a 120/min per-IP guard; anonymous refresh skips it; the web client uses a non-sensitive hint and treats 429/5xx as transient | 2 | Verified |
| H-4 | Rename-back (A→B, then B→A) breaks the ingestion chunk with a unique violation on every retry | `packages/db/src/repositories/items.repo.ts:235-315,128-131`; `packages/db/migrations/0000_init.sql:282`; `apps/worker/src/ingestion/upsert.ts:63-182` | Stub-aware merge on rename-back; in-chunk dedupe; per-item failure isolation | 3 | Verified |

### Medium

| ID   | Finding | Evidence | Planned remediation | Phase | Status |
| ---- | --- | --- | --- | --- | --- |
| M-1  | Unauthenticated trigram search cannot use its index and scans the whole `items` table per distinct query | `packages/db/src/repositories/search.repo.ts:166-194`; `items_name_trgm_idx` is on raw `display_name`, the query uses `lower(display_name)` | Functional GIN index on `lower(display_name)`; indexable `%>` predicate; confirmed with `EXPLAIN` | 4 | Verified |
| M-2  | API-key check runs before the rate limiter, with an uncached database lookup per request | `apps/api/src/plugins/api-key.ts:72-98`; plugin order in `apps/api/src/app.ts` | Short Redis cache for key lookups with explicit invalidation; nginx `limit_req`/`limit_conn` flood guard | 6 | Planned |
| M-3  | Scoring lock expires after 120 s with no renewal, the current-run swap is unconditional, and a skipped run reports success | `apps/worker/src/scoring/run-scoring.ts:50,109-115,310-313` | Renew the lock; monotonic swap; return an explicit `skipped` result and metric | 5 | Verified |
| M-4  | Missing indexes on `scores(run_id)` and `alert_events(score_run_id)` make retention and FK checks scan | `packages/db/src/repositories/retention.repo.ts:39-60`; `0000_init.sql` index list | Add both indexes in one migration; `EXPLAIN` before/after | 4 | Verified |
| M-5  | SSE connection counter leaks on crash, locking users out for up to 24 h | `apps/api/src/routes/stream.ts:27,125-142,185-196` | 90 s lease refreshed by the 25 s heartbeat; decrement-once; expiry test | 6 | Verified |
| M-6  | No audit trail for admin mutations | `apps/api/src/services/admin.service.ts:475-495` | `admin_audit_log` written in the same transaction as each mutation | 6 | Planned |
| M-7  | Config validation lets a non-functional or weak production configuration boot | `packages/config/src/env.ts:27-35,66-68,81-103` | Production-only guardrails plus bounded token lifetimes | 6 | Verified |
| M-8  | Backup and disaster-recovery posture is weak for a single-VPS deployment | `infra/scripts/backup.sh:54-78` | Require offsite + encryption in production; verify the dump; add a restore drill and stale-backup alert | 7 | Planned |
| M-9  | Release pipeline is not gated on CI and ships unpinned, unsigned images | `.github/workflows/publish.yml`; `docker-compose.prod.yml:84` (`:latest` fallback) | Reusable CI prerequisite, SHA-pinned actions, SBOM/Trivy/cosign, explicit `TRENDR_TAG` | 7 | Planned |
| M-10 | One chunk is one transaction with no in-chunk de-duplication or per-item isolation | `apps/worker/src/ingestion/upsert.ts:63-122` | Dedupe by natural key; per-item retry isolation on chunk failure | 3 | Verified |
| M-11 | Partition maintenance only creates the current month plus three, risking a blocked create when data lands in the default partition | `apps/worker/src/processors/maintenance.processor.ts:119-130` | Create 12 months ahead; guard the default partition; alert on short lead time | 4 | Verified |
| M-12 | Render blueprint: proxy trust unverified and memory headroom thin | `render.yaml:53-54` | Verify Render's edge behavior against its docs; keep `TRUST_PROXY` only if proxy-only; raise memory and shutdown settings | 7 | Planned |

### Low

| ID   | Finding | Evidence | Planned remediation | Phase | Status |
| ---- | --- | --- | --- | --- | --- |
| L-1  | Non-atomic `INCR` then `EXPIRE`, and unbounded in-memory fallback maps | `apps/api/src/routes/auth.ts:72-73,334-335,359-360` | Lua `INCR`+`EXPIRE`; cap and evict the fallback map | 2 | Verified |
| L-2  | Wrong contact URL in the default User-Agent, and console output in the log email sender | `packages/config/src/env.ts:44` (`nayankunwar` vs `nayan-kunwar`); `packages/email/src/index.ts:86` | Correct the URL; inject the logger | 8 | Planned |
| L-3  | Supply-chain and container-hardening gaps | `.github/workflows/ci.yml`; `infra/docker/node.Dockerfile` | Pin actions and base images by digest; non-root runtime; `no-new-privileges`, drop capabilities | 7 | Planned |
| L-4  | API-key count cap is a check-then-insert race | `apps/api/src/services/api-key.service.ts:63-83` | Serialize per user with `pg_advisory_xact_lock`; parallel-create test | 7 | Planned |
| L-5  | Error masking in run bookkeeping | `apps/worker/src/scoring/run-scoring.ts` catch path; `apps/worker/src/processors/ingest.processor.ts:118-124` | Never let bookkeeping replace the job error; log both; leave no `running` rows | 5 | Verified |
| L-6  | No bounds on token lifetimes | `packages/config/src/env.ts:28-29` | Bound access-token seconds and refresh days | 6 | Verified |
| L-7  | RFC 7807 titles for 413 and 415 fall back to a generic value | `apps/api/src/plugins/errors.ts` | Add both titles and problem types; inject tests | 6 | Verified |
| L-8  | Scoring runs after every batch, so boards can reflect partial data; admin edits do not refresh leaderboards | `apps/worker/src/processors/ingest.processor.ts:564-568`; admin item patch | Delay ingest-triggered scoring to the batch window; keep admin triggers immediate; invalidate caches on edits | 5 | Verified |
| L-9  | The all-board rebuild loads every current score row into memory | `apps/worker/src/scoring/run-scoring.ts:326-385` | Top-K-per-source window query, then the existing `buildAllBoard` | 5 | Verified |
| L-10 | Unbounded growth: `daily_metrics`, failed-job records and topic recompute cost | `packages/core/src/queues.ts:151-156`; `render.yaml:77` | `daily_metrics` 400-day prune (spec §6.5), bounded `removeOnFail`, measure topic recompute | 7 | Planned |
| L-11 | Global rate limiter fails open when Redis is unavailable | `apps/api/src/plugins/rate-limit.ts:82-92` (`skipOnError`) | Keep the spec's fail-open behavior but add a metric, error log and alert | 6 | Verified |

---

## High findings in detail

### H-1 — the client IP is spoofable and the origin is exposed

**Mechanism.** nginx resolves the real client address from Cloudflare ranges, then overwrites
`X-Forwarded-For` and `X-Real-IP` with `$remote_addr`. It does **not** overwrite
`CF-Connecting-IP`. With `TRUST_PROXY=true`, `clientIp()` returns that raw header whenever it is
non-empty, so a direct-to-origin request controls its own rate-limit identity. `ufw` currently
allows 80/443 from anywhere, so the origin is reachable without going through Cloudflare.

**Impact.** Rotating the header per request bypasses the anonymous, user, admin and auth buckets
and the SSE per-IP cap. Setting it to a victim's address exhausts that victim's bucket and blocks
their sign-in. A non-IP string also reaches the `auth_tokens.created_ip` `inet` write.

**Reproduction.** Unit-test `clientIp` with a forged header; then run a compose-level curl loop
against the API with `TRUST_PROXY=true` and distinct forged addresses and observe that no 429 is
returned.

**Fix.** nginx sets `proxy_set_header CF-Connecting-IP $remote_addr` after `real_ip` processing;
the API validates the value with `net.isIP` and falls back to `request.ip`; UFW allows 80/443 only
from Cloudflare's published ranges, refreshed by a timer. Authenticated Origin Pulls is the
stronger alternative and is documented in the runbook.

**Tests.** IPv4/IPv6/garbage/missing header cases; nginx config check; a compose curl that proves
a forged header no longer changes the identity.

### H-2 — concurrent refresh revokes the whole family

**Mechanism.** `AuthProvider` calls `POST /v1/auth/refresh` on every hard load. The module-level
`refreshInFlight` dedupes only within one tab. The first request rotates and sets `used_at`; the
second blocks on `FOR UPDATE`, sees the used token, revokes the family (including the just-issued
successor), and the route clears the cookie.

**Impact.** Two tabs, a browser session restore, or a lost response logs the user out everywhere
and requires a new magic link — the normal restored-session path, not an edge case.

**Reproduction.** Integration test: verify a magic link, then fire two parallel refresh requests
with the same cookie; assert that the successor cookie no longer works on the current code.

**Fix.** A 15 s grace window. A used token inside the window returns a typed
`refresh-rotated` 401 with `Retry-After`, without revoking the family and without clearing the
cookie. Outside the window, revocation stays as today. The web client retries once on that type
and uses Web Locks (with a BroadcastChannel fallback) for cross-tab single-flight. The ADR records
the limitation: a completely lost response still requires re-authentication, because returning the
successor token would require storing raw token material.

**Tests.** Parallel refresh (one 200, one typed 401, successor still valid); grace retry; reuse
outside the window revokes; logout still revokes; web single-flight unit tests.

### H-3 — refresh shares the 5/min auth bucket

**Mechanism.** `authRequestGuard` covers magic-link, verify, refresh and logout. The refresh call
is sent for every visitor on every hard load, including visitors with no cookie. The sixth request
in a minute returns 429, and `doRefresh` treats any non-OK response as signed out.

**Impact.** Behind shared NAT or CGNAT, a handful of visitors can make logged-in users appear
signed out and block sign-in attempts. A refresh-happy user has the same effect alone.

**Reproduction.** Six refresh requests in a minute from one IP → 429; confirm the web client
clears its access token and shows signed out.

**Fix.** Magic-link and verify keep 5/min. Refresh gets a much higher bucket (60/min) keyed by a
short SHA-256 of the refresh cookie, with a coarse per-IP guard so random-cookie floods cannot
create unbounded Redis keys. Refresh requests without a cookie skip the limiter entirely. The web
client keeps a non-sensitive local session hint and treats 429/5xx as transient, never clearing a
valid session.

**Tests.** Auth bucket still trips at 5; refresh bucket trips at 60; anonymous refresh does not
consume a bucket; web hint set/clear; 429 does not clear the access token.

### H-4 — rename-back poisons every chunk with a unique violation

**Mechanism.** A→B moves the live row to B and creates a cold stub at A with `upstream_id = NULL`.
On B→A, `applyItemRename` finds the stub as the target and returns `target-exists` before the
existing “reuse it” branch. The following upsert conflicts on `(source, external_id)` with the
stub and sets `upstream_id = coalesce(excluded.upstream_id, …)` — the same node id the live row
still holds. The partial unique index `items_source_upstream_uq` raises 23505 and aborts the whole
chunk transaction.

**Impact.** Every item in the chunk loses its snapshots on every retry and every cycle until the
job reaches the DLQ. One renaming repository stalls the freshness of up to `batchSize` unrelated
items.

**Reproduction.** Integration test: seed a tracked item with a node id, apply A→B, then apply B→A
with snapshots. Assert 23505 on the current code, then one live row, continuous snapshots and a
correct stub after the fix. Add a two-item name-swap variant.

**Fix.** Merge the target stub into the live row: repoint or dedupe `watchlist_items`, move
non-self alias rows, delete the stub, rename the live row, then create a new stub for the old name.
Keep the live row's id so snapshot, score and watchlist history survive. For cycles and swaps,
stage affected rows through temporary external ids inside the same transaction. Dedupe normalized
items by `(source, external_id)` before the batch upsert, and retry per item when a chunk still
fails so one poison item cannot roll back the rest.

**Tests.** Rename-back, name-swap, duplicate external ids in one chunk, and a deliberately poisoned
item that must not lose the other items' snapshots.

---

## Spec contract deviations

Two fixes change behaviour that §10.5 states explicitly. Both are deliberate and recorded as R-52/R-53.

| Finding | Spec text | Deviation | Rationale | ADR |
| --- | --- | --- | --- | --- |
| H-2 | §10.5: “reusing a used refresh token revokes the whole family” | A 15 s grace returns a typed 401 without revoking; reuse outside the window still revokes | Prevents a routine multi-tab race from destroying a valid session. The grace response carries no token material and only applies to the immediately previous token | 0022 |
| H-3 | §10.5 rate table: `auth` 5 req/min per IP for `/v1/auth/*` | Magic-link/verify/logout keep 5/min; refresh gets 60/min per presented-cookie hash plus a 120/min per-IP guard | Refresh is machine-driven and runs on every load, unlike a human sign-in attempt. The strict bucket stays where it protects email sends and token guessing | 0023 |

H-1 does not deviate: nginx writes the same `CF-Connecting-IP` header the spec names, so the API
still keys on that header when the proxy is trusted.

## Naming additions

`AGENTS.md` freezes `TRENDR_SPEC.md`, so these names will be recorded in a new “Naming additions”
table in [`SPEC_REVIEW.md`](./SPEC_REVIEW.md) as each commit lands, rather than editing Appendix B.
If the owner prefers editing Appendix B directly, that is a one-line process change.

| Name | Kind | Purpose |
| --- | --- | --- |
| `apirl:auth:refresh:{sha256-prefix}` | Redis key | Per-session refresh bucket (H-3) |
| `apirl:auth:refresh:ip:{ip}` | Redis key | Coarse per-IP guard for random-cookie floods (H-3) |
| `admin_audit_log` | table | Durable admin mutation audit (M-6) |
| `trendr_auth_refresh_reuse_total{outcome}` | metric | Grace vs theft-classified reuse (H-2) |
| `trendr_rate_limit_degraded_total` | metric | Limiter fail-open visibility (L-11) |
| `items_display_name_trgm_idx` | GIN index | Functional trigram index on `lower(display_name)` for the search fallback (M-1) |
| `TRIGRAM_WORD_SIMILARITY_THRESHOLD` | constant | 0.15 word-similarity floor, scoped to the fallback transaction (M-1) |
| `scores_run_idx`, `alert_events_score_run_idx` | btree indexes | Retention `NOT EXISTS` scans and FK checks (M-4) |
| `snapshot_partition_lead_days()` | SQL function | Days until the newest monthly partition ends (M-11) |
| `snapshot_partition_window_rows()` | SQL function | Default-partition rows blocking a creation window (M-11) |
| `PartitionWindowBlockedError` | error class | Pre-flight refusal before partition DDL (M-11) |
| `trendr_partition_lead_days` | gauge | Days of monthly partitions provisioned ahead (M-11) |
| `PartitionLeadShort` | alert | Partition lead below 60 days (M-11) |
| `trendr_scoring_runs_total{source,outcome}` | counter | Scored vs lock-held-skip scoring jobs (M-3) |
| `trendr.hasSession` | localStorage key | Non-sensitive web session hint (H-3); never a credential |

## Decisions to record as ADRs

| ADR | Title | Decision | Phase |
| --- | --- | --- | --- |
| 0022 | Refresh reuse grace | 15 s benign 401, no revoke/clear inside the window | 2 |
| 0023 | Refresh rate-limit bucket | Separate session-hash bucket plus IP guard | 2 |
| 0024 | Rename-stub merge and chunk isolation | Merge target stub into the live row; dedupe; per-item retry | 3 |
| 0025 | Trigram search index | Functional GIN index and the indexable `%>` predicate | 4 |
| 0026 | Partition lead time | Twelve months ahead, pre-flight default-partition guard | 4 |
| 0027 | Release supply chain | CI-gated, SHA-pinned, signed, scanned images | 7 |
| 0028 | Scoring cadence | Delay ingest-triggered scoring to the batch window; admin immediate | 5 |
| 0029 | Retention horizons | 400-day `daily_metrics`, bounded failed jobs | 7 |
| 0030 | Render proxy trust | Verify edge behavior; keep `TRUST_PROXY` only when proxy-only | 7 |
| 0031 | API-key lookup cache | Short Redis cache with explicit invalidation | 6 |
| 0032 | Admin audit log | Durable table written with each mutation | 6 |
| 0033 | Production config guardrails | Fail boot on weak/placeholder production settings | 6 |

---

## Remediation phases

Every phase ends with `pnpm lint && pnpm typecheck && pnpm test && pnpm test:int`, plus the
Compose smoke when the phase touches runtime behaviour. Each commit compiles and passes on its
own.

### Phase 1 — Ingress trust boundary (H-1)

1. `fix(api): validate proxied client IPs before rate-limit keys`
2. `fix(infra): restrict origin ingress to Cloudflare`

Key changes: `net.isIP` validation in `clientIp`; nginx header overwrite; UFW Cloudflare allowlist
plus a range-refresh timer; runbook instructions for existing hosts. No spec deviation.

**Status (2026-11-03):** fixed. Local gate green — `pnpm lint`, `pnpm typecheck`, 580 unit tests,
149 integration tests and `infra/scripts/verify-origin-ingress.sh` (Cloudflare-range source served,
non-Cloudflare source closed even with a forged header). Live VPS acceptance is in the deferred
list below.

### Phase 2 — Auth lifecycle (H-2, H-3, L-1)

1. `feat(api): add a bounded refresh-reuse grace window`
2. `fix(api): give refresh its own rate-limit bucket`
3. `fix(api): make auth counters atomic and bound fallback maps`
4. `fix(web): single-flight refresh across tabs`
5. `fix(web): skip anonymous refresh and treat 429 as transient`

Key changes: typed `rotated | grace | invalid` outcome; 15 s grace; typed problem
`refresh-rotated`; Web Locks; session-hash refresh bucket; local session hint; Lua `INCR`+`EXPIRE`;
capped in-memory counters. ADRs 0022 and 0023.

### Phase 3 — Ingestion correctness (H-4, M-10)

1. `fix(db): merge the stub on a rename-back`
2. `fix(worker): dedupe chunk items and isolate per-item failures`

Key changes: target-stub detection and merge; temporary-id staging for swaps; natural-key dedupe;
per-item retry isolation with a failure threshold. ADR 0024. This is the checkpoint after the four
High findings.

**Status (2026-11-03):** fixed. H-4 reproduced locally first: B→A returned `target-exists`, the
following upsert raised `23505` on `items_source_upstream_uq`. M-10 reproduced as a duplicate-key
chunk failure and as a full-chunk rollback from one poison item. Local gate green —
`pnpm lint`, `pnpm typecheck`, 595 unit tests (81 files), 158 integration tests (32 files). The
regression suites are `packages/db/test/int/renames.int.test.ts` (rename-back with engagement and
alias merge, two-item swap, A→B→C chain) and
`apps/worker/test/int/upsert-isolation.int.test.ts` (duplicate natural keys, poison item isolation).
Compose smoke also green: `postgres redis migrate api worker web mcp` came up healthy,
`/healthz` and `/readyz` returned 200, and `scripts/auth-smoke.mjs` passed. The smoke run needed a
host-port override because a native PostgreSQL owns 5432 on this machine; the committed compose file
is unchanged. Live VPS acceptance is still in the deferred list.

### Phase 4 — Database, search and partitions (M-1, M-4, M-11)

1. `perf(db): add functional trigram index for search fallback`
2. `perf(db): index score runs and alert-event run lookups`
3. `fix(worker): widen partition lead time and guard the default partition`

Key changes: `lower(display_name)` GIN index; `scores(run_id)` and `alert_events(score_run_id)`
indexes; 12-month partition lead; default-partition guard; `trendr_partition_lead_days` and alert.
Migrations are forward-only. M-1 is the benchmark-driven revisit of the K-02 deferral recorded in
[`AUDIT.md`](../AUDIT.md).

**Status (2026-11-03):** fixed. The index alone was not enough: `word_similarity(...) > 0` is not
indexable, confirmed with `EXPLAIN` against a functional GIN index (`Seq Scan` even with
`enable_seqscan = off`). The fallback now predicates with `lower(display_name) %> lower(q)` and
lowers `pg_trgm.word_similarity_threshold` to 0.15 inside its own transaction; the §18
`nxt` → `vercel/next.js` pair (≈0.29) still matches and the planner selects
`items_display_name_trgm_idx`. ADRs 0025 and 0026. New integration tests:
`packages/db/test/int/search-index.int.test.ts` (index definition, plan, acceptance pair, GUC
leak), `packages/db/test/int/retention-index.int.test.ts` (both retention indexes planned),
and the extended `partitions.int.test.ts` / `maintenance.int.test.ts` (lead days, blocked
window). `apps/api/test/int/search.int.test.ts` (15 tests) still passes.
For M-4, `EXPLAIN` on the pre-migration database picked a `Seq Scan` for
`alert_events` and a full index-only scan of the `scores` primary key; the new `scores_run_idx` and
`alert_events_score_run_idx` are selected after migration (asserted by
`retention-index.int.test.ts` with `enable_seqscan = off`).

**Local gate (labelled local, not live acceptance):** `pnpm lint`, `pnpm typecheck`, 595 unit
tests (81 files), 167 integration tests (34 files), and Compose smoke — `postgres redis migrate api
worker web mcp` healthy, `/healthz` and `/readyz` 200, `scripts/auth-smoke.mjs` PASS, migrations
0004–0006 applied forward on the existing compose volume, and
`docker compose exec worker node dist/maintenance-cli.js create-partitions` returned
`{defaultRows: 0, leadDays: 393}`.

### Phase 5 — Scoring (M-3, L-5, L-8, L-9)

1. `fix(worker): renew the scoring lock and swap runs monotonically`
2. `fix(worker): preserve bookkeeping errors`
3. `fix(worker): score after the batch window, not after every batch`
4. `perf(worker): load only the all-board candidates`

Key changes: 30 s lock renewal; conditional monotonic swap; explicit `skipped` result; bookkeeping
errors logged with the original; slot-delayed ingest scoring plus immediate admin trigger; top-K
per source load before `buildAllBoard`. ADR 0028.

**Status (2026-11-03):** fixed. M-3 renews the 120 s source lease every 30 s and makes
`swapCurrentRun` advance only on `(computed_at, run_id)`; a lock-held job now returns
`{status: 'skipped'}` and increments `trendr_scoring_runs_total`. L-5 keeps `RunRecorder.finish`
retryable and logs bookkeeping failures next to the original error without masking it. L-8 delays
ingest-triggered scoring to the next ten-minute slot and makes admin item patches invalidate the
item, card and board-metadata keys. L-9 bounds the all-board load to the per-source cap before
`buildAllBoard`. ADR 0028. New tests: `scoring-lock.test.ts`, `run-recorder.test.ts`,
`scoring-schedule.test.ts`, plus the extended `run-scoring`, `scoring-queue`, `ingest-processor`
and `admin` integration suites.
**Local gate (labelled local):** `pnpm lint`, `pnpm typecheck`, 602 unit tests (84 files), 170
integration tests (34 files), and Compose smoke (`postgres redis migrate api worker web mcp`
healthy, `/healthz`/`/readyz` 200).

### Phase 6 — API edge and operations (M-2, M-5, M-6, M-7, L-6, L-7, L-11)

1. `perf(api): cache API-key lookups and add an edge flood guard`
2. `fix(api): lease SSE connection counters`
3. `feat(db): audit admin mutations`
4. `fix(config): reject unsafe production configuration`
5. `fix(api): map 413 and 415 to RFC 7807`
6. `fix(api): observe rate-limiter degradation`

Key changes: Redis key cache with invalidation; nginx `limit_req`/`limit_conn`; 90 s SSE lease;
`admin_audit_log`; production guardrails and bounded TTLs; 413/415 titles; degraded-limiter metric
and alert. ADRs 0031, 0032 and 0033.

### Phase 7 — Deployment and supply chain (M-8, M-9, M-12, L-3, L-4, L-10)

1. `fix(infra): require verified offsite backups`
2. `ci: gate, sign and scan releases`
3. `fix(deploy): require an explicit release tag`
4. `fix(deploy): harden the Render blueprint`
5. `fix(api): make the API-key cap atomic`
6. `fix(worker): bound daily metrics and failed jobs`

Key changes: mandatory offsite + age in production; dump verification; restore-drill script;
stale-backup alert; reusable CI prerequisite; SHA-pinned actions; SBOM/Trivy/cosign; required
`TRENDR_TAG`; Render memory/health/shutdown settings; advisory-lock key cap; 400-day
`daily_metrics` prune and bounded `removeOnFail`. ADRs 0027, 0029 and 0030.

### Phase 8 — Hygiene (L-2)

1. `chore: fix the User-Agent contact URL and email log output`

### Phase 9 — Documentation and final verification

1. `docs: record review outcomes and naming additions`
2. Final gate: full local matrix, Compose smoke, production compose config, `nginx -t`.

---

## Execution rules

- H-2 was reproduced locally with a parallel-refresh integration test before the fix; H-4 was
  reproduced with a rename-back integration test that raised `23505` on
  `items_source_upstream_uq`.
- Author each regression test first, confirm it fails for the documented reason, then implement.
  Tests land with their fix so every commit stays green.
- One concern per commit. If a finding needs a migration and a code change, they land together.
- Do not edit an applied migration; add a new one.
- Record spec deviations and new names in the same commit as the change.
- Checkpoint after Phase 3: run the full local matrix and report before starting Phase 4.
- Live-deployment claims require the VPS; local results are labelled as local.

## Verification matrix

| Gate | Command |
| --- | --- |
| Lint | `pnpm lint` |
| Types | `pnpm typecheck` |
| Unit | `pnpm test` |
| Integration | `pnpm test:int` |
| Compose smoke | `docker compose up -d --build --wait postgres redis migrate api worker web mcp` |
| Compose config | `docker compose -f docker-compose.prod.yml config` |
| Proxy config | `nginx -t` inside the nginx image |
| Auth smoke | `node scripts/auth-smoke.mjs` |
| MCP smoke | `node scripts/mcp-smoke.mjs` |
| Observability | `node scripts/obs-smoke.mjs` |
| Local load | `k6 run infra/k6/trending.js` against Compose |

## Blocked or deferred

These cannot be closed in this environment and remain tracked in
[`REMEDIATION_PLAN.md`](./REMEDIATION_PLAN.md):

- Live VPS acceptance, deployed screenshots and the 200 RPS k6 acceptance run.
- Render Blueprint sync and live proxy verification (M-12).
- Keyless cosign signature verification and GHCR publishing (M-9); the workflow can be implemented
  and dry-run locally, but the real signature only exists after a tagged publish.
- Offsite bucket lifecycle rules and a VPS restore rehearsal (M-8); the drill can run locally.
- Scoring tuning against 2–4 weeks of production data.
- Rotation of the exposed GitHub PAT and Neon password, before either credential is used again.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Grace window weakens theft detection for 15 s | No token material is returned; only the immediately previous token qualifies; only inside the window; metric records every grace hit |
| Random refresh cookies create unbounded Redis keys | Coarse per-IP guard in front of the per-session bucket; short TTLs |
| Stub merge deletes a row referenced by watchlists or aliases | Repoint and dedupe references first; integration tests for watchlist and alias survival |
| Scoring cadence change delays freshness | Delay is bounded to the slot; admin triggers stay immediate; ADR records the trade-off |
| All-board top-K rewrite changes ranks | Equivalence test against the old full-load algorithm on a seeded fixture |
| Release-workflow refactor breaks publishing | Reusable verify job, dry-run build/scan, and a manual tag before enabling the release path |

## Status checklist

- [x] Phase 1 — H-1 fixed and reproduced
- [x] Phase 2 — H-2, H-3, L-1 fixed
- [x] Phase 3 — H-4, M-10 fixed; checkpoint after the Highs
- [x] Phase 4 — M-1, M-4, M-11 fixed
- [x] Phase 5 — M-3, L-5, L-8, L-9 fixed
- [ ] Phase 6 — M-2, M-5, M-6, M-7, L-6, L-7, L-11 fixed
- [ ] Phase 7 — M-8, M-9, M-12, L-3, L-4, L-10 fixed
- [ ] Phase 8 — L-2 fixed
- [ ] Phase 9 — docs, ADRs and final local matrix green
- [ ] Live acceptance — deferred on infrastructure
