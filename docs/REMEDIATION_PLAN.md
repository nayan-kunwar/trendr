# CI remediation and Phase 10 plan

**Date:** 2026-11-02  
**Status:** In progress — Track A complete; Track B partially blocked on live infrastructure;
the production-readiness review remediation is planned in
[`PRODUCTION_READINESS_REVIEW.md`](./PRODUCTION_READINESS_REVIEW.md)  
**Scope:** Restore green CI (dependency audit + integration regression), then finish Phase 10
(deployment and polish).

Related documents: [`AUDIT.md`](../AUDIT.md), [`SPEC_REVIEW.md`](./SPEC_REVIEW.md),
[`PRODUCTION_READINESS_REVIEW.md`](./PRODUCTION_READINESS_REVIEW.md),
[`runbook.md`](./runbook.md), [`TRENDR_SPEC.md`](../TRENDR_SPEC.md).

## Summary

Phases 0–9 are complete and the 2026-10-23 audit is closed. Two issues keep the nightly CI red:

1. **`security` job** — `pnpm audit --prod --audit-level high` fails on `body-parser@2.3.0`
   (`GHSA-27r3-jxmh-p828`, patched in `2.4.0`), reached through
   `@modelcontextprotocol/sdk → express`. The job has failed every night since 2026-10-24.
2. **`integration` job** — on 2026-11-01 the maintenance test expected
   `snapshots_default = 0` but found **3,792** rows. The test seed anchor is fixed at
   `2026-10-18`, so its 60-day series starts on `2026-08-20`. On 2026-11-01 the
   migration-created partition window became September 2026 through February 2027; the
   twelve days from August 20–31 routed to the default partition. The count matches exactly:
   `316 series × 12 days = 3,792`.

A third, non-blocking issue was the 2026-10-29 `compose-smoke` failure: a transient
`corepack install --global pnpm@11.7.0` network error during image build.

The plan below fixes CI first (Track A), then completes Phase 10 (Track B). Track A is
self-contained; Track B needs owner-provided infrastructure and secrets.

## Follow-on workstream — production-readiness review

The 2026-11-02 production-readiness review of `main` at `2ad0396` recorded **27 findings**
(0 Critical, 4 High, 12 Medium, 11 Low) and a “Ready with conditions” verdict. All 27 are
scheduled in [`PRODUCTION_READINESS_REVIEW.md`](./PRODUCTION_READINESS_REVIEW.md), with the four
High findings reproduced first and a checkpoint after they are fixed.

This workstream is local code and operations work; it can proceed while Track B remains blocked on
live infrastructure. It does not replace the Track B acceptance items — deployed screenshots, the
200 RPS k6 run, scoring tuning and the live Render/VPS checks still require the owner-provided
environment.

## Current evidence

| Item | Evidence |
| --- | --- |
| Repo state | `main` synced with `origin/main`; remediation at `a22dcac`, toolchain queue cleared through `d1f5193`, release dry run at `96d933c` |
| Unit suite | 85 files / 612 tests pass locally (2026-11-03) |
| Latest CI | Run `41710700703` for `d1f5193`: security, lint/typecheck/unit, integration and compose-smoke all green |
| Release dry run | `v0.1.0-rc.3` (run `41889652046`) published api, worker, mcp and web to GHCR; Trivy 0 HIGH/CRITICAL; each digest cosign-signed and verified; prerelease tags did not move `latest` or `0.1` |
| Security gate | `pnpm audit --prod --audit-level high` green since `a839fc2`; `deepmerge@4.3.1` remains an accepted low-risk advisory |
| Integration gate | time-dependent partition fixture fixed; `snapshots_default` assertion passes since `3ff3441` |
| Compose flake | corepack retry added in `f2ee1d7`; compose smoke green in `41448937581` |
| Local rehearsal | 2026-11-02: Compose stack, seed/score, auth smoke, MCP smoke, real scoring → SSE snapshot/update, observability smoke, ETag/CORS/security headers/metrics all passed. A 50 RPS local k6 baseline passed at p95 14.0 ms / 0% errors (2,150 requests; not the 200 RPS acceptance run). Eight local screenshots were captured for review; they do not replace the deployed screenshots required by 10.3. Host Postgres was mapped to 5433 because a native server occupies 5432. |
| Track B status | 10.1 deployment artifacts done; 10.2 blueprint and GAP-9 done, live sync pending; 10.3 docs done except screenshots; 10.4 script and result template done, deployed run pending; 10.5 blocked on production data |

## Track B blockers

- **Live VPS acceptance:** owner-supplied domain, VPS/SSH access, Cloudflare origin certificate,
  production secrets, GHCR access and a backup destination.
- **Live Render sync:** a Render account/CLI and at least one published image in GHCR.
- **Screenshots, k6 results and scoring tuning:** require a live deployment and 2–4 weeks of data.

---

## Track A — Restore green CI (≈1–2 days)

### Step 1 — Branch and baseline

```bash
git switch -c fix/ci-red-nightly
pnpm install --frozen-lockfile
pnpm test
pnpm audit --prod --audit-level high
```

Record the current failures as the baseline. Keep the fixes below as separate commits so a
revert is easy.

**Gate:** local unit suite is green (currently 78 files / 573 tests).

---

### Step 2 — Fix the high-severity audit finding

**Cause:** `body-parser@2.3.0` via `@modelcontextprotocol/sdk → express`; patched in `2.4.0`.
Express 5.3.0 declares `body-parser: ^2.3.0`, so `2.4.0` is compatible.

1. Add to `pnpm-workspace.yaml` under `overrides`:

   ```yaml
   overrides:
     postcss: ^8.5.23
     body-parser: ^2.4.0
   ```

2. Run `pnpm install`.
3. Confirm resolution:

   ```bash
   pnpm why body-parser --prod
   pnpm audit --prod --audit-level high
   ```

4. Run the MCP tests. `apps/mcp` uses `node:http` directly, but the SDK still depends on
   Express, so the HTTP transport should be re-verified:

   ```bash
   pnpm --filter @trendr/mcp test
   ```

**Expected:** audit exits 0 for high severity; `body-parser@2.4.0` is in the lockfile.

**Commit:** `fix(deps): override body-parser to 2.4.0`

---

### Step 3 — Clear the remaining audit findings where safe

Current remaining production findings:

| Package     | Installed     | Patched      | Path                                                 | Action                              |
| ----------- | ------------- | ------------ | ---------------------------------------------------- | ----------------------------------- |
| `fast-uri`  | 3.1.8 / 4.2.2 | 3.1.9 / 4.2.3 | `@fastify/swagger`, `@fastify/ajv-compiler`          | scoped overrides                    |
| `glob`      | 13.0.6        | 14.0.2+      | `@fastify/static` → `@fastify/swagger-ui`            | try override, test `/docs`          |
| `minimatch` | 10.2.6        | 11.0.1+      | `glob` 13                                            | follows glob 14                     |
| `deepmerge` | 4.3.1         | 4.3.2 (not published) | `@react-email/components`                    | no fix available; document          |

1. Add scoped overrides for `fast-uri`:

   ```yaml
   fast-uri@^3: ^3.1.9
   fast-uri@^4: ^4.2.3
   ```

2. Run `pnpm install`; verify with `pnpm why fast-uri --prod` and `pnpm audit --prod`.
3. For `glob`/`minimatch`, evaluate `glob: ^14.0.3` in a separate commit.
   `@fastify/static@10.1.8` declares `glob: ^13`, so this is a semver override and must be
   tested:
   - `pnpm --filter @trendr/api test`
   - the `/docs` and `/openapi.json` integration coverage in
     `apps/api/test/int/plugins.int.test.ts`
   - `pnpm build`

   If `/docs` or static assets break, revert the override and document the accepted
   moderate risk. The CI gate is high-only, so this does not block green.
4. `deepmerge` has no published fixed version. Record it as accepted low risk in
   `docs/SPEC_REVIEW.md` with the advisory ID and note that it is only reachable through the
   email-rendering dependency.
5. Optional, not required: bump `@modelcontextprotocol/sdk` `1.32.1 → 1.32.2` and
   `@fastify/swagger` `9.9.2 → 9.9.3`. Do this after the audit is green so failures are
   attributable.

**Gate:** `pnpm audit --prod --audit-level high` exits 0; remaining `pnpm audit --prod`
findings are documented.

**Commit:** `fix(deps): patch fast-uri and document accepted advisories`

---

### Step 4 — Fix the time-dependent integration failure

**Cause confirmed:** the test seed anchor is fixed at `2026-10-18`; the 60-day series starts
`2026-08-20`. On 2026-11-01 the migration-created partition window became September 2026
through February 2027, so August 20–31 routed to `snapshots_default`. This is a test-fixture
issue, not a production defect.

**Recommended fix:** make the shared test database create partitions covering the fixed
fixture dates.

1. In `test/global-setup.ts`, after `runMigrations(...)`, open a DB connection, call
   `ensurePartitions` from `@trendr/db` far enough back to cover the earliest fixed test date
   (`2026-08-01`), then close the pool:

   ```ts
   // Fixed fixture anchors start at 2026-08-20. Migration only creates
   // current-2..current+3 months, so create partitions from the fixture floor.
   const now = new Date();
   const fixtureFloor = new Date('2026-08-01T00:00:00Z');
   const monthsBack =
     (now.getUTCFullYear() - fixtureFloor.getUTCFullYear()) * 12 +
     (now.getUTCMonth() - fixtureFloor.getUTCMonth()) +
     1;
   ```

2. Call `ensurePartitions(connection.db, monthsBack, 3)` and close the connection.
3. Add a regression assertion in `packages/db/test/int/seed.int.test.ts` after seeding:

   ```ts
   expect(await countSnapshotsDefault(db)).toBe(0);
   ```

   This catches partition-coverage drift even if the maintenance test runs before the seed
   test.
4. Do **not** loosen `maintenance.int.test.ts` to accept a non-zero count.
   `snapshots_default = 0` is the intended invariant (ISS-7).

**Alternative:** replace the fixed `ANCHOR` in the seed, run-scoring and scoring-queue tests
with a dynamic UTC anchor. That is cleaner long-term but requires updating expected
timestamps and deterministic job IDs such as `score.mcp.2026-10-18T12-00`. The global-setup
fix is smaller and covers all fixed fixture dates at once.

**Verify:**

```bash
pnpm test:int
pnpm test:int   # run twice to check order/date stability
```

**Commit:** `test(int): cover fixed fixture dates with snapshot partitions`

---

### Step 5 — Harden the Compose smoke against the corepack flake

The 2026-10-29 `compose-smoke` failure was a transient `corepack install --global
pnpm@11.7.0` network error during image build, not an application failure.

1. Add a bounded retry around corepack installation in both Dockerfiles:
   - `infra/docker/node.Dockerfile`
   - `infra/docker/web.Dockerfile`
2. Keep the existing IPv4-first settings.
3. Optionally add retries to `pnpm add -g turbo@^2` in the pruner stages.
4. Verify with a clean build:

   ```bash
   docker compose build api worker mcp web
   ```

**Commit:** `ci(docker): retry corepack installation during image builds`

---

### Step 6 — Add dependency-update automation

Add `.github/dependabot.yml` so new transitive advisories arrive as PRs instead of only
failing the nightly:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
    groups:
      production: { dependency-type: production }
      development: { dependency-type: development }
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
```

Optional for green CI, recommended before deployment.

---

### Step 7 — Record the remediation

- `AUDIT.md`: add a “Post-audit CI remediation (2026-11)” section covering:
  - the body-parser override and advisory ID
  - the fast-uri overrides
  - accepted `glob`/`minimatch`/`deepmerge` risks with rationale
  - the integration partition-fixture fix
- `docs/SPEC_REVIEW.md`: add rows after R-45 (or a new “Post-audit maintenance” section) for
  the overrides and the test-fixture fix.
- `pnpm-workspace.yaml`: keep the comment next to each override explaining the advisory.

**Commit:** `docs: record CI remediation and accepted advisories`

---

### Step 8 — Full verification and CI confirmation

Run the same gates CI runs:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:int
pnpm build
pnpm audit --prod --audit-level high
docker compose up -d --build --wait --wait-timeout 300 postgres redis migrate api worker web mcp mailpit
node scripts/auth-smoke.mjs
node scripts/mcp-smoke.mjs
docker compose --profile obs up -d prometheus grafana
node scripts/obs-smoke.mjs
```

Then push the branch and run CI explicitly:

```bash
git push -u origin fix/ci-red-nightly
gh workflow run ci.yml
gh run watch
```

**Definition of done for Track A:**

- [ ] `pnpm audit --prod --audit-level high` exits 0
- [ ] `pnpm test:int` passes on two consecutive runs
- [ ] `compose-smoke` passes
- [ ] latest push CI is fully green
- [ ] next scheduled nightly run is green
- [ ] accepted findings are documented

---

## Track B — Phase 10 deployment and polish

Phase 10 needs owner-provided infrastructure and secrets. The plan below assumes the spec’s
primary path: **VPS behind Cloudflare**, with Render as the alternative in 10.2.

### Prerequisites

- [ ] Domain + Cloudflare account/zone
- [ ] VPS provider, region, SSH access, firewall rules
- [ ] GHCR access for publishing images
- [ ] Production secrets: `JWT_SECRET`, `API_KEY_PEPPER`, `UNSUBSCRIBE_SECRET`,
      `METRICS_TOKEN`, `GITHUB_TOKENS`, `HF_TOKEN`, SMTP/Resend credentials,
      `MCP_HTTP_AUTH_TOKENS`
- [ ] Backup destination (S3/R2/B2) and credentials
- [ ] Decision: self-hosted Postgres/Redis on the VPS vs managed services

---

### Step 9 — Task 10.1: production deployment

1. **`docker-compose.prod.yml`**
   - image references instead of `build:`
   - no published Postgres/Redis/MCP ports
   - private network only between api/web/mcp/worker/postgres/redis
   - production env file, `restart: unless-stopped`, log rotation, resource limits
   - `migrate` one-shot gated before api/worker
2. **`infra/nginx/trendr.conf`** (or Caddy equivalent)
   - TLS termination / Cloudflare origin certificate
   - proxy `/` → web:3000, `/v1/` → api:4000, `/mcp` → mcp:4100
   - SSE-safe settings: `proxy_buffering off`, long `proxy_read_timeout`, no response
     buffering, HTTP/1.1
   - security headers and request-size limits
3. **`.github/workflows/publish.yml`**
   - build and push four images to GHCR on version tags/main
   - matrix over `api`, `worker`, `mcp` (`node.Dockerfile`, `APP` arg) and `web`
     (`web.Dockerfile`)
   - `permissions: packages: write`, SHA and semver tags, BuildKit cache
4. **`infra/scripts/bootstrap-vps.sh`**
   - idempotent install of Docker + Compose plugin
   - create deploy user/directories, fetch compose/env, `docker login ghcr.io`, pull and start
   - firewall: SSH/80/443 only
5. **`infra/scripts/backup.sh`** + systemd timer/cron
   - `pg_dump -Fc` to encrypted object storage, 30-day retention
   - documented restore drill in `docs/runbook.md`
6. Update `docs/runbook.md` with deploy, rollback, backup/restore, secret rotation and
   incident steps.

**Acceptance:**

- [ ] public URL serves the web app and API behind Cloudflare
- [ ] `curl -fsS https://<host>/readyz` returns 200
- [ ] SSE `curl -N https://<host>/v1/stream/leaderboard?...` streams snapshots/updates
      through Cloudflare
- [ ] MCP `/mcp` requires `Authorization` outside development
- [ ] `pnpm obs:smoke` passes against production-like endpoints
- [ ] a restore from backup succeeds in a scratch database

**Commit:** `feat(deploy): add production Compose, proxy, image publishing and VPS bootstrap`

---

### Step 10 — Task 10.2: Render alternative + GAP-9

1. Add `render.yaml` with:
   - web service, API, worker, MCP
   - Render Postgres and Key Value (Redis-compatible)
   - health checks, env vars, Dockerfile/commands
2. Validate the blueprint in Render (dashboard or CLI).
3. Record free-tier limits and which services cannot run free in `docs/SPEC_REVIEW.md` under
   GAP-9.
4. Document the trade-offs vs the VPS path in an ADR (for example
   `docs/adr/0021-deployment-topology.md`).

**Acceptance:** `render.yaml` validates; GAP-9 is resolved or explicitly accepted.

---

### Step 11 — Task 10.3: README and documentation polish

1. Add a Mermaid architecture diagram to `README.md`.
2. Add screenshots from the deployed app under `docs/screenshots/` and embed them.
3. Add copy-paste API examples (`/v1/trending`, `/v1/items/:id`, `/v1/search`, SSE).
4. Confirm MCP setup instructions match the deployed URL/auth mode.
5. Add a “Design decisions” section linking ADR-0001…0021.
6. Add the §19 interview talking points.
7. Update the status table: Phase 10 ✅ once all tasks are done.

**Acceptance:** README reviewed end-to-end from a fresh-clone perspective.

---

### Step 12 — Task 10.4: k6 load test

1. Add `infra/k6/trending.js`:
   - ramp to 200 RPS against `/v1/trending`
   - thresholds: `http_req_duration{p95}<50`, error rate `<1%`
2. Run against the deployed VPS, not local.
3. Record RPS, p50/p95/p99, error rate, CPU/memory, and any rate-limit responses in
   `README.md`.
4. If p95 fails, profile the SQL/Redis path and document the bottleneck before changing code.

**Acceptance:** p95 < 50 ms at 200 RPS, or a documented, accepted result with a follow-up
plan.

---

### Step 13 — Task 10.5: scoring parameter tuning (after 2–4 weeks of data)

This step depends on production data accumulation, so start collecting immediately after
Step 9.

1. Query 2–4 weeks of `scores`, `score_runs`, `snapshots`, and alert events per source/window.
2. Compute:
   - eligible fraction per `(source, window)`
   - board churn / rank movement
   - false burst flags (items flagged hot that do not sustain growth)
3. Adjust `packages/core/src/scoring/params.ts`.
4. Update the golden scoring fixture and tests.
5. Re-check the §6.5 `scores` table-size estimate against the measured eligible fraction.
6. Write an ADR with the measured data, thresholds and decision.

**Acceptance:** ADR merged; golden test updated; eligible-fraction report recorded.

---

## Deferred items

These are documented and stay deferred unless priorities change:

- `K-02` sequential trigram search fallback — now scheduled as M-1 in
  [`PRODUCTION_READINESS_REVIEW.md`](./PRODUCTION_READINESS_REVIEW.md) with the missing functional
  index and a before/after `EXPLAIN`.
- `R-39` MCP resources and `weekly_briefing` prompt.
- `R-41` OpenTelemetry SDK wiring (Jaeger already provisioned).
- `R-42` Turnstile (magic-link rate limits are the current mitigation).
- Immediate JWT revocation for admin demotion (15-minute TTL accepted).

## Verification matrix

| Gate | Command |
| --- | --- |
| Dependencies | `pnpm install --frozen-lockfile` |
| High-severity audit | `pnpm audit --prod --audit-level high` |
| Lint | `pnpm lint` |
| Types | `pnpm typecheck` |
| Unit tests | `pnpm test` |
| Integration tests | `pnpm test:int` |
| Build | `pnpm build` |
| Compose smoke | `docker compose up -d --build --wait …` |
| Auth smoke | `node scripts/auth-smoke.mjs` |
| MCP smoke | `node scripts/mcp-smoke.mjs` |
| Observability smoke | `node scripts/obs-smoke.mjs` |
| CI | `gh workflow run ci.yml` + `gh run watch` |

## Suggested commit sequence

1. `fix(deps): override body-parser to 2.4.0`
2. `fix(deps): patch fast-uri and document accepted advisories`
3. `test(int): cover fixed fixture dates with snapshot partitions`
4. `ci(docker): retry corepack installation during image builds`
5. `ci: add Dependabot updates`
6. `docs: record CI remediation and accepted advisories`
7. `feat(deploy): add production Compose, proxy, image publishing and VPS bootstrap`
8. `feat(deploy): add Render blueprint`
9. `docs: finish README and deployment guide`
10. `test(load): add k6 trending scenario`
11. `feat(scoring): tune parameters from production data`
