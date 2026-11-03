# Spec review — TRENDR_SPEC.md v1.1

Living document, updated as each phase executes. The spec is **frozen and never edited**; this file
records where the implementation deviates, what was verified against the real world, and what must
be re-checked later. Decisions with alternatives get an ADR in [`docs/adr/`](./adr/).

## Deviations and findings (Phase 0)

| #    | Spec location       | Finding                                                                                                              | Resolution                                                    |
| ---- | ------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| R-1  | §17.2 web.Dockerfile | `COPY … ./apps/web/public   # comment` — Dockerfiles have no inline comments; COPY parsed extra args (`"/#": not found`) | comment moved to its own line                                 |
| R-2  | §17.2 node.Dockerfile | copying `packages/db/dist` loose breaks `pg` resolution under pnpm-deploy's layout (`ERR_MODULE_NOT_FOUND` at runtime) | symlink `packages/db` → deployed `@trendr/db` (ADR-0006)       |
| R-3  | §17.2                | `turbo prune` output omits root `tsconfig.base.json`, which packages `extends` → `TS5083` cascade inside image builds | explicit `COPY --from=pruner` (ADR-0009)                      |
| R-4  | §17.4                | `pnpm turbo run test -- --coverage` is a no-op without per-package test scripts; pnpm 11 forwards the `--` literally | root Vitest workspace + `pnpm test:coverage` (ADR-0008)        |
| R-5  | §2 stack table       | lists Vitest 5.x; implementation is on 3.x (stable line, same `projects` API)                                        | ADR-0008 — revisit at Phase 2                                 |
| R-6  | §17.4 security job   | `pnpm audit --prod --audit-level high` fails out of the box: `next@15.5.28` pins `postcss 8.4.31` (two high advisories) | pnpm override `postcss ^8.5.23` in `pnpm-workspace.yaml`      |
| R-7  | §17.4 compose-smoke  | seed step needs `packages/db/dist/seed.js` (Phase 1); task 0.8 says "without the seed step yet"                      | deferred with comment in `ci.yml`; enabled at Phase 3.7        |
| R-8  | §17.4                | OpenAPI-export step needs Phase 3.1; nightly contract job needs Phase 5.6 (`test:contract` script)                   | resolved: OpenAPI step active at 3.1; nightly contract job added at 5.6 |
| R-9  | §17.2                | `next build` warns "The Next.js plugin was not detected in your ESLint configuration" (repo lints with its own flat config) | `eslint.ignoreDuringBuilds` (web ESLint remains a separate gate) |
| R-10 | §18 task 0.9         | no `docs/SPEC_REVIEW.md` existed despite the baseline commit message (this file)                                      | created with task 0.9                                         |
| R-11 | §17.4 security job   | `gitleaks-action@v2` fails on a repo whose first commit is a root commit (it scans `<first>^..HEAD`); its redacted SARIF also showed a `generic-api-key` false positive: an empty `HF_TOKEN=` followed by `HF_RATE_PER_5MIN=1000` captures the next line as the secret | pinned `ghcr.io/gitleaks/gitleaks:v8.30.1` over full history + `.gitleaks.toml` allowlist for that exact placeholder pattern |
| R-12 | §6.4 / task 1.1      | `tablesFilter: ['!snapshots*']` does **not** keep drizzle-kit `generate` away from `snapshots` (it filters DB-side diffs only — kit created the table in `0000_init.sql`) | typing-only declaration lives in `src/schema/snapshots.ts` and is omitted from the kit schema entry (`src/schema/index.ts`); the filter stays for DB-side operations |

## Verified "open decision" gaps resolved so far

- **GAP-10** — `docker compose up --wait` with the one-shot `migrate` container: verified OK on
  Compose v5.4.0 / Docker Desktop 29.7.2 (`migrate` `Exited (0)` is accepted; see ADR-0005).
- **GAP-11** — `pnpm deploy` flags on the pinned major: `--prod --legacy` works on pnpm 11.7.0; the
  deployed-layout caveat is handled in the image (ADR-0006).
- **GAP-1** — GraphQL batch cost measured live (2026-10-19): 1 point for 3 aliases, 1 point for 50
  aliases, and 1 point for the production snapshot batch (ADR-0011).
- **GAP-7** — the stargazers listing is retired for non-collaborators (live 403), so the backfill
  reads `stargazers/history` weekly buckets + `stargazers/count` instead; reachable depth
  ≈ 100 × 30 weeks (ADR-0012, deviation note under task 4.3).
- **GAP-8** — fine-grained PAT expiry header captured live (`2027-01-17 16:40:21 UTC`, ADR-0013).
- **GAP-3** — pypistats publishes a numeric per-minute budget after all: `X-RateLimit-Limit: 60`,
  `X-RateLimit-Remaining` and `X-RateLimit-Reset` on a live `recent` response (2026-10-20), plus
  `Retry-After: 1` even on a 200. The adapter's `pypi:stats` bucket (capacity 1, 0.5 req/s =
  30/min) therefore stays at half the observed ceiling. The live `mcp` `overall` series already
  ended at **2026-10-19** when captured at **04:41Z** on 2026-10-20, so the 05:00 UTC daily has the
  previous day; the 11:00 retry remains for a late publication.
- **GAP-9** — free-tier limits verified 2026-11-02. Render's free web/Postgres/Key Value cannot
  host a durable always-on demo (15-minute spin-down, 30-day Postgres expiry, in-memory 25 MB Key
  Value), and there is no free worker. The Blueprint therefore pays for API/worker/Postgres/Key
  Value and leaves web/MCP free. Neon free is now **1 GB/project** (not the spec's ≈ 0.5 GB), but
  the §6.5 90-day `daily_metrics` assumption is not implemented, so the 0.5 GB budget does not hold
  as written. Upstash free remains unsuitable for BullMQ. See ADR-0021 and Phase 10 notes.

## Phase 1 notes

- `packages/db/migrations/0000_init.sql` is generated by drizzle-kit and then hand-checked against
  §6.2 (task 1.1). Two statements are hand-added and marked in the file: the `CREATE EXTENSION`
  block (kit emits none) and `ALTER TABLE scores SET (autovacuum_vacuum_scale_factor = 0.02)`
  (spec §6.5). Inline unnamed CHECKs from §6.2 got stable `…_ck` names; semantics unchanged.
- Re-running `pnpm db:generate` right after `0000` reports "No schema changes" — the schema diff is
  empty (task 1.1 acceptance).
- The integration harness follows §16: a shared Vitest `globalSetup` (`test/global-setup.ts`)
  starts `postgres:16-alpine` + `redis:7-alpine` via Testcontainers, exports `DATABASE_URL` /
  `REDIS_URL` (inherited by the workers) and applies migrations with the real migrator before any
  test runs. Verified on Docker Desktop (Windows) and on the GitHub runner.
- Test files run **sequentially** (`fileParallelism: false` at the root of `vitest.config.ts` —
  vitest lists it as a non-project option, so setting it inside a project is silently ignored):
  all int files share one Testcontainers database, and partition DDL
  (`CREATE/DROP ... PARTITION OF` locks the parent) deadlocked against the seed's multi-second
  insert transaction when files ran in parallel (observed `40P01` in `partitions.int.test.ts`).
  The unit suite is small enough that serializing it costs ~1s.
- Task 1.3 verified against the compose stack: the rebuilt `migrate` one-shot applied `0000` +
  `0001` on the dev database (journal = 2 rows, 26 relations, 6 monthly partitions + default,
  database TimeZone = UTC). A second run — through both `docker compose run --rm migrate` and
  `docker compose up` — exits 0 and leaves the journal rows identical: re-run is a no-op.
  Nuance: `docker compose up --wait` can return while a (re)created one-shot `migrate` container
  is still running; dependents remain correctly gated by `service_completed_successfully`
  (ADR-0005). Scripts that need completion should use `docker compose run --rm migrate`.
- `@types/node` (^22) is a **root** devDependency. Plain `tsc` resolved `node:*` types only
  through the vitest test files (which `@trendr/core`'s tsconfig includes); tsup's dts build of
  the production graph (zod only) failed with `TS2307: Cannot find module 'node:crypto'` until the
  types were declared at the workspace root, where every package's resolution walk finds them.
- Drizzle's `sql` template **expands JS arrays** into comma-separated parameters (it does not pass
  them as one array parameter), so the spec §6.3 `unnest($1::bigint[], …)` formulations cannot be
  transcribed literally. The repositories instead use the typed insert builder (multi-row
  `INSERT … ON CONFLICT`, with `setWhere` for the `observed_at` last-writer-wins clause) and a
  `VALUES` list built with `sql.join` for the touched-pairs CTE — behaviour identical, parameters
  chunked at 500 rows/statement. Likewise, raw `sql` selects **bypass Drizzle's column mappers**:
  `min(captured_at)` / `max(captured_at)` come back as pg text, not `Date`. Use the typed
  `min()` / `max()` helpers (or cast in SQL) when the JS value matters.
- Seed (task 1.6): 200 fixtures across the six sources, 60 days of series from a fixed-seed
  PRNG, anchored to the run's UTC day (so scoring staleness stays satisfied and re-runs inside a
  day are byte-identical). The dev API key is deterministic (`dt_live_seedkey1_…`, printed every
  run; only `HMAC-SHA256(API_KEY_PEPPER, raw)` is stored) so re-seeding can never invalidate a
  key a developer already saved. Items are marked `metadata.seed = true`; integration tests scope
  their assertions to that marker. CLI loading of `.env` uses `process.loadEnvFile` (existing
  env vars win — compose supplies them), same symlink-safe direct-run detection as the migrator.
- Seed HF fixtures follow §7.3.4/§8.3 exactly: `primary_metric = likes` for **all** HF kinds (the
  params table has no `huggingface:downloads`, so a dataset scored on `downloads` would throw in
  `paramsFor`), and the generated `downloads` values feed `latest_metrics` only — never persisted
  as a snapshot/daily series. Row counts after the change: 18,960 snapshots, 4,440 daily rows
  (npm 2,400 + PyPI 2,040).

## Phase 2 notes

- `toVelocityInput` placement: spec §8.6 sketches it in `apps/worker/src/scoring/run-scoring.ts`,
  but §16 requires unit tests for it ("tier staleness 3 h/12 h/36 h"). The pure conversion lives in
  `packages/core/src/scoring/series.ts` (plus `toDailyVelocityInput` for the daily-count path) and
  the worker only wires it to `loadSeries` rows.
- The combined-"All" ranking of §8.2 step 9 (`ALL_BOARD_MAX_SHARE` greedy fill) is the pure helper
  `buildAllBoard` in `packages/core/src/scoring/board.ts`; the worker's `rebuildAllBoard` (task 2.4)
  feeds it candidates from `score_runs_current` and persists the ranks as `scores.rank_all`. Items
  skipped by the share cap keep `rank_all = NULL`.
- Spec §8.7 contains one arithmetic slip: row C's final is printed as **7.491**, but the table's
  own intermediates give raw 6.3753 × ageFactor 1.1749 = 7.4903, and exact math gives 7.49048. The
  worked-example test asserts C to two decimals and every other row to three.
- Daily-count coverage interpretation: `c = curDaysPresent / WINDOW_DAYS[w]` ("days present / days
  required", §8.1). For `24h` the required days are the single current day; gaps inside the seven
  prior days shrink `S_prev` naturally through SQL `AVG` but do not lower `c`.
- Scoring coverage gate (`vitest.config.ts`): `packages/core/src/scoring/**` at 95% statements /
  lines / functions and 90% branches — the `packages/core` branch target of the §16 table. The
  remaining branch gap is defensive `?? fallback` code that `noUncheckedIndexedAccess` forces and
  that cannot execute (e.g. `s[mid] ?? 0`).
- `fast-check` property tests (16 properties, fixed seeds for reproducibility) and the golden
  fixture (`packages/core/test/scoring.golden.test.ts` with its committed snapshot) both guard the
  §8.3 parameter table; per spec, any constant change requires an explicit golden update in review.

### Task 2.3 notes

- `loadSeries` (§8.6) lives in `packages/db/src/repositories/series.repo.ts`, split by metric kind
  (`loadCumulativeSeries`, `loadDailySeries`, `loadDailyFallback`, `loadHourlySeries`) because MCP
  carries mixed primary metrics (registry servers score `stars`, npm-alias fallbacks score
  `downloads`); the worker runs both paths per (source, window). Bounds are passed as computed
  timestamps instead of SQL interval arithmetic, except the window-length offsets, which cast
  their bound integers explicitly — Postgres resolves an untyped `date − $n` as `date − date`.
- Daily `D` selection: `max(day) < (t AT TIME ZONE 'UTC')::date`, i.e. strictly complete UTC days,
  so a partially written current-day row can never become `D`. The §8.1 `D ≥ today − 3` freshness
  check still runs in TS and yields `insufficient_data` for older data.
- The §8.6 fallback pass reads the item's *primary* metric from `daily_metrics` for the UTC day
  before `t−W`. For cumulative metrics that works because `rollupDailyMetrics` stores the
  end-of-day counter under the same metric name; the seed writes no cumulative daily rows, so the
  integration test covers the pass with explicit fixtures.
- Raw `db.execute` results bypass drizzle's column mappers: `timestamptz` columns arrive as text.
  `series.repo.ts` normalizes every date and bigint column before mapping into the core row shapes.

### Seed fixture notes (task 2.4 driver)

- The seed now writes a trailing 48 h **hourly tail** for cumulative/gauge series (points on the
  hour grid, linearly interpolated from the daily buckets, exact daily buckets skipped). Without
  it a 24 h window had nothing to measure: its only snapshots were 24 h apart, so
  `toVelocityInput` could never interpolate around `t − W` and `V_first` always equalled `V_now`.
  Hours after the last daily bucket continue the last day's increment (a projected partial current
  day) so a run at any hour of the anchor day sees ~one full day of growth. Snapshot counts:
  316 series × (60 daily + 46 hourly) = 33,496; daily_metrics unchanged (4,440).
- Arxiv upvote bases were raised to `10 + 2500·rand³` (was `5 + 600·rand³`): growth is a fraction
  of the base, so the old range could never clear `minDelta(arxiv:upvotes, 24h) = 3` and the
  arxiv 24 h board would stay empty in every environment.

### Task 2.4 notes

- `runScoring` (spec §8.4) lives in `apps/worker/src/scoring/run-scoring.ts`; the `scoring` queue
  processor (task 2.6) is its only caller. It holds `lock:score:{source}` (120 s, skip when held,
  compare-and-del release), runs both series paths per window, normalizes within (source, window),
  inserts eligible rows + `swapCurrentRun` in one transaction, rebuilds the combined board and
  fans out `evaluate-alerts`.
- `rank_source` is assigned at insert time: eligible rows sorted by final desc, tie-broken by z
  desc then itemId asc. The spec fixes only that it is 1-based and read by §7.8 tiering ("rank_source
  ≤ 200/2000 in any window of the current run"), so the tie-break is ours; it is dense (1..n).
- The combined board is the exported `rebuildAllBoard(db, window)`: it re-reads every source's
  *current* run for that window (so it converges regardless of which source scored last), runs
  `buildAllBoard` and persists `rank_all` through a `VALUES (item_id, rank)` join. Unlike the
  spec's single UPDATE it first clears `rank_all` on current-run rows, because the board is rebuilt
  after every source run and a shrinking board must not keep stale ranks.
- The §8.6 burst second pass loads hourly increments for the top 500 candidates by raw score per
  (source, window) and recomputes the score with `anomalyPenalty = 0.5` (which adds the
  `burst_suspected` score flag). Daily spikes come from `detectDailySpike` (0.7) and counter resets
  are logged and counted. All three feed `trendr_scoring_anomalies_total`.
- `evaluate-alerts` is enqueued through a structural `NotifyQueue` slice (`add(name, data, {jobId})`)
  so the scoring module needs no `bullmq` dependency until the queue processor lands (task 2.6);
  the deterministic jobId is `jobId.evaluateAlerts(runId)` from core.
- Metrics (§14.1): `apps/worker/src/metrics.ts` owns the process-wide registry (also served by
  `startMetricsServer`), plus `trendr_scoring_items` (eligible/ineligible per source/window — the
  task 2.4 acceptance compares its eligible label against the `scores` row count),
  `trendr_scoring_duration_seconds` and `trendr_scoring_anomalies_total`.
- Scoring instants are floored to the last complete hour (`floorToHour(now)`, §8.1) so intra-hour
  run jitter cannot change `t`; `computedAt` uses the same instant for every row of a run.

### Task 2.5 notes

- `publishBoard` (spec §9.2) lives in `apps/worker/src/scoring/publish-leaderboards.ts`. The spec
  signature is kept, plus two additions: an options object (`{ cards, computedAt }`) and a return
  value (the diff event) so `publishLeaderboards` can publish every event only after *all* boards of
  the run are swapped, as the §9.2 tail requires. The empty-board branch deletes the live key,
  still writes `lbmeta` (`count = 0`) and bumps `version` (readers see the empty board, not a
  stale one).
- `publishLeaderboards(deps, source, windows, runId)` publishes, per window, the run's source board
  (rows from the run's own `scores`, `final_score` desc) and the combined board (every source's
  *current* run, `rank_all` order, score = `z_score`), then PUBLISHes one diff per board on
  `events:leaderboard`. §8.4's pseudocode ties the `lb:all` publish to the `rebuildAllBoard` step;
  doing it here instead keeps every ZSET swap in one module — `rank_all` is already persisted when
  the publisher runs.
- **Language boards are deferred.** Only the `_all` board of each scope is written in Phase 2
  (`lb:{scope}:{window}:_all`); the per-language boards (`lb:*:*:{lang}` for the top-30 GitHub
  languages) land with the Phase 6 UI, which is where the language list becomes user-visible.
- **Cards are minted for the top 100 rows** of the source board and of the combined board (union,
  deduped) and are written by the source-board swap only. `card:{itemId}:{window}` is a single key,
  so it cannot carry two scope-specific scores: it holds the source `final_score` (§5's "score =
  zScore for all" applies at the API response boundary), and a deep page or a miss hydrates from
  Postgres per §9.3. An item that sits in the combined top 100 but beyond its own source's top 100
  gets its card from its own source's run.
- Card `current`/`sparkline`: last value per UTC day of the primary metric, up to 30 daily points,
  oldest first. Cumulative metrics read `snapshots` (the newest day may be partial via the hourly
  tail, so `current` == the last sparkline point); daily-count metrics (`downloads`) read
  `daily_metrics` and stop at the last complete day, matching the §8.4 scoring population. An item
  with no metric rows yet is skipped (no card).
- Diff semantics: `entered`/`exited` are top-100 membership changes in board order; `movers` are up
  to 20 members of *both* top-100 sets, sorted by |rank change| desc (tie: new rank asc),
  `prevRank` from `ZREVRANK` on the old board. The payload's `delta` is the window growth
  (`scores.delta`) — the §9.2 example's 412 cannot be a rank change.
- Contracts live in `packages/core/src/leaderboard.ts`: `LB_MAX_SIZE` (1000), the
  `LeaderboardEntry` / `LeaderboardCard` schemas (§5, card = entry minus rank) and
  `LeaderboardUpdatedEventSchema`. The worker parses every event with the schema before PUBLISH
  (task 2.5 acceptance) and the int test re-validates what subscribers receive.
- Task 2.5 integration test (`apps/worker/test/int/publish-leaderboards.int.test.ts`): fixture
  boards assert ZSET members/scores, `lbmeta` (`runId`/`computedAt`/`count`/`version`), card JSON
  (sparkline shapes, `current`, downloads path) and exact diff payloads across two runs; a reader
  loop hammers the live key during a 1,200-row swap and only ever observes the complete old board
  or the complete new one.

### Task 2.6 notes

- `apps/worker/src/queues.ts` owns the BullMQ plumbing (spec §7.5/§5.2): the producer connection
  (`maxRetriesPerRequest: null`), `defaultJobOpts` (5 attempts, `custom` backoff through
  `backoffDelay(5 s … 30 min)`, `removeOnComplete` 24 h/2000, `removeOnFail` 7 days), the queue
  registry (`scoring`, `notify`, `dead-letter`) and `enqueueScoringRun`, which adds
  `compute-scores` with the deterministic slot jobId `score.{source}.YYYY-MM-DDTHH-mm` (UTC,
  floored to ten minutes); a second add inside the same slot returns the existing job.
- The `scoring` processor (`apps/worker/src/scoring/processor.ts`) validates every payload with
  `ScoringJobSchema` first — invalid data throws `UnrecoverableError` (no retries) — then runs
  `runScoring` (the per-source Redis lock lives there, §8.4) and returns `{ source, windows }` as
  the job result. Concurrency is 1: a run is CPU-bound and the Redis lock serializes sources
  anyway. `Queues.scoring`/`Worker` are typed `Queue<ScoringJob, ScoringResult>` so the result
  type survives to `waitUntilFinished`.
- `attachDeadLetter` (`apps/worker/src/dlq.ts`) copies §7.7's payload into the `dead-letter`
  queue once the last attempt failed (or immediately on `UnrecoverableError`).
- **`score-safety` is per source.** §7.2 lists one row (`scoring` `compute-scores` per source,
  `40 * * * *`), but a BullMQ scheduler template carries one fixed payload and scheduler ids are
  unique per queue, so the row is read per source: six schedulers `score-safety-{source}` (hyphen,
  not colon — scheduler ids become Redis key segments), pattern `40 * * * *`, tz UTC, job data
  `{ source, windows: all three, trigger: 'schedule' }` and the default job options. Registration
  is idempotent (`upsertJobScheduler`); `main.ts` only registers when `WORKER_ROLES` includes
  `scheduler` *and* `SCHEDULER_ENABLED` is true.
- `main.ts` starts processors by role: `scheduler` registers the schedulers, `scoring` starts the
  worker wired to `queues.notify` (the `evaluate-alerts` fan-out target) and
  `queues.deadLetter`; `/healthz` is liveness and reports a real `schedulerRegistered` flag and
  `lastJobByQueue` (updated on completed scoring jobs); `/readyz` is dependency readiness and
  returns 503 when Redis is disconnected (Compose uses it). Shutdown closes the worker, queues,
  the db pool and Redis in that order.
- `worker:score` (`apps/worker/src/score-cli.ts`) is a thin producer: parse `--source` (required,
  one of §2's sources) and optional `--windows 24h,7d` (defaults to all), enqueue with trigger
  `admin`, exit. Its package script is `node dist/score-cli.js` — the `db:migrate`/`db:seed`
  convention, and the only form that works in the compose image, which deploys production
  dependencies (no tsx) and no pnpm. The direct-run guard and `.env` pickup are copied from the
  seed CLI; real environment variables always win over `.env` values.
- Tests: unit coverage of the argv parser and slot flooring
  (`apps/worker/test/unit/score-args.test.ts`); the int test
  (`apps/worker/test/int/scoring-queue.int.test.ts`) runs a real worker over the containerized
  Redis/Postgres — end-to-end `compute-scores` (run row `succeeded`, current-run scores, board
  key, `evaluate-alerts` jobId), slot dedupe, unrecoverable invalid payload → dead-letter entry,
  idempotent scheduler registration (pattern, tz, template data), and a spawned `worker:score`
  CLI whose job the worker then processes.
- Dependency note: BullMQ pulls `msgpackr`; its optional native accelerator `msgpackr-extract`
  is set to `false` in `pnpm-workspace.yaml` `allowBuilds` (pnpm 11 otherwise blocks on the
  undecided build script) — the pure-JS fallback is used.

### Phase 2 exit notes

- CI run `39152880300` is green at `936a6a9`; the `phase-2` tag was force-moved twice from the
  original push (`29af3f7` → `5d6e514` → `936a6a9`): first for a missing `@trendr/db/seed`
  tsconfig path that only failed on a clean checkout (CI lints/builds without `dist`), then for a
  gitleaks false positive (the fabricated `int-test-*` CLI env values in the scoring int test are
  now allowlisted by value prefix, not by file). The tag message records both moves.

## Phase 3 notes

### Task 3.1 notes

- **`buildApp` is async now.** Fastify captures a route's hook chain when the route is
  registered, so hook-adding plugins (`@fastify/rate-limit`, `@fastify/swagger`, helmet/CORS)
  only cover routes registered *after* them. A synchronous `register(rateLimit)` followed by a
  route silently served unlimited traffic (verified with a scratch test); `buildApp` therefore
  awaits those registrations and returns `Promise<FastifyInstance>` — tests and `main.ts` await
  it.
- **Plugins decorate caller-owned clients** (spec §4): `plugins/db.ts` decorates
  `app.db`/`app.pool` from a `@trendr/db` `Connection`; `plugins/redis.ts` decorates
  `app.redis`/`app.redisSub` and only duplicates the subscriber when none is passed (with
  subscriber-friendly ioredis options — `enableOfflineQueue: true`,
  `maxRetriesPerRequest: null`, error events logged — and teardown on `onClose`). `main.ts`
  builds the pool/Redis with §9.3 fail-fast options (`enableOfflineQueue: false`,
  `maxRetriesPerRequest: 1`) so a down Redis degrades instead of hanging, logs redis errors, and
  closes both after `app.close()`. `/metrics` is registered after the OpenAPI plugin so it is
  collected into the document (§10.1).
- `plugins/cache.ts` keeps the read-through/breaker logic in a pure `createCache({ store, now })`
  factory (unit-tested with a stub store and injected clock). Semantics: `readThrough(key, ttlSec,
  load)` returns cached JSON or the loader result (best-effort `SET … EX ttl`); every Redis error
  counts, five consecutive open the breaker for 30 s (§9.3), any successful command resets it,
  and `invalidate(...keys)` is best-effort/silent while open. `breakerState()` is exposed for
  tests and a future `/readyz` `degraded` report.
- `plugins/etag.ts`: weak body-hash ETags `W/"{sha1(body)}"` + 304 on `If-None-Match` (weak
  comparison, `*` supported) for GET/HEAD 200 responses; a route-set ETag (the trending board's
  `lb-…` tag) wins. The §9.4 `Cache-Control` values are declarative — routes pass
  `config: { cacheControl: CACHE_CONTROL.publicLong }` — and are applied to the 304 too.
- `plugins/rate-limit.ts`: `@fastify/rate-limit` with the Redis store when a client is passed
  (in-memory otherwise), `enableDraftSpec: true` (`RateLimit-*` + `Retry-After`), `skipOnError:
  true` (fail-open, matching §9.3), namespace `apirl:` (§9.1's inbound-limiter prefix, imported
  from `@trendr/core`). Anonymous tier: 60/min; the key is `CF-Connecting-IP` (only behind
  `TRUST_PROXY=true`, else the socket peer) until task 3.5 adds the API-key/JWT tiers of §10.5.
  `rateLimit: false` disables the plugin for tooling.
- `plugins/openapi.ts`: the Zod type provider (`fastify-type-provider-zod` ^7 + zod 4.6) serves
  as validator compiler, serializer compiler and swagger transform; `@fastify/swagger` 9 + UI 6
  at `/docs`; the document is served at `/openapi.json` (hidden from itself, `/docs*` skipped)
  and exported to `apps/api/openapi.json` by `pnpm --filter @trendr/api openapi:export` (tsx,
  no env needed, no `servers` entry — `main.ts` passes `API_PUBLIC_URL` at runtime). CI re-runs
  the export and fails on a dirty file (§17.4). `X-API-Key`/bearer schemes are declared up front.
- `apps/api/tsconfig.json` now includes `test` so int tests are type-checked (matches the
  worker). New `@trendr/api` dependencies: `fastify-plugin`, `@fastify/swagger`,
  `@fastify/swagger-ui`, `fastify-type-provider-zod`, `@fastify/rate-limit`, `ioredis`, `zod`.
- Tests: unit `cache.test.ts` (10), `etag.test.ts` (9), `rate-limit.test.ts` (5),
  `openapi.test.ts` (4); int `plugins.int.test.ts` (5) over Testcontainers Postgres + Redis —
  decorators, read-through/invalidate against real Redis, breaker opening on repeated failures,
  the 429 counted through the shared Redis store, `/docs` render and `/openapi.json` (3.1
  acceptance).

### Task 3.2 notes

- **Card loaders moved to `@trendr/db`** (`repositories/cards.repo.ts`: `loadCardItems`,
  `loadCardSeries`, `SPARKLINE_POINTS`). The worker mint and the API's deep-page hydration now
  share one implementation, so a card and a hydrated entry cannot drift; the worker's local
  copies were deleted (the task 2.5 int test still passes unchanged).
- **Read-path selection (spec §9.3).** The board path is taken only when: `lbmeta:{scope}:{window}`
  exists, no `topic`/`kind`/`minCurrent` filter, `newOnly` is false, `lang` is absent or `_all`,
  and the cache breaker is closed; anything else — and any Redis failure or missing meta — goes
  to SQL (with one `warn` log on degrade). The board read starts with
  `ZREVRANGE key 0 limit WITHSCORES` and continues from the cursor member's
  `ZREVRANK + 1` with `ZREVRANGE ... WITHSCORES`, then pipelines `ZREVRANK` for absolute
  ranks and `MGET card:*`; cards that are missing or fail `LeaderboardCardSchema` hydrate
  from Postgres in one items+series+scores pass, exactly as the worker would have minted
  them. Rank-based continuation is tie-safe: equal scores are ordered by member and all tied
  entries remain reachable. A cursor member that is no longer on the board returns 410
  `cursor-expired` instead of skipping entries. The first Redis implementation used ascending
  `ZRANGEBYSCORE` (the int test caught the reversed board).
- **ETag before any board read (spec §9.3, §9.4):** `W/"lb-{scope}-{window}-{version}-{sha1(
  canonicalQuery).slice(0,8)}"` from `lbmeta` (`canonicalQuery` = the §10.3 parameter set
  including the cursor); a matching `If-None-Match` returns 304 *before* the ZSET/cards are
  touched. Without `lbmeta` the route sets no ETag and the §9.4 plugin mints the body hash, so a
  filtered or fallback response still gets conditional-GET support. The 304 keeps the route's
  `Cache-Control`.
- **Run-pinned cursors (§16).** `LeaderboardCursor {r,s,i}`/`KeysetCursor {r?,k,i}` are
  base64url JSON (§10.2). A board cursor whose `r` differs from the current `lbmeta.runId` →
  **410 `https://trendr.dev/problems/cursor-expired`** (new `CursorExpiredError` in core; 410
  `Gone` title in `plugins/errors.ts`) so a rebuilt/thinned board never mixes runs into one
  page list; undecodable or malformed cursors are 400 `validation-error`. Filtered SQL cursors
  also carry `r`: the source run id for a scoped query, or a fingerprint of the per-source
  current-run set for `scope=all`; the SQL read is pinned to those captured run ids and a
  missing or changed `r` returns 410. The int tests cover both the §16 npm-rescore stability
  promise (github pages stay readable) and same-board/combined-run swaps (stale cursors are
  rejected).
- **`entry.score`.** Source-scope entries use the card's `final_score`; the combined board uses the ZSET/`z_score` on every path. The Redis path overrides source-shared card scores with the board score and hydrates missing combined entries with `z_score`, so Redis, SQL, and SSE agree. `minCurrent` filters on the same hydrated `current` the response serves (up to 30 daily points; rows without a series are skipped).
- **SQL path.** `scores` ⋈ `score_runs_current` ⋈ `items`, ordered `(score DESC, item_id DESC)`
  with the §10.3 keyset cursor (`k` = board score) and run-pinned `r`, `topic` via
  `items.id IN (SELECT item_id FROM item_topics JOIN topics …)`, `lang` via
  `lower(language) = $1`, `newOnly` via `upstream_created_at >= now() - 30 d`, and a
  limit+1 top-up loop so `minCurrent` never returns a short page while deeper rows exist. The
  loop is bounded at `MAX_SQL_SCAN_ROWS = 2_000` score rows; if the budget is exhausted before
  the page fills, the route returns **422 `https://trendr.dev/problems/query-too-broad`** rather
  than scanning the whole board, and the caller must narrow the filter or lower `minCurrent`.
  Pages are cached under `q:{sha1(canonicalQuery)}` for 60 s via `app.cache` (§9.1). `newOnly` parses
  the `'true'|'false'|'1'|'0'` enum explicitly (ISS-2: `Boolean('false')` is `true`; `'yes'` →
  400, absent → false). A missing current run yields an empty page with `runId "0"` and the
  epoch `computedAt`.
- `@trendr/api` gained a direct `drizzle-orm` dependency (the route builds its own queries).
- Tests: unit 16 new — the `newOnly` matrix, defaults/coercions, cursor round-trip/garbage,
  `canonicalQuery`/`trendingEtag`/`hasSqlFilters`; int `trending.int.test.ts` (14) over
  Testcontainers: board read with cards + hydrated entries, ETag/304, absolute-rank pagination,
  equal-score tie pagination, malformed-cursor 400, no-`lbmeta` npm fallback, topic/kind/lang
  filters + `q:` cache key, `minCurrent` top-up across pages, `newOnly` matrix, combined board
  (z_score Redis/SQL consistency), stability across an npm rescore, same-source and combined-board 410 paths, 410
  after a rebuild and fresh restart, 422 when `minCurrent` exhausts the scan budget. `apps/api/openapi.json` re-exported (4 paths).

### Task 3.3 notes

- **Routes.** `apps/api/src/routes/items.ts` + `apps/api/src/schemas/items.ts` implement §10.1's
  six item endpoints: detail, lookup (302), history, scores, score-explain, aliases. All item
  routes carry `Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=600`
  (§9.4) and get the plugin-minted `W/"{sha1(body)}"` ETag with 304 handling; 404s are
  problem+json (`not-found`) via the typed `NotFoundError`. `:id` is validated by `IdParam`
  (`^\d{1,19}$`); values beyond bigint range 404 instead of erroring in Postgres. Lookup is a
  static route (find-my-way priority over `/v1/items/:id`) and soft-deleted items 404
  everywhere.
- **Detail (GET /v1/items/:id).** Read-through cached under `item:{id}` for 300 s (§9.1); a
  missing item throws before anything is cached. The loader joins `items`, topic slugs, the
  current-run score row per window (`scores ⋈ score_runs_current`), and outgoing alias rows.
  The `scores` map always carries all three §5 windows (`null` when unscored) — Zod v4's
  exhaustive `z.record(enum, …)` is satisfied by construction. `latestMetrics` is a *partial*
  record in the v3 spec; translated to `z.partialRecord(MetricSchema, …)` for v4 semantics,
  and the loader filters to the known §5 metrics so a stray key can never fail serialization.
- **History (GET /v1/items/:id/history).** `HistoryQuery` is exactly §10.4 (day default; the
  hour ≤ 14 d refine uses `Date.now()` from the explicit `from` only — the spec's own quirk:
  `granularity=hour` without `from` passes and then defaults to a 30 d range). Cumulative/gauge
  metrics read `snapshots` — hour = raw buckets oldest-first, day = the last capture per UTC
  day (`DISTINCT ON` over `(captured_at AT TIME ZONE 'UTC')::date`, explicit UTC bounds).
  `daily_count` metrics read `daily_metrics` and have **no hourly resolution**: hour granularity
  serves an empty `points` list for them (documented divergence, §10.1 "from
  `snapshots`/`daily_metrics`"). Point shape: day points carry `t: 'YYYY-MM-DD'`, hour points
  an ISO bucket start. Read-through cached under `hist:{id}:{metric}:{granularity}:{rangeKey}`
  for 900 s; both the query range and the key are floored to the granularity grid
  (`fromT/toT`) and `rangeKey` is that span (`720h`, `30d`), so equal spans share one cached
  series without dropping bucket points.
- **Scores (GET /v1/items/:id/scores).** `ScoresQuery` is exactly §10.4 (window `7d`, day
  default, `days` 1..365, hour ⇒ `days ≤ 2`). The route clamps the horizon to the env bounds
  passed through `BuildAppDeps.scoresRetention` (from `SCORES_HOURLY_RETENTION_HOURS` /
  `SCORES_DAILY_RETENTION_DAYS`, main.ts): hour = `min(days*24, hourlyHours)` h, day =
  `min(days, dailyDays)` d. One query over `scores ⋈ ingestion_runs` ordered by
  `started_at, run_id`; day granularity then keeps the last run per UTC day in TypeScript —
  the exact rows §6.5 retention preserves beyond the hourly horizon. Ineligible runs have no
  row, so they are gaps by construction. No Redis cache (§9.1 lists none); ETag/304 via plugin.
- **score-explain.** §10.1's response shape is not pinned, so: `window` query (default `24h`,
  matching the trending default), returning `components` (the eight §5 `ScoreComponents`),
  `params` (`paramsFor(source, primaryMetric, window)`, `null` if the combo has no §8.3 entry)
  and `inputs` = the persisted inputs the run row holds (`delta`, `base`, `anomalyPenalty`,
  `zScore`, `percentile`, `rankSource`, `rankAll`, `flags`). When the item has no row in the
  current run the response is `components: null`, `inputs: null`, `reason: 'not_eligible'` with
  the current run id still reported (and `runId: null` when no run exists at all).
  `coverage`/`stale`/`ageDays`/`isPaper` are not persisted, so they cannot be echoed; the
  stored factors explain the formula (`final = raw × ageFactor × confidence × anomalyPenalty`).
- **Aliases.** The item detail embeds the item's **outgoing** rows only (the §10.4 alias shape
  has no direction and the relation reads from `item_id`'s perspective). The aliases endpoint
  returns **both** directions with a `direction: 'outgoing' | 'incoming'` field plus
  `kind`/`externalId`/`url`/`evidence`, so a repo page can surface its paper. Deleted link
  targets are filtered out; ordering is stable (`upstream`/`downstream` by item id).
- **DB layer.** New repository functions: `getItemById`, `findItemByNaturalKey`,
  `loadItemTopics`, `loadItemCurrentScores`, `loadItemAliasLinks` (items.repo.ts);
  `getCurrentScoreRun`, `loadItemScoreForRun`, `loadItemScoreHistory` + pure `lastRunPerUtcDay`
  (scores.repo.ts); `loadSnapshotHourlyHistory`, `loadSnapshotDailyHistory`,
  `loadDailyMetricHistory` (snapshots.repo.ts).
- Tests: unit 20 new — history/scores/lookup/explain query validations, detail + not_eligible
  DTO parses, `truncateToGranularity`/`historyRangeKey`/`parseItemId`, `lastRunPerUtcDay`
  (UTC-day grouping, gaps, tie-break); int `items.int.test.ts` (9) over Testcontainers:
  detail + ETag/304 + `item:` cache key, 404/400 for missing/deleted/malformed ids, lookup 302
  + 404s, hour/day history (14 d hour limit 400), hourly score history and last-run-per-day,
  `days` clamped by an injected `dailyDays: 3`, 48 h hour limit 400, eligible/not_eligible
  explain, aliases in both directions. `apps/api/openapi.json` re-exported (10 paths).
- **OpenAPI export formatting fix.** `openapi-export.ts` now resolves the repo Prettier config
  explicitly (`resolveConfig`) before `format()`. Prettier 3's `format()` does **not** resolve a
  config from `filepath` (verified: it silently formats at the default `printWidth: 80`), while
  lint-staged rewrites `*.json` with `.prettierrc` (`printWidth: 100`) on every commit — so the
  committed file and a fresh export disagreed and CI's `openapi:export && git diff --exit-code`
  staleness check would have failed at the Phase 3 gate. The export is deterministic (stable
  sha1 across runs) and is a lint-staged fixed point.

### Task 3.4 notes

- **Endpoints.** §10.1 names `/v1/search`, `/v1/new`, `/v1/topics`, `/v1/languages`, `/v1/compare`
  and `/v1/stats` but pins no shapes, so:
  - `/v1/search` — `q` 2–100 (trimmed), optional `source`/`kind`, `limit` 1–100 default 50,
    `cursor`. Items use the §11.1 `search_items` shape: `id, source, kind, name, url,
    description, current, score7d, upstreamCreatedAt` (`current` = primary-metric value from
    `latest_metrics`; `score7d` = the item's current 7 d run score; both `null` when absent).
  - `/v1/new` — fixed page size 50 (no `limit` parameter; user-approved), `source`/`kind`
    optional, `days` 1–30 default 7, `cursor` carrying `{createdAt, itemId}`. Items with a NULL
    `upstream_created_at` or soft-deleted rows are excluded. §10.5 `Link: <…>; rel="next"` is
    emitted on search/new and was backfilled into trending (both Redis and SQL paths).
  - `/v1/topics` — `source`, `limit` 1–200 default 100; counts are computed live from
    `item_topics ⋈ items` (the denormalized `topics.item_count` cannot answer the source filter
    and ignores soft deletes); order count desc, name/slug asc; no cursor.
  - `/v1/languages` — no parameters; top 30 by live item count, grouped by the exact
    `language` string (it is free-form upstream data: seed npm rows say `javascript`), slug =
    lowercased. §9.1 language boards stay Phase 6 (see task 2.5 notes).
  - `/v1/compare` — `ids` 2–5 distinct comma-separated (400 on duplicates/malformed), `window`
    default `24h`, `granularity` default `hour` for 24 h/7 d and `day` for 30 d, explicit
    `hour` + 30 d ⇒ 400 (mirrors the history 14 d hour limit); `metric` defaults to **each
    item's primary metric** (one query param can't express per-item overrides; response echoes
    `metric: null`), unknown/deleted ids ⇒ 404, unscored items ⇒ null growth fields, hour
    granularity ⇒ empty series for daily-count metrics (same rule as history, §10.4). Series
    are keyed by item id with `{t, v}` points.
  - `/v1/stats` — zero-filled per-source live counts + the latest **succeeded** run per
    (source, job type) (`DISTINCT ON`, so a newer failed run never wins), `source: null` for
    cross-source jobs; `Cache-Control: no-store`.
- **Search implementation.** Rank = `greatest(ts_rank_cd(english), ts_rank_cd(simple))` over the
  dual `websearch_to_tsquery` OR; when the FTS hit count is `< 5` the page appends a trigram tail
  that excludes FTS matches. Since M-1 (R-54, ADR-0025) the tail predicates with the indexable
  form `lower(display_name) %> lower($q)` and lowers `pg_trgm.word_similarity_threshold` to 0.15
  for its own transaction; `items_display_name_trgm_idx` is a GIN index on `lower(display_name)`.
  The operator's default 0.6 (and `%`'s 0.3) would drop the spec's own `nxt` → `vercel/next.js`
  pair (0.286, measured on PG16), which still matches at 0.15. The higher floor drops rows that
  share only a boundary trigram; results are still ordered by the exact `word_similarity` the API
  reports, then id desc. `items_name_trgm_idx` on raw `display_name` remains because the spec
  lists it, but no query uses it.
- **Search cursor.** `{m: 'fts'|'both', p: 'fts'|'trigram', k: score, i: itemId}` — the mode is
  fixed on page 1 from the total FTS count (`count(*) OVER ()`) and carried in the cursor, so
  deeper pages cannot switch modes when the FTS count crosses the threshold between requests;
  each part uses its own keyset (`k/i`), with `i` regex-validated.
- **Caching.** §9.1 lists no keys for these routes: search reads through `q:{sha1}` for 120 s
  (canonical JSON of the parsed query, cursor included); new/topics/languages/compare get
  `publicShort` + the plugin ETag only (no Redis); stats is `no-store`.
- **Shared service.** The item history route now loads through `services/item.service.ts`
  (`loadMetricSeries`, `truncateToGranularity`), which `/v1/compare` also uses; behaviour is
  unchanged.
- Tests: unit — search/topics/compare/stats DTO parses, `buildNextLink`/`nextLinkHeader`,
  `SearchCursor` bounds, search-service page composition (FTS/trigram merge, limit < 5 boundary
  crossing, cursor round-trip, canonical key) and compare id parsing/granularity defaults; int
  `search.int.test.ts` (15, over Testcontainers) — the `nxt` → `vercel/next.js` fallback with
  cursor-proven mode, ≥ 5-FTS suppression, two-part pagination walk, source/kind filters,
  validation/404s, `q:` cache + TTL + ETag 304 + Link, `/new` windows/pagination/soft-delete
  exclusion, topics/languages live counts, compare windows/granularity/null growth, stats
  zero-fill + latest-succeeded + `no-store`. The int file computes seed-tolerant baselines
  because `packages/db/test/int/seed.int.test.ts` deliberately leaves ~200 items in the shared
  database; `apps/api/openapi.json` re-exported (16 paths).

### Task 3.5 notes

- **Tiers wired now.** `anonymous` (60 req/min per IP) and `apiKey`
  (`api_keys.rate_limit_per_min`, default 120) are live. `user` (300) needs JWT
  verification, `auth` (5/min + 3/h per email) and `admin` (600) need their routes,
  and `sse` (5 concurrent) is task 3.6 — each lands with its surface. `@fastify/rate-limit`
  now takes `max` as a per-request function so an authenticated key gets its own budget;
  the JWT tier key part (`user:{id}`) slots into the same `rateLimitKey` switch.
- **Counter namespacing.** Spec §9.1 says `apirl:{keyId|ip}`; the keys are
  `apirl:key:{id}` and `apirl:ip:{ip}` so keyed and anonymous traffic can never share a
  counter (an int test proves a keyed request never consumes the IP budget).
- **`X-API-Key` auth** (`apps/api/src/plugins/api-key.ts`): strict shape check
  (`dt_live_<8 base62>_<32 base62>`, helpers in `@trendr/core` `api-keys.ts`), unique-prefix
  lookup (`api-keys.repo.ts`, new), revoked/expired rejection and a constant-time
  `HMAC-SHA256(API_KEY_PEPPER, key)` compare. Every failure is 401 `unauthorized`
  problem+json. The hook runs before the limiter, so malformed/unknown keys are rejected
  *without* consuming a rate-limit budget — brute-force attempts are not themselves
  rate-limited; flagged here because the spec doesn't state a rule for that case.
- **Debounced `last_used_at`.** A Redis `SET NX EX 60` marker
  (`redisKeys.apiKeyLastUsed` → `apikey:last-used:{id}`, a new key not in §9.1) gates the
  write to the first authenticated request per minute per key; without Redis (unit tooling)
  the same window is kept in-process. The touch never fails a request (warn + continue).
- **Plugin registration.** `buildApp` registers the api-key plugin only when both
  `apiKeyPepper` and a db connection are present, and always before the rate limiter
  (hook order matters). `main.ts` passes `API_KEY_PEPPER` (already in the §15 env schema
  and `.env.example`); compose passes it through `env_file: [.env]`.
- **CORS.** `@fastify/cors` reflects `Access-Control-Request-Headers` by default, so
  browser preflights carrying `X-API-Key` keep working without adding `allowedHeaders`.
- Tests: unit — core `api-keys.test.ts` (format matrix incl. length/character edge cases,
  HMAC determinism + pepper sensitivity, timing-safe compare with length guard),
  `redis-keys.test.ts` (new key) and `rate-limit.test.ts` (key-vs-IP selection, per-key max);
  int `api-key.int.test.ts` (4) — the 61st anonymous request → 429 + `Retry-After` +
  `rate-limited` problem; a valid key with budget 61 serves 61 requests then 429s on its own
  counter while the anonymous counter is untouched; seven invalid-key shapes (empty,
  malformed, wrong length, unknown prefix, wrong secret, revoked, expired) → 401; debounce
  behavior (marker TTL ≤ 60 s, second request leaves `last_used_at` unchanged, re-write
  after the window lapses). `openapi.json` re-exported (still 16 paths — no wire changes).

### Task 3.6 notes

- **Route + contract.** `GET /v1/stream/leaderboard?scope&window` implements §10.6:
  `retry: 5000`, then `id: {runId}` / `event: leaderboard.snapshot` with the top-25
  (`lbmeta` + `ZREVRANGE WITHSCORES` + `card:{itemId}:{window}` deltas, missing/invalid
  card → delta 0), `event: leaderboard.update` frames for every `events:leaderboard`
  PUBLISH on the same board, 25 s `: ping` comments and `event: shutdown` on process exit.
  `Last-Event-ID` equal to the current `runId` skips the snapshot frame entirely (§10.6).
- **Update frame minus internals.** The wire payload keeps §10.6's example shape
  (`scope`, `window`, `runId`, `movers`, `entered`, `exited`); the internal `type` and
  `computedAt` from `LeaderboardUpdatedEventSchema` are dropped (the example does not
  carry them, and `id:` already tracks the run).
- **Registered even without Redis.** `registerStreamRoutes` always adds the path (so
  `openapi:export` and no-Redis builds still collect it) and answers 503 `unavailable`
  (new core `UnavailableError`) when `redis`/`redisSub` decorators are absent.
- **Concurrency cap (§10.5 `sse` tier).** `redisKeys.sseConnections` →
  `apirl:sse:{keyId|ip}` reuses the limiter's identity (key id ‖ user id ‖ IP) and
  `TRUST_PROXY` handling. INCR → 6th concurrent stream is 429 `rate-limited` problem+json
  (DECR before throwing); counters carry a 86 400 s safety TTL refreshed on connect and are
  DECR'd + DEL'd at zero on socket close. Redis errors during cap accounting fail open
  (warn + serve) and DECR failures never affect the client.
- **ioredis subscribe race (library quirk).** `subscribe` is flagged `loading` in
  `@ioredis/commands`, so calling it while the client is still connecting writes SUBSCRIBE
  mid-handshake, races ioredis's own INFO/CLIENT commands, resolves without a real
  subscription and emits a swallowed "Connection in subscriber mode" error. The broadcaster
  waits for `ready` before SUBSCRIBE (and only UNSUBSCRIBEs on a ready client); without this
  fix the stream served snapshots but never updates on a fresh app.
- **Backpressure + cleanup.** If `raw.write` reports a full socket buffer, a 10 s drain
  timer drops the connection when `drain` never arrives (§10.6). One `finalize` path
  (socket close, once) stops the heartbeat, clears timers, removes the client from the
  broadcaster, updates the gauge and releases the counter slot.
- **Metrics.** `trendr_sse_clients{scope,window}` gauge lives in the existing registry and
  is set on add/remove; the stream route is registered after `registerMetrics`.
- Tests: unit `broadcaster.test.ts` (10 — subscribe gating, board routing, malformed
  events, membership, shutdown frame, close) and `stream.test.ts` (3 — snapshot frame id /
  Last-Event-ID skip, heartbeat fake timers); int `stream.int.test.ts` (2, real HTTP +
  `fetch` streaming) — snapshot then update after a real PUBLISH (retry, runId id, deltas,
  no `type` leak), Last-Event-ID skip, 5 concurrent + 6th → 429 problem, abort drains the
  counter and a fresh stream is accepted. `openapi.json` re-exported (17 paths).
- **Connect-time ordering.** The stream registers with the broadcaster *before* reading the
  snapshot and buffers frames until the snapshot is flushed, so an update published while the
  snapshot loads is delivered right after it instead of being dropped (§10.6 order: retry,
  snapshot, updates). A CI failure caught the original gap — the client was registered after
  the snapshot read, and a publish landing in that window went nowhere.
- **Startup pub/sub race (accepted).** The broadcaster subscribes asynchronously at boot;
  a PUBLISH in the first milliseconds can land before SUBSCRIBE. Reconnect/snapshot covers
  state; int tests republish until the update frame arrives rather than assuming a single
  publish cannot race connection setup.

### Task 3.7 notes

- **compose-smoke now seeds and asserts trending.** The new step runs the spec §17.4
  commands (`docker compose exec -T api node packages/db/dist/seed.js`, then
  `curl … /v1/trending?scope=all&window=7d | jq -e '.data | length > 0'`) with one addition
  between them: the task 2.6 admin-less scoring CLI
  (`docker compose exec -T worker node dist/score-cli.js --source github`) plus a bounded
  poll (30 × 2 s) around the assertion. Rationale: the seed writes items/series but no
  scores, and the `score-safety` scheduler is hourly, so the spec's immediate assert would
  race an empty board; scoring any one source rebuilds the combined `all` board (§8.4 step
  9), so the spec's exact `all` query is preserved.
- **Container paths.** `pnpm deploy` ships only the app's own tree: the seed runs in the
  **api** image through the `packages/db` symlink `node.Dockerfile` creates for every app,
  while `score-cli` (`dist/score-cli.js`, a worker tsup entry) runs in the **worker** image.
  Both containers carry `DATABASE_URL`/`REDIS_URL` via `env_file` and `node-env`.
- Verified locally with the exact workflow commands (Docker 29.7, Compose v5.4): the seed
  is idempotent (`200 items … API key dt_live_seedkey1…`), the CLI enqueues the run and the
  first poll already answered `entries=50 runId=9`; `/readyz` reports ready; the web image
  serves HTML in-network. The web service's host port 3000 is occupied on this machine by
  an unrelated project, so the job's `localhost:3000` check effectively runs on CI only
  (see quirks).

## Phase 4 notes

### Task 4.1 notes

- **`token-bucket.lua` shipping.** `token-bucket.ts` loads the script with
  `readFileSync(new URL('./token-bucket.lua', import.meta.url))` (the spec snippet) instead of
  inlining it. Tests and tsx read it next to the source, but the tsup bundle is a single
  `dist/index.js`, so in prod the URL resolves to `dist/token-bucket.lua`; the core build now
  runs `scripts/copy-assets.mjs` after tsup to place it there (`docker` images consume the built
  output through `pnpm deploy`). Verified by building core and importing the bundle from `dist`.
- **Typed ioredis augmentation.** The custom command is declared with
  `declare module 'ioredis' { interface Redis { takeToken(...) } }` rather than
  `@ts-expect-error` (the no-`any` rule still applies), so `ioredis` joins `@trendr/core`'s
  devDependencies (type-only import; the emitted d.ts needs it resolvable from consumers too).
- **`take(cost, signal)`, not `take(key, n)`.** The spec tree comment sketches
  `RedisTokenBucket.take(key, n)`; the §7.4 snippet below it is the contract, and it derives both
  Redis keys from the bucket's own `name` (`rl:{name}`, `rl:{name}:pause`, §7.3 bucket table) —
  one instance per bucket shared by all jobs is what the worker needs.
- **`fetch-json` options are the spec shape plus five additions** (`source`, `endpoint`,
  `userAgent`, `metrics`, `backoffBaseMs`/`backoffCapMs`): the §7.5 sketch has no source label,
  but §12 metrics need `source`/`endpoint`; core must not read `env` (zod-only rule), so the
  caller passes `env.HTTP_USER_AGENT`; the retry window is injectable so unit tests do not wait
  (defaults are the spec's 500 ms → 10 s).
- **Metrics sink instead of prom-client.** `FetchJsonMetricsSink` (request/error/duration)
  keeps core dependency-free; task 4.2 adapts the worker's prom-client registry to it. The
  `status` label is the HTTP status code (or `network` when no response arrived); error kinds
  are the §12 set plus `schema` for zod/JSON failures.
- **Status mapping.** `304 → not_modified`; `404/410 → not_found`; `429` and 403-with-quota
  signals (`retry-after` or `x-ratelimit-remaining: 0`) call `pauseUntil` and throw a retryable
  `UpstreamError` (`retry-after` seconds or HTTP-date → `x-ratelimit-reset` epoch → 60 s
  fallback); `5xx`/network/timeout retry in-process (max 3 attempts) with full jitter, then a
  retryable `UpstreamError`; other `4xx` are non-retryable. `2xx` bodies are zod-parsed and
  failures carry the first five issues plus a 12-char sha256 of the payload — the payload
  itself is never logged (spec §7.5).
- **SSRF hardening.** https-only plus the eight §15 hosts, checked before any fetch.
  Redirects are never followed (`redirect: 'manual'`, 3xx → non-retryable error) so a
  compromised allowlisted host cannot bounce a request to the internal network.
- Acceptance coverage: unit tests exercise every status branch, retry exhaustion/success,
  timeout, caller-abort propagation and SSRF rejection; the int test drives 20 concurrent
  takers against capacity 10 + refill 1/s on real Redis (~10 s) and asserts the
  `grants(t) <= capacity + refill·t` bound per grant, plus a `pauseUntil` block.
- Task 4.2 will wire this into the worker: replace `apps/worker/src/queues.ts`'s local
  `backoffDelay` with the core export (adding the spec's full jitter) and map
  `UpstreamError.retryable`/`retryAfterMs` onto BullMQ attempts and job backoff.

### Task 4.2 notes

- **Scope split inside §7.1 step 5.** The processor and `persistNormalizedItems` write items and
  (per mode) snapshots + daily metrics in one transaction per chunk. `items.topics` is already
  carried by `NormalizedItem` but topic normalization (`packages/core/src/topics.ts`,
  `item_topics`) and alias resolution (`item_aliases`, stub items with tier `cold`) are deferred
  to the 4.3+ adapter work: they need per-source metadata shapes (GitHub topics, npm keywords,
  PyPI classifiers, HF `pipeline_tag`, arXiv categories) and per-source stub defaults
  (name/URL/primary metric) that only the real adapters define. The transaction is structured so
  both slot in right after the `items` upsert (they need the returned ids).
- **Discover's minimal-row upsert and backfill fan-out deferred for the same reason.** Refs
  without a payload (`raw === undefined`) are counted but not yet upserted — "minimal items rows
  (tier warm for new items)" needs the same per-source defaults. Discovered refs that *do* carry
  payloads are normalized and upserted now, with `upsertItems`'s new insert-only option
  (`newItemTier`) implementing §7.1's "tier warm for new items" without touching tiers on
  conflict (tiering keeps ownership after the first write).
- **`daily` job has no tier, `FetchOptions.tier` is required.** The processor loads the source's
  tracked items and groups them by their stored tier, fetching per group — same batching
  semantics, accurate tier hint, and the per-tier 50 %-failure quota stays scoped correctly.
- **Run counters vs. §12 metrics.** `ingestion_runs.api_calls` counts one call per
  `fetchMetrics`/`backfill` invocation for now (≈ one HTTP round trip per chunk for the batch
  endpoints); exact per-request counts and `rate_limit_remaining` wiring arrive with the first
  real adapter, which is where the 4.1 `FetchJsonMetricsSink` and `onHeaders` hooks get attached
  (the sink is adapter-scoped, the recorder is job-scoped).
- **`trendr_queue_depth` (§14.1, polled every 15 s via `getJobCounts`) is not part of 4.2** — no
  §7.x code path produces it; it lands with the §10.1/admin + observability task. `trendr_dlq_jobs_total{queue}` (the §7.7 code path)
  is implemented and unit-tested instead.
- **Backoff rewiring done as planned.** `apps/worker/src/queues.ts` no longer defines a local
  `backoffDelay`; the strategy is core's full jitter (`backoffDelay(attemptsMade, 5_000,
  30 * 60_000)`, §7.5 line 1780) unless the failure is an `UpstreamError` with `retryAfterMs`
  (429/quota-403), in which case the worker waits exactly that long plus ≤5 s of jitter.
- **DLQ hardening per §7.7.** Entries land with the deterministic `dlq.{queueName}.{jobId}` id
  (idempotent re-parks), `removeOnComplete: false` / `removeOnFail: false` (ops-inspectable until
  purged), and increment `trendr_dlq_jobs_total{queue}` once the entry is stored; a failed park is
  logged, never thrown from the event handler. `UnrecoverableError` parks on attempt 1.
- **Missing config is unrecoverable.** `getAdapter` throws `AdapterNotRegisteredError`; the
  processor maps it (and non-retryable `UpstreamError`s) to BullMQ `UnrecoverableError` so a bad
  payload or unconfigured source does not burn five attempts, then lands in the DLQ with the
  reason.
- Acceptance coverage: unit — adapter registry, §7.4 bucket table (incl. Hugging Face scaling),
  the backoff strategy branches, and the DLQ park rules (final attempt, unrecoverable-first,
  intermediate no-op, missing job, park failure); int — schema-invalid payload → DLQ after
  1 attempt with no `ingestion_runs` row, retryable `UpstreamError` → 5 attempts → DLQ with
  5 `failed` run rows, missing adapter → unrecoverable, and a happy `snapshot` run that replaces
  stale metadata, writes the hourly snapshot, records `succeeded` and enqueues the §7.1-step-7
  scoring job.

### Task 4.3 notes

- **Fixtures are live recordings (re-recorded 2026-10-19).** With a fine-grained PAT in `.env`,
  `record.ts` (`RECORD=1 pnpm fixtures:record --source github`) ran end to end: search (new-hot +
  topic), REST repo (ETag + expiry header), the **production** `buildBatchQuery` snapshot response
  (`graphql-batch.json` — the recorder replays the adapter's own query, not the minimal cost probe),
  `stargazers/history` page 1, `stargazers/count`, the retired listing's 403
  (`stargazers-listing.json`) and `meta.json` (costs, expiry header, history window). Tests assert
  fixture mapping structurally (against each fixture's own raw values), so re-recording refreshes
  the data without invalidating assertions; `graphql-renamed.json` stays hand-authored (a synthetic
  rename edge case, like the flag-flip in the archived/fork test). A unit test scans the fixtures
  for token-shaped strings.
- **Deviation — GitHub retired the stargazer listing (June 2026).** `GET /repos/{o}/{r}/stargazers`
  (also watchers/subscriptions) is now limited to admins and collaborators: a live call answers
  `403 Resource not accessible by personal access token` (unauthenticated: 401). Spec §7.3.1's
  backfill mechanism ("walk `stargazers?per_page=100` with `Accept: application/vnd.github.star+json`")
  and the task 4.3 acceptance line naming that header are superseded: `backfill` pages
  `stargazers/history` (30 weeks per page, `days[7]` Sunday-first UTC) plus one `stargazers/count`,
  so requests no longer scale with star count and the reachable depth is ≈ 100 × 30 weeks.
  `BACKFILL_GITHUB_MAX_PAGES` remains as a budget guard. Output semantics are unchanged:
  end-of-day cumulative `stars` in `daily_metrics`, truncated to days the fetched pages fully cover.
  ADR-0012 records the decision and the live evidence.
- **Fetch paths.** Single refs refresh via REST conditional GET (`If-None-Match`; per-item
  `etag:github:{itemId}` in Redis, 7-day TTL; 304 → `notModified`); batches go through one GraphQL
  POST with ≤ 50 aliases (the tested `batchSize`). 404 maps to `notFound` (counted per item, not
  fatal). 3xx is never followed (§15 redirect hardening) and surfaces as a non-retryable error.
- **Rename handling (§5.4).** Before the `(source, external_id)` upsert, `persistNormalizedItems`
  looks up `upstream_id`s (`loadItemsByUpstreamIds`) and moves a row whose `external_id` changed:
  `applyItemRename` updates the name, inserts a `tier='cold'`, `flags=['stub']` item for the old slug
  (deliberately not soft-deleted, so `/aliases` keeps surfacing it) and an `item_aliases` row
  (`same_project`, confidence 1, evidence `github_rename`). Stubs are excluded from
  `listTrackedItems`: fetching the dead slug would 301 and, since redirects are never followed, kill
  the snapshot job. An explicit `refresh-item` on a stub still surfaces the 301 as non-retryable.
- **304 continuity (§7.3.1).** In `snapshot` mode the processor rewrites each 304 item's last stored
  values (`items.latest_metrics`) into the current bucket via `persistContinuitySnapshots` and counts
  `not_modified`; `daily` mode skips it (no snapshot rows). Items that changed in the same run were
  normalized first, so a later 304 still falls back to current values.
- **Exact `api_calls`.** `ingestion_runs.api_calls` and the `trendr_source_api_*` metrics now come
  from the same per-job `FetchJsonMetricsSink` the adapter writes on every HTTP call — the 4.2
  "one per batch" counting is gone. `onRateLimit` feeds `trendr_rate_limit_remaining{source,resource}`
  (next to the reserve pause), and `onTokenExpiry` feeds GAP-8's gauge/log (ADR-0013).
- **Item topics: normalization in, persistence still out.** `packages/core/src/topics.ts` normalizes
  slugs (lowercase, `_`→`-`, synonyms, ≤ 20 per item, 50-char cap mirroring the §6.2 CHECK); GitHub
  repo topics flow into `NormalizedItem['item'].topics`. Writing `topics`/`item_topics` rows is still
  deferred with the 4.2 note (it needs chunk-level topic diffing) — nothing reads the columns yet;
  it lands with the discovery/search workstream.
- **Discover still doesn't fan out to backfill** (4.2 note stands): `discover` upserts
  payload-carrying refs only. The search strategies (new-hot, rising, topics, active-established with
  `created:` range slicing for > 1000-result queries, ≤ 10 pages each) and `backfill` are implemented
  and tested; scheduling and the discover→backfill fan-out land with 4.4.
- **GAP-1/7/8 are verified** (ADRs 0011–0013): the 50-alias batch costs 1 GraphQL point (measured
  live), the stargazer backfill reads weekly `stargazers/history` buckets because the user listing
  is retired for non-collaborators (see the deviation note above), and the PAT expiry header was
  captured (`2027-01-17 16:40:21 UTC`).
- Acceptance coverage: unit — fixtures (normalize repo/archived/fork/renamed/not-found, search
  mapping, GraphQL batch parse incl. a `NOT_FOUND` alias), topic normalizer, and request shapes
  (≤ 50 aliases + token rotation, `If-None-Match`/ETag round-trip, 304, 404, reserve pause + GAP-8
  expiry, `created:` slicing for a 1,200-result query, `maxItems`, topics query,
  `stargazers/history` paging (`per_page=30`) + `stargazers/count`, truncation at the page cap,
  empty-repo short-circuit, fatal vs rate-limited errors);
  int — rename → external_id move + stub + alias row, and a 304 → continuity snapshot from
  `latest_metrics` with `not_modified` recorded on the run.

### Task 4.4 notes

- **Six §7.2 GitHub rows, registered idempotently.** `registerSchedulers` now registers the
  `gh-discover-*` and `gh-snapshot-*` rows next to the hourly `score-safety` schedulers, all with
  `tz: 'UTC'` and §7.2's crons (`*/30`, `10 */2`, `20 */3`, `5 * * * *`, `15 */6 * * *`,
  `30 1 * * *`). There is no `gh-daily` row in the spec table: GitHub daily series come from the
  hourly snapshots plus `rollup-daily` maintenance. Schedulers register even when `GITHUB_TOKENS`
  is empty so the stack shows `skipped` runs instead of a silently dead schedule; discovery caps
  are 500 (new-hot), 300 (rising) and 150 (topics) items per pass.
- **`snapshot-fanout` payload.** The §18 excerpt registers the job *name* `snapshot-fanout` but
  shows `data.type: 'snapshot'`; the worker dispatches on payload, so the run uses a dedicated
  `{type: 'snapshot-fanout', source, tier}` variant (also listed in §17's job-name list). All
  ingest payloads gained an optional `trigger: 'schedule' | 'manual'`; fan-out children inherit
  `trigger: 'schedule'`.
- **Fan-out.** `countTrackedItems` (same filters as `listTrackedItems`: source, tier, not deleted,
  no `stub` aliases) → `ceil(count / FANOUT_BATCH_ITEMS)` child `snapshot` jobs with
  `{batch, batchCount}`. An empty tier completes without children. Child job ids come from §5.2's
  `jobId.snapshot(source, tier, hourSlot, batch)`, with the slot derived from the parent's
  `job.timestamp` (not `now()`): a retry of the same fan-out dedupes, later ticks get new ids.
  Hot/warm children run immediately; cold children are delayed evenly across the 01:30–04:00
  window (150 minutes). `FANOUT_BATCH_ITEMS` is passed through `IngestDeps` from the env (default
  500).
- **Scheduled jobs without credentials are `skipped`.** `AdapterNotRegisteredError` +
  `trigger === 'schedule'` closes the run as `skipped` (already in `run_status_t`) with a warn log
  naming the source and reason, and the BullMQ job completes on its first attempt — no retries and
  no DLQ entry. Operator-created jobs keep §7.5's unrecoverable→DLQ behaviour (the 4.2 acceptance
  test is unchanged), and the fan-out itself uses the same rule, so no children spawn when the
  adapter is missing.
- **Schema/migration.** `job_type_t` gained `snapshot-fanout` (`0002_stormy_killer_shrike.sql`)
  for `ingestion_runs.job_type`; `IngestJobSchema` tests cover the new variant and trigger enum.
- Acceptance coverage: unit — schedule table (six ids/crons/payloads plus score-safety), fan-out
  planner (`ceil`, empty tier, cold spread, hour slot); int — scheduled no-adapter job ⇒ `skipped`
  run + completed job + no DLQ; warm-tier fan-out ⇒ `ceil` deterministic children (batch data,
  `trigger`, id-derived slot), every tracked item snapshotted, alias stub excluded, fan-out run
  `succeeded` with zero items seen, and children complete.
- **Live acceptance with real tokens (2026-10-19).** The 17:30Z–18:20Z crons ran on the compose
  stack against the live GitHub API with one PAT. `ingestion_runs`: four succeeded `discover` runs
  (new-hot 500 + 500 items, rising 300, topics 150; 15 API calls total) — the 17:30Z job took all
  five attempts after four container-egress `fetch failed` flakes (§7.5 retries; the final attempt
  upserted 500/500); hot (18:05, 1 item) and warm (18:15, two children of 381 + 390 items)
  `snapshot-fanout`/`snapshot` runs succeeded; hourly `score` runs succeeded for all six sources.
  No `skipped` runs. `snapshots`: the 17:00Z bucket holds 1,500 rows (initial captures from the
  successful discover) and the 18:00Z bucket grew to 3,535 rows as the hourly ticks landed; the
  stored history shows the same hourly cadence from 2026-10-16T17:00Z through 2026-10-19T06:00Z.

### Task 4.5 notes

- **Ordered rule engine, pure and testable.** `apps/worker/src/ingestion/tiering.ts` holds
  `planRetierItems` (pure, order-deterministic) plus `runRetierItems` (one candidate query, one
  transaction of tier updates). Rules run in §7.8's order: hot → warm → cold → archived.
- **Hot cap.** Per-source, with the best-7d-percentile tie-break and id as final tie-break. Watched
  items are exempt from the cap: §7.8 says "capped", but the same section promises an instant
  promotion on watchlist add, and a nightly demotion of a just-watched item would contradict it.
  Only `TRACKED_HOT_MAX_GITHUB` / `TRACKED_HOT_MAX_HUGGINGFACE` exist (env), so other sources are
  uncapped.
- **Admission minima** for "created ≤ 7 d with primary metric ≥ source admission minimum" come from
  §7.3's discovery thresholds: GitHub new-hot `stars:>=20`, npm `NPM_MIN_WEEKLY_DOWNLOADS` (200),
  PyPI `PYPI_MIN_WEEKLY_DOWNLOADS` (500), HF newest `likes>=5`. arXiv and MCP have no
  metric-based minimum (arXiv uses the ≤ 30 d age rule). Constants live in `ADMISSION_MINIMUM`;
  `RetierOptions.admissionMinimum` overrides for tests/future tuning.
- **Growth and "seen" semantics.** Cold = seen in the last 90 d (`GREATEST(last_snapshot_at,
  last_seen_at)`) or a positive 30 d delta. Cumulative metrics compare the newest snapshot value
  with the newest value at/before the horizon; daily-count metrics (npm/PyPI downloads) sum
  `daily_metrics` over the window, and "no rows" means unknown (`null`), never zero. Archived is
  the fallback of the ordered evaluation (§7.8's "no positive delta for 60 d" cannot be checked
  *before* "seen in the last 90 days" under the stated order, so the order wins), plus one extra
  clause: an upstream-archived (`items.is_archived`) **unwatched** item stops polling even if seen
  recently. Watched items still win the hot rule above.
- **HF trending top 100 / arXiv.** arXiv is a plain source + age rule. HF trending reads
  `metadata->>'trendingRank'` when it is a JSON number; the phase-5 HF adapter must record that key
  (the rule is inert until then — noted in the deferred list).
- **Instant promotion hook.** `promoteItemToHot(db, ingestQueue, itemId)` sets `tier='hot'` and
  enqueues `refresh-item` with `jobId.refreshItem(source, itemId, utcDay)`: one refresh per item
  per UTC day, so a repeated watchlist PUT dedupes the job and reports `already-hot`. Alias stubs
  are `not-promotable` (their old slug 301s; redirects are never followed). The watchlist
  endpoints arrive in phase 5; the hook takes its queue as a parameter, so today's integration
  test exercises it end-to-end.
- **Maintenance queue + processor.** `Queues` gains `maintenance: Queue<MaintenanceJob>`;
  `createMaintenanceWorker` is hosted by the `scoring` role (§3.2 "reuses the process"), implements
  `retier-items`, and throws `UnrecoverableError` for the other §7.10 jobs until their tasks land.
  The scheduler registers `retier-items` at `0 5 * * *` UTC.
- **Deferred.** `topics.item_count` maintenance (schema comment "maintained by retier-items job")
  waits for `item_topics` persistence (already deferred in 4.2/4.3 notes); recomputing today would
  zero every counter. `trendr_queue_depth` remains a 9.x item.
- Acceptance coverage: unit — watched + cap exemption, cap tie-break, rank ≤ 200 / ≤ 2000 windows,
  admission minima, arXiv/HF, warm (≤ 30 d, alias of hot), cold (seen 90 d / positive delta),
  archived (no growth, upstream archived, watched exemption), no-op changes, input-order
  determinism; int — promotion sets `hot` and enqueues the deduped refresh (stub refused, missing
  item reported), and a full `maintenance:retier-items` job moves stale→archived, rank≤200→hot,
  alias→warm, fresh→hot, live→cold while the watched item stays hot (the shared DB's tiers and
  `score_runs_current` pointer are saved and restored around the run).

### Task 4.6 notes

- **Admin auth.** `apps/api/src/plugins/auth.ts` registers `@fastify/jwt` (the §15 library) with
  `iss=trendr`, `aud=trendr-api` and a 15-minute sign default (`JWT_ACCESS_TTL`, matching
  `JWT_ACCESS_TTL_SEC=900`; task 7.1's magic-link flow signs through the same instance). An
  `onRequest` hook verifies every `Authorization: Bearer` token and decorates
  `request.authUser = {id, role}`; invalid/expired/malformed tokens are 401 before any route logic.
  `requireAdmin` accepts an `admin`-scope API key or a JWT whose role claim is `admin`; anonymous
  callers get 401 and authenticated non-admins 403 (the task acceptance). Two Fastify-v5 details
  this relies on: the guard is a **route-level `onRequest` hook that must stay `async`** — the hook
  runner only advances when a hook returns a promise or calls `done`, so a synchronous
  `(request) => void` guard silently *stalls every authorised request* (found while testing: 401/403
  throws worked, passes hung until the 30 s test timeout); and `@fastify/rate-limit` injects its
  handler via `onRoute` by **appending** it to the route's own hooks, so admin calls are rate-limited
  **after** the guard. Rejected admin calls (401/403) therefore do not consume quota — the same
  ordering already applied to invalid API keys and tokens on every route; authorised traffic is
  always counted under the §10.5 key/user/admin tiers.
- **§10.5 tiers completed.** The rate limiter now keys JWT traffic `apirl:user:{userId}` and applies
  the spec's `user` (300/min) and `admin` (600/min) budgets; API-key precedence (`key:` first) is
  unchanged, so a keyed request keeps its own DB budget even if it also carries a token.
- **Queue producers in the API.** `apps/api/src/queues.ts` builds one BullMQ `Queue` per §5.2 name
  over a dedicated connection (`maxRetriesPerRequest: null`; owned by `main.ts`, queues closed by an
  `onClose` hook). The §7.5 default job options moved to core (`DEFAULT_JOB_OPTS`) so worker and API
  cannot drift; the worker's `defaultJobOpts` now aliases it.
- **`POST /v1/admin/ingest`.** The spec's loose `{source, type, strategy?, tier?, itemId?, days?}`
  shape is a discriminated union with per-type required fields (`maxItems` default 500, `days`
  default 60). `snapshot` maps to the §7.2 `snapshot-fanout` payload — a single batch job would only
  cover the first 500 items — under the new `jobId.snapshotFanout`
  (`{source}.snapshot-fanout.{tier}.{slot}`); `backfill` gained `jobId.backfill`
  (`backfill.{source}.{itemId}.{day}`). Manual triggers carry `trigger:'manual'`, so the §7.5
  unrecoverable→DLQ path applies instead of the scheduled skip.
- **Runs.** `listRuns` is newest-first with a run-id keyset cursor (`?cursor=`), filters
  `source`/`jobType`/`status`/`from`, fixed 50/page and the §10.5 `Link` header; the detail endpoint
  adds `params`. `RUN_STATUSES`/`JOB_TYPES` became named const arrays in `@trendr/db` (the pg enums
  derive from them) so the wire enums cannot drift from `run_status_t`/`job_type_t`.
- **DLQ.** Listing is a newest-first offset cursor over the `dead-letter` queue (entries stay
  `waiting`; nothing consumes that queue). Retry re-adds the payload to its original queue with a
  `.retry{n}` suffix where n is a Redis `dlq:retry:{jobId}` INCR (30 d TTL) and removes the parked
  entry; DELETE discards. Malformed entries list with an “invalid dead-letter payload” marker but are
  refused for replay (400).
- **Rate-limits endpoint.** SCANs `apirl:*` (string counters + PTTL) and `rl:*` (bucket hashes
  `tokens`/`ts`, `:pause` keys, plus the new `rl:last:{source}:{resource}` hashes). The worker now
  persists each `onRateLimit` observation to `rl:last:…` (7 d TTL, best-effort: a Redis failure is
  logged and never fails the run). Capacity/refill come from `@trendr/sources`' bucket specs
  (`github:core:{tokenIdx}` included) — the API imports that workspace package for the spec
  constants only, which respects the §4 dependency direction; unknown bucket names report stored
  tokens with `capacity: null`.
- **Item patch.** `patchItemAdmin` merges the flags in SQL (union of `addFlags` then difference of
  `removeFlags`) and returns the new state; the route invalidates `item:{id}` through the cache
  plugin (§9.3/§10.4). Flags are validated against the new core `ItemFlagSchema` (`ITEM_FLAGS`
  const), tier against `TierSchema`. The flag lists bind through `sql.param(...)`: a bare drizzle
  interpolation spreads a JS array into one placeholder per element (and an empty array into no
  placeholder at all), which made the generated `text[]` expressions invalid until wrapped (probed
  directly against Postgres).
- Acceptance coverage: int (real Postgres + Redis + BullMQ) — 401/403 matrix (anonymous, invalid
  token, `user` JWT, read-scope key) with an admin JWT and a `read,admin`-scope key accepted; runs
  list/detail/404/400; manual discover and snapshot jobs on `ingest-github` plus a manual `score`
  for every source with deterministic ids (a same-slot ingest/scheduled scoring job can win the
  §5.2 dedupe and keeps its own payload — the API still answers 202 with that id); queue counts for
  all 11 queues; rate-limit API counters, bucket hash+pause and upstream headers; item patch + cache
  invalidation + 400/404; DLQ list/replay `.retry1`/discard/404. Unit — the pure ingest mapping for
  all five types, the slot/day helpers, the JWT/admin rate-limit key/tier resolution and the auth
  contract (sign defaults `iss=trendr`/`aud=trendr-api`/15 min, foreign issuer or audience rejected,
  guard returns a promise and yields the 401/403/200 matrix).

### Task 5.1 notes

- **Adapter surface.** `packages/sources/src/npm` implements keyword discovery (`text=keywords:{k}`,
  `size=250`, `from ≤ 1000`), the full packument on snapshot/refresh, bulk/scoped download ranges and
  the 60-day backfill. Discovery rotates the 19 spec keywords by 6-hour UTC slot so a fixed
  `maxItems=1000` budget does not starve the tail; admission is `downloads.weekly ≥
  NPM_MIN_WEEKLY_DOWNLOADS` (200) **or** latest publish ≤ 30 days (the spec's rule).
- **Daily anchor (deviation, observed live).** The spec says `range/{D-2}:{D}` and treats a missing
  D as late. In practice npm echoes the requested `end` and fills a day it has not computed yet
  with `0`: on 2026-10-20 at 03:09Z, `point/last-day/react` returned `2026-10-18`, while
  `range/2026-10-17:2026-10-19/react` returned `2026-10-19` with `0`. Anchoring on "UTC yesterday"
  would therefore persist a false zero (and a collapsed latest metric). The adapter probes
  `GET /downloads/point/last-day/{watermarkPackage}` (default `react`, cached 10 min per process)
  and builds the 3-day window ending at that day. `dailyIncomplete` is still set — and the run still
  closes `partial` — when a package's response lacks the watermark day, so the 06:00 retry can fill
  it. The recorder stores `point-last-day.json` and `meta.lastDay/window` as evidence.
- **Metadata cadence.** Search results carry `description`, `keywords`, `license`, `publisher`,
  `links.homepage` and `links.repository`, so discovery normalizes full rows and emits the
  `package_of` GitHub alias without a packument (`links.repository` → GitHub; 0.9 confidence,
  evidence `npm.repository.url`). `upstream_created_at` is deliberately **null** from search: the
  API's `package.date` is the latest *publish* date (verified: `react`'s is 2026, its creation is
  2011). The full packument's `time.created` fills it on refresh/backfill; the weekly metadata
  cadence lands in task 5.6, while alias persistence shipped in task 5.5. Only the latest version
  manifest is inspected for `types`/`typings`/license fallbacks.
- **Contract extensions (additive).** `FetchedItem.dailyIncomplete?` (§7.3.2 partial signal),
  `FetchOptions.mode?: 'snapshot' | 'daily'` (daily may skip metadata calls), and `DailyJob.day?`
  (BullMQ scheduler templates are static; the scheduled rows omit it and adapters anchor on
  `ctx.now()`; manual jobs may still carry a day). The run result/log gain `itemsIncomplete`;
  `ingestion_runs` is unchanged because the spec's table has no such column.
- **Persistence.** Daily payloads carry only the series, so `upsertItems({preserveMetadata:true})`
  coalesces null description/homepage/language/license/owner; `upsertDailyMetrics({
  refreshAggregates:true})` mirrors the newest stored day into `items.latest_metrics` (the spec's
  daily-count model otherwise leaves the item row at `{}`; the seed models this too). Backfill uses
  the same refresh. `listTrackedItems({excludeArchived:true})` keeps `archived` items out of the
  daily sweep (§7.8).
- **Scoped/bulk limits.** Scoped names are encoded `@scope%2Fname`; the bulk endpoint rejects them
  with HTTP 400 (captured in `meta.scopedBulk`), so each scoped package gets its own range request.
  Unscoped names are chunked at 128. Bulk `null` entries (unknown package, HTTP 200) map to
  `notFound`; a 404 on a single request does too. Response search `.../react,vue,typescript` order
  is irrelevant to mapping.
- **Schedules.** `npm-discover` `0 */6 * * *` (`maxItems=1000`), `npm-daily` `30 2 * * *`,
  `npm-daily-retry` `0 6 * * *` (§7.2/§7.3.2). The retry is a second scheduler id for the same
  static payload; re-running the moving 3-day window at 06:00 repairs a `partial` 02:30 run and
  picks up late corrections if npm's `last-day` advanced in the meantime.
- **Downloads rate (deviation, observed live).** §7.4 lists `npm:downloads` at 5 burst / 2 req/s
  but marks the number "verify" because npm publishes no limit. Live 2026-10-20: a 240-package
  daily sweep (143 scoped, hence 143 one-package range requests) hit a Cloudflare **429** at
  `api.npmjs.org` on the 25th unique range request in ~12 s. The response was an HTML mitigation
  page with `Retry-After: 0`, not JSON. Because `fetchJson` honored the zero literally, the bucket
  paused for 1 ms and BullMQ's quick retries kept extending the block, exhausting all five
  attempts. Two fixes: `fetchJson` now treats `Retry-After: 0` (and already-past reset values) as
  the 60 s fallback, and the bucket is capacity 2 / **0.2 req/s** (12/min). The spec asks for a
  conservative bucket where the limit is undocumented; a 15-package probe at ~9/min was clean.
  A full 240-item sweep at 12/min is projected at ~12 minutes, which fits the 02:30→06:00 window;
  if the tracked set grows, scoped packages will need a weekly-range or partial-sweep strategy.
  The full 240-item run was not exercised end-to-end: after the rate fix the worker container's
  `api.npmjs.org` connections intermittently timed out (host requests were 200), so live
  acceptance used the subset recorded below. The timeouts were network errors, not 429s.
- **Fixtures.** `RECORD=1 pnpm fixtures:record --source npm` captures the live search, an
  `is-number` full packument, a 3-package bulk range, a scoped range, the `last-day` point and the
  scoped-bulk 400 evidence. No credentials; the token/header scan still applies to the packument
  README text.
- **Deferred.** Alias persistence + `item_topics` (as in 4.2/4.3), weekly packument refresh,
  discovery→backfill fan-out (backfill is callable and accepted live via the admin endpoint, but no
  automatic enqueue yet), and `TRACKED_MAX_NPM` enforcement (the cap-check task remains open).
- Acceptance coverage: unit — day/encoding/chunk/URL-parser maths, keyword rotation, search
  admission, bulk/scoped request shapes, `last-day` anchoring, packument 404, backfill clamp,
  fixture normalization and the no-secret scan. Int (real Postgres + Redis + BullMQ) — a daily run
  persists available days, preserves discovery metadata, mirrors `latest_metrics`, closes
  `partial` with `itemsIncomplete=1`, skips archived items; a backfill job writes its series and
  refreshes the aggregate. The int test parks foreign seeded npm items in `archived` for its run
  and restores them (shared DB).
- **Live acceptance (2026-10-20).** Discovery `keywords` with `maxItems=200`: 200 seen / 200
  upserted / 0 failed (240 npm items total after the 40 seeded). The daily sweep ran on a 49-item
  subset: 40 seeded + 10 discovered (5 scoped), with the other 190 discovered items temporarily
  parked in `archived` and restored afterwards because the container's npm egress kept timing out.
  It failed attempts 1–2 on the `last-day` probe (`fetch failed`) and succeeded on attempt 3:
  49 seen / **49 upserted / 0 failed**. All 10 discovered samples have three days
  (`2026-10-16..2026-10-18`), including scoped packages, and `latest_metrics.downloads` mirrors
  the 10-18 value (e.g. `agentdb` 16080/19092/16293, latest 16293). The parked
  `jina-ai-provider` has no rows for the window (archived exclusion). A 60-day backfill of
  `agentdb` (id 3335) succeeded: **61 rows `2026-08-19..2026-10-18`**, 8 valid zero days, latest
  still 16293. The 190 restored items will be swept by the next scheduled daily.

### Task 5.2 notes

- **Adapter surface.** `packages/sources/src/pypi` implements RSS discovery (`packages.xml`,
  `updates.xml`) plus the spec's ≈300-project `seed.json`, project JSON metadata with ETags,
  pypistats `overall?mirrors=false` daily series/backfill, PEP 503 normalization and
  `project_urls` → GitHub `package_of` aliases. The seed list is included whenever the process has
  not completed a full sweep in the last 24 h; the marker is set only when the run budget covers
  the whole list and every candidate was processed, so a tiny manual discovery does not suppress
  the scheduled seed sweep and a failed seed run retries. A first full sweep is ~300 project JSON
  calls (10/s) plus up to 300 `recent` calls (0.5/s, ~10 min).
- **Discovery and admission.** Both feeds are parsed with `fast-xml-parser`; the project name is
  read from the `/project/{name}/` link (title fallback strips “added to PyPI” and the version).
  RSS items are filtered by the spec keywords on the name, title and summary; the seed list
  bypasses the keyword filter but not admission. Admission is `recent.last_week ≥
  PYPI_MIN_WEEKLY_DOWNLOADS` (500) **or** first release ≤ 30 days; new projects therefore skip the
  pypistats call entirely. The per-process recent cache (24 h) keeps RSS polling from re-calling
  pypistats for the same project every 30 minutes, honoring the “at most once per day per
  package” etiquette. A 404 from pypistats is treated as “no series yet”, not as an item failure.
- **Metadata and ETags.** The project JSON is fetched on discovery and on snapshot/refresh; the
  response ETag is stored under `etag:pypi:{project}` for 7 days and sent as `If-None-Match` on
  the next refresh. A 304 uses the processor's normal continuity path. Live evidence (2026-10-20)
  for `mcp`: ETag `"Opwgy85QHdhw9h38/BVOzA"`, `cache-control: max-age=900, public`,
  `x-pypi-last-serial: 41751579`; the recorder stores these in `meta.json`.
- **Daily anchor (deviation, observed live).** The spec's “last 3 days” is implemented as the
  three rows ending at the **newest day pypistats actually returns**, not at UTC yesterday.
  On 2026-10-20 at 04:41Z the `mcp` overall series ended at **2026-10-19** (the expected day), so
  the window is `2026-10-17..2026-10-19`; if the newest returned day is older than UTC yesterday,
  the item still persists the available days and the run closes `partial` (`dailyIncomplete`) for
  the 11:00 retry. pypistats does not invent a zero row for a day it has not computed, so this
  check is the analogue of npm's `last-day` probe without an extra watermark request.
- **Series and backfill.** `overall?mirrors=false` rows are filtered to
  `category=without_mirrors` and sorted by date. Backfill keeps the newest **60** rows of the
  existing 180-day series (the spec's “keep 60 days”); daily keeps 3. The live `mcp` capture had
  **195** points (`2026-04-08..2026-10-19`), i.e. pypistats currently returns more than the
  documented 180 days; the adapter does not depend on the exact length. Recent `mcp` was
  65,372,845 downloads/week at capture time.
- **Groups/aliases.** Classifier `Topic :: …` tails and comma-separated keywords are normalized
  with the shared topic slugger. Every GitHub URL in `project_urls` (Repository, Issues,
  Changelog, …) is parsed with the npm URL helper, deduplicated, and emitted as
  `relation=package_of`, confidence `0.9`, evidence `pypi.project_urls`; the first one is also
  stored as `metadata.repository`. Alias persistence shipped in task 5.5; `item_topics` remains in
  task 5.6.
- **Contract extension (additive).** `FetchJsonOptions.responseType?: 'json' | 'text'` lets the
  RSS fetcher read XML through the same retry/bucket/allowlist path; the default remains JSON.
  The adapter uses the primary `pypi:json` bucket for RSS/project JSON and the separate
  `pypi:stats` bucket for pypistats.
- **Rate limit.** `pypi:stats` is capacity 1 / **0.5 req/s** (one request per two seconds; the
  live response advertises `X-RateLimit-Limit: 60` per minute, so the bucket stays at half the
  observed ceiling). Discovery's recent calls are additionally cached 24 h per process; overall is
  not cached because the 11:00 retry is deliberately a second call when the 05:00 response was
  incomplete. The live capture confirms pypistats had published the previous day by **04:41Z**, so
  the 05:00 UTC daily is suitably placed.
- **Schedules.** `pypi-discover` `*/30 * * * *` (`maxItems=1000`), `pypi-daily` `0 5 * * *`,
  `pypi-daily-retry` `0 11 * * *` (§7.2/§7.3.3).
- **Fixtures.** `RECORD=1 pnpm fixtures:record --source pypi` captured both RSS feeds (40 newest /
  100 updates), `mcp` project JSON trimmed to consumed fields, the 195-point overall series, the
  recent payload, and `meta.json` with ETag/CDN evidence. No credentials; the token/header scan
  covers every fixture file.
- **Deferred.** Alias persistence + `item_topics`, discover→backfill fan-out, and a dedicated
  weekly metadata cadence for tracked projects that are neither seeds nor currently in RSS (the
  daily seed sweep refreshes the seed list; a manual refresh/snapshot still works).
  `PYPI_MIN_WEEKLY_DOWNLOADS` and `TRACKED_MAX_PYPI` are read at boot but the tracked-set cap
  enforcement remains the shared open task. A cross-process discovery lock is also deferred:
  `nextSeedAt` is per worker process, so a seed sweep that overruns the 30-minute slot (observed
  under pypistats 429s) can overlap the next scheduled run.
- Acceptance coverage: unit — PEP 503/URLs/date windows, RSS keyword filtering, one-item XML,
  seed admission, new-project admission without pypistats, recent/overall request shapes,
  ETag/304/404, daily partial and missing-series handling, 60-row backfill, fixture normalization
  and the no-secret scan; core — text response parsing and the `pypi:stats` 2 s bucket spec.

### Task 5.2 live acceptance (2026-10-20)

- **Egress fix first.** The pre-fix worker could reach the host but Node `fetch` timed out on the
  Docker NAT64 AAAA address; the rebuilt image now carries
  `NODE_OPTIONS=--dns-result-order=ipv4first --no-network-family-autoselection` in the runtime
  stage (see Environment quirks). Both `pypi.org/rss/packages.xml` and
  `pypistats.org/api/packages/mcp/recent` return 200 from inside the worker after the rebuild.
- **Discovery (`pypi.discover.new-hot.2026-10-20T05-40`, run 136).** 10 items seen, 10 upserted,
  0 failed, 13 API calls, 12.0 s. Inventory went 54 → 58 PyPI items; the upserted rows carry
  `language=python`, `primary_metric=downloads`, canonical names and metadata such as
  `repository=kornia/kornia`, `version=0.8.3` (live rows `kornia`, `ultralytics`, …).
- **Daily (`pypi.daily.2026-10-20`, run 137).** 70 items seen/upserted, 71 API calls, 0 failed,
  `succeeded` in 5 m 38 s. `mcp` and `fastmcp` gained three rows each
  (`2026-10-17..2026-10-19`); items that already had the seeded 61-row history kept it. No
  `dailyIncomplete` items, so the 11:00 retry is not needed for this run.
- **Backfill (`backfill.pypi.4645.2026-10-20`, run 139).** `mcp` (item 4645), one API call,
  2.6 s, `succeeded`; the stored series is exactly 60 rows `2026-08-21..2026-10-19`
  (483,274,384 downloads summed over the window).
- **First seed sweep** (`repeat:pypi-discover:1792474200000`, run 134). 315 items seen and
  upserted, 0 failed, 640 API calls, `succeeded` in 21 m 48 s (05:40:48–06:02:36); PyPI inventory
  reached 319 items. pypistats occasionally answered 429 under the combined seed+daily load;
  `fetchJson` pauses the shared `pypi:stats` bucket on the response headers and retries, and the
  per-item failures did not abort the sweep. The 06:00 scheduled run overlapped because the 05:30
  sweep was still going (`nextSeedAt` is per process); see the deferred lock note above. The 05:00
  scheduled daily failures were the pre-fix IPv6 timeouts only; the post-fix manual daily above is
  the acceptance run.

### Task 5.3 notes

- **Adapter surface.** `packages/sources/src/huggingface` implements list discovery through
  `/api/models`, `/api/datasets` and `/api/spaces`, `Link: <…>; rel="next"` cursor pagination,
  per-kind `expand[]` sets, list-payload-as-snapshot, one detail fallback per uncovered item,
  `arxiv:` tag aliases, and an in-process one-hour list coverage cache. A list page already carries
  `likes`, `downloadsAllTime`, `trendingScore`, `createdAt`, tags and the kind-specific metadata, so
  discovery normalizes and persists the snapshot without an extra request; `fetchMetrics` reuses
  that payload for the same hour and calls `/api/{kind}/{repo_id}` only when the item was not in a
  list page (or after a restart). Detail 404s become `notFound`; 304s use the normal continuity
  path.
- **Per-kind fields (probed live).** Models accept
  `likes,downloads,downloadsAllTime,trendingScore,createdAt,pipeline_tag,tags,library_name,gated,disabled`.
  Datasets accept the same plus `description`; spaces accept only
  `likes,trendingScore,createdAt,tags,sdk,disabled` and reject `downloads`, `gated` and
  `description`. Spaces therefore never emit `downloads_total`, and no synthetic download value is
  invented. The recorded list `Link` uses `expand=` (not `expand[]`) in its cursor URL; both forms
  are accepted, so the parser follows the header verbatim.
- **Bigint gauge caveat (live failure fixed).** Hub `trendingScore` is fractional (the recorded
  fixture has `1.5`; live trending pages included `14.4`), but §5.2 defines `snapshots.value` as
  `bigint`. Passing the raw float made Postgres reject an entire 100-item page with
  `invalid input syntax for type bigint: "14.4"`. The adapter now rounds `trending_score` to the
  nearest integer before building the snapshot; likes and `downloadsAllTime` are already integers.
- **Rolling downloads (GAP-5 resolved, observed live).** HF `downloads` is a rolling ~30-day count,
  while `downloadsAllTime` is cumulative. On 2026-10-20 `google-bert/bert-base-uncased` returned
  `30,160,565` vs `3,267,215,234`, and `fka/prompts.chat` `27,814` vs `723,968`. Only
  `downloadsAllTime` becomes the `downloads_total` snapshot; `downloads` is carried by the new
  additive `NormalizedItem.latestMetrics` / `ItemUpsert.latestMetrics` channel and merged into
  `items.latest_metrics` without touching `snapshots` (ADR-0014). `likes` and `trendingScore` are
  ordinary snapshots; spaces have neither download field.
- **Discovery budget and scheduling.** The hourly `trending` strategy is five 100-item trending
  pages plus two 100-item newest pages filtered by `likes ≥ 5` (700 model items), with a hard job cap
  of 1,100 so the optional two-page dataset and space phases are not starved when enabled. Datasets
  and spaces use `sort=trendingScore` and sit behind
  `HF_INCLUDE_DATASETS`/`HF_INCLUDE_SPACES`. The adapter also implements the §7.3.4 daily top-1,000-by-likes sweep as
  `strategy=likes`, but §7.2 has no scheduler row for it; it is available through a manual discover
  job and remains unscheduled (ADR-0014). The §7.2 rows are `hf-discover` `0 * * * *`,
  `hf-snapshot-hot` `10 * * * *`, `hf-snapshot-warm` `40 */6 * * *`, `hf-snapshot-cold`
  `45 2 * * *`; snapshot rows use the generic fan-out so the detail fallback gets the documented
  concurrency 4.
- **Rate limits.** Anonymous Hub responses advertise
  `RateLimit-Policy: "fixed window";"api";q=500;w=300` and `RateLimit: "api";r=…;t=…`. `fetchJson`
  gained an optional `rateLimitDelayMs` hook; HF parses `t` seconds and pauses the shared
  `huggingface:api` bucket instead of falling back to 60 s (`Retry-After` is absent). `HF_RATE_PER_5MIN`
  remains the authenticated budget (default 1,000), but the worker caps it at the observed anonymous
  500/5 min when `HF_TOKEN` is empty (`effectiveHfRatePer5Min`).
- **Fixtures.** `RECORD=1 pnpm fixtures:record --source huggingface` captured a two-item trending
  model page (including the live `Link` cursor), the `bert-base-uncased` detail (including
  `arxiv:1810.04805` and `license:apache-2.0`), one trending dataset and one trending space, plus
  `meta.json` with the observed `RateLimit`/`RateLimit-Policy`, cursor and field evidence. The
  recorder trims dataset descriptions to 1,000 characters and redacts token-shaped strings.
- **Deferred.** `TRACKED_MAX_HUGGINGFACE` enforcement (shared cap-check task) and a §7.2 row for
  the daily likes sweep; `item_topics` persistence shipped in task 5.6 and alias persistence in
  task 5.5. The list cache is
  process-local by design; a worker restart between discovery and snapshot is correct but turns
  cached items into detail calls.
- Acceptance coverage: unit — fixture normalization for model/dataset/space, list-as-snapshot,
  `Link` pagination with `maxItems`, newest admission, optional dataset/space phases, likes
  strategy, detail/404 and 304 paths, bearer-token header, 429 `t=` pause + `onRateLimit`, and
  actual fixture cursor parsing. Int (real Postgres) — `latest_metrics` merge preserves values
  across metadata-only upserts and the ingest processor writes an HF-style latest-only download
  without creating a download snapshot. Core — the `rateLimitDelayMs` override and its 42 s pause.

### Task 5.3 live acceptance (2026-10-20)

- **Worker.** Rebuilt from the task branch (`docker compose build worker`, recreated with
  `up -d --no-deps --wait worker`); startup logs show `huggingface adapter registered` with
  `includeDatasets: false, includeSpaces: false`, followed by the four HF scheduler ids. No
  `HF_TOKEN` is configured.
- **Discovery (`huggingface.discover.trending.2026-10-20T07-20`, run 176).** Manual
  `POST /v1/admin/ingest {source:"huggingface",type:"discover",strategy:"trending",maxItems:700}`:
  500 items seen, 500 upserted, 0 failed, 7 API calls, 5.0 s. The five trending pages supplied all
  500 models. Both newest pages were fetched but every candidate had `likes: 0`, so the §7.3.4
  `likes ≥ 5` filter admitted none; the result is 500, not 700. HF inventory went from 26 to 526.
- **Warm snapshot (`…snapshot-fanout.warm…`, run 177 → child run 178).** 490 warm items seen and
  upserted, **0 API calls**, 3.8 s. The child reused the discovery process's in-hour list cache for
  all 490 models instead of issuing 490 detail calls. The automatic score run (179) then completed
  1,578 items in 0.4 s.
- **Detail fallback + bigint gauge (`refresh.huggingface.124...`, run 181).** `facebook/bart-large-mnli`
  (item 124) refreshed with 1 API call in 1.1 s; the live detail returned `trendingScore: 0.5`,
  which persisted as `trending_score = 1` (nearest bigint) instead of failing. The same refresh
  wrote `downloads_total = 164,843,490` and `latest_metrics.downloads = 2,461,524`.
- **Coverage after the run.** All 526 HF items have a `latest_metrics.downloads` value; the first
  failed pre-fix discovery exposed the fractional-gauge problem, and the post-fix runs have no
  snapshot errors. Live anonymous response headers were `RateLimit: "api";r=499;t=205` and
  `RateLimit-Policy: "fixed window";"api";q=500;w=300`; no 429 was needed during the small run.
- **Manual hot retry.** A manual hot fan-out after 07:10 completed its fan-out but its child job id
  was the failed hourly child (`huggingface.snapshot.hot.2026-10-20T07.0`), so BullMQ deduplicated
  it instead of rerunning. This is the documented hourly job-id idempotency; use `refresh-item`, wait
  for the next hourly slot, or replay the DLQ job when a failed child must be retried immediately.

### Task 5.4 notes

- **Adapter surface.** `packages/sources/src/arxiv` implements Atom 1.0 discovery, canonical
  version-stripped ids, the four §7.3.5 categories (`cs.AI`, `cs.CL`, `cs.LG`, `cs.CV`), a
  200-item page loop that stops at `published < now − 3 days`, a defensive 3,000-item/15-page cap,
  and a non-retryable error for the API's single-entry `<title>Error</title>` feed. Discovery is
  daily at `03:00` UTC; the hot snapshot is hourly at `:20` UTC. Both schedule rows are registered
  under `ingest-arxiv` and are visible in the BullMQ repeat keys at worker boot.
- **Politeness.** Every Atom request is wrapped in `lock:arxiv:conn` (`SET NX PX 30000`) and uses the
  existing `rl:arxiv:api` bucket (capacity 1, refill one per 3 s). The lock is released only when the
  caller's random token still matches, in a `finally` block. `fetchJson` is called with
  `maxAttempts: 1` inside the lock so a bucket wait plus the request timeout stays under the 30 s
  TTL; BullMQ retries the whole job after releasing the mutex. The lock is shared through Redis, so
  additional workers cannot create a second in-flight arXiv connection. A fake-timer unit test
  proves three sequential requests advance the clock by at least 6 s.
- **HF enrichment.** Each snapshot job first reads the HF daily-paper feed for today and yesterday
  (`limit=100`; `limit=1000` returns HTTP 400) and caches both maps in-process for one hour. Tracked
  papers absent from both feeds fall back to `GET /api/papers/{id}`, charged to the shared
  `rl:huggingface:api` bucket. A `404` means the paper is simply absent from HF: the ref is omitted
  from `fetchMetrics` rather than written as an item or marked failed/deleted. Fallback calls are
  capped at 300 per UTC hour by default. When the cap is reached the ref is returned as
  `notModified`, so the processor writes continuity rows from the last stored upvotes rather than a
  false zero; this is an additive use of the existing continuity path, not a second upstream state.
  Known HF 404s are cached in-process for 24 hours so they do not consume the fallback budget on
  every hourly pass. The cap and caches are process-local because the adapter has no dedicated
  Redis counter (same limitation as other in-process caches); a single ingest worker matches the
  §7.3.5 budget, and this must be revisited if ingest is scaled horizontally.
- **Normalization.** Paper `url` is always the canonical `https://arxiv.org/abs/{id}` page. Metadata
  keeps the authors, primary category, full category list, full abstract, comment/DOI/journal-ref,
  and the abstract/PDF URLs; the PDF is never downloaded or served. Topics map
  `cs.AI → ai`, `cs.CL → nlp`, `cs.CV → computer-vision`, `cs.LG → machine-learning`; other category
  terms become normalized slugs. The primary metric is `upvotes`; no arXiv `stars` scoring entry
  exists (`paramsFor('arxiv', 'stars', …)` throws). HF `githubRepo` becomes a `paper_code` GitHub
  alias with confidence `0.9` and evidence `hf.paper.githubRepo`.
- **Fixtures.** A live 3-entry Atom page and the live error feed were recorded under
  `packages/sources/src/arxiv/__fixtures__` (multi-category entry `2610.26860`, versions, links,
  authors, comments). The live HF daily feed (2 papers) and `2610.22471` paper detail provide the
  upvotes/GitHub-repo fixture; `2610.22471` had `upvotes: 419`, `githubStars: 151` and
  `githubRepo: https://github.com/OpenSenseNova/SenseNova-RoboRSI` on 2026-10-20.
- **Deferred.** The arXiv cap-check is shared with the tracked-limit task; `item_topics`
  persistence shipped in task 5.6 and alias persistence in task 5.5. The error-feed parser is
  exercised through a 200 response in
  unit tests; live arXiv error feeds currently arrive as HTTP 400, which `fetchJson` already turns
  into a non-retryable `UpstreamError` before the parser sees the body.
- Acceptance coverage: unit — Atom fixture parsing, version dedupe, multi-category order, error-feed
  rejection, empty page, 3-request fake-timer spacing, cutoff/maxItems, unsupported strategy,
  Redis mutex acquire/release/error paths, Atom normalization, HF daily/detail/404/budget/cache
  paths, and the `paper_code` alias. Live — documented below.

### Task 5.4 live acceptance (2026-10-20)

- **Worker.** Rebuilt and recreated on the compose stack. Startup logged
  `arxiv adapter registered` and the scheduler ids `arxiv-discover` (`0 3 * * *`) and
  `arxiv-snapshot` (`20 * * * *`) under `ingest-arxiv`; the BullMQ repeat keys are present. No
  `HF_TOKEN` is configured, so the HF enrichment used the anonymous budget. Local acceptance used a
  temporary compose override mapping Redis to `127.0.0.1:16379` because the unrelated
  `smriti-redis-test` container already owns host port 6379; the in-network `redis:6379` URL was
  unchanged and no compose file was modified.
- **Discovery (`arxiv.discover.new-listings.2026-10-20T14-00`, run 209).** Manual
  `POST /v1/admin/ingest {source:"arxiv",type:"discover",strategy:"new-listings",maxItems:400}`:
  400 items seen, 400 upserted, 0 failed, 2 API calls, 10.6 s (two 200-item pages, including the
  3 s bucket spacing). The first page immediately produced canonical items such as
  `2610.26863` → `https://arxiv.org/abs/2610.26863` with `cs.LG`, 8 authors, the full abstract,
  and the PDF URL only in metadata. arXiv inventory rose from the 26 seeded rows to 426; the
  scheduled cap is 3,000 (15 pages), so the full three-day window still needs a production-timed run.
- **Hot snapshot (`arxiv.snapshot-fanout.hot.2026-10-20T14-00`, fan-out run 214 → child run 215).**
  Three discovered items were promoted to `hot` for the acceptance (`2610.26863`, `2610.26802`,
  `2610.26825`). The child saw and upserted 3/3, 0 failed, 2 HF daily-feed API calls, 3.1 s, and 0
  detail calls: all three were in the live 2026-10-20 daily feed. Snapshots captured
  `upvotes = 2`, `128`, `97` respectively at the 14:00 bucket. `2610.26825` persisted
  `homepage` (the HF project page), `metadata.githubRepo = https://github.com/MemTensor/MemT-1.0`,
  and `metadata.githubStars = 146`; its normalized `paper_code` GitHub alias is now persisted by
  task 5.5's generic alias path. The daily feed was cached in the process, so a second snapshot in
  the same hour would add no HF calls.
- **HF 404 (`refresh.arxiv.151.2026-10-20`, run 217).** Refreshing seeded item 151
  (`2604.10000`, absent from HF) completed `succeeded` with 1 item seen, 0 upserted, 0 failed,
  0 not-modified, and 1 HF detail call in 2.1 s. The 404 ref was omitted exactly as required: the
  item stayed tracked and untouched rather than becoming a failure or a deleted item.
- **Politeness evidence.** Redis retained `rl:arxiv:api` state and no `lock:arxiv:conn` after the
  runs (the mutex releases in `finally`); discovery took 10.6 s for two pages, consistent with the
  3 s spacing. The full 300-detail/h fallback cap and the 3,000-item scheduled discovery were not
  forced in live acceptance; both are covered by unit tests and the scheduled cap.

### Task 5.5 notes

- **Adapter surface.** `packages/sources/src/mcp` implements the §7.3.6 registry walk, the
  GitHub-topic/npm-keyword fallback, normalization, and the Redis cursor. List calls use `/v0.1`
  with a single fallback to `/v0` on the first page's 404; detail URLs are
  `/v0.1/servers/{encoded-name}/versions/latest`. Every page sends `version=latest` and
  `include_deleted=true`. A `$schema` mismatch logs a warning and continues rather than failing
  the run.
- **Cursor and bounds.** Incremental runs pass `updated_since` from `mcp:registry:cursor_ts` and
  store the maximum `updatedAt` only after a complete walk. `strategy=full` ignores the cursor and
  advances it only on completion. The defensive bound is 50,000 items / 500 pages: live discovery
  proved the registry is already larger than the original 10,000/100 bound. A truncated pass logs
  the bound and leaves the cursor unchanged.
- **Fallback dedupe.** GitHub search uses `topic:mcp-server` and `topic:mcp stars:>=5` with the
  shared search bucket; npm uses `keywords:mcp-server` and `keywords:mcp`. Hits below 5 stars or 50
  weekly downloads are dropped. The adapter collects the fallback batch, asks the worker
  `filterLinkedAliasTargets`, and only then emits refs, so a repository/package already represented
  by a registry item does not become a second MCP item.
- **Alias persistence.** `persistAliases` is now in the generic worker upsert path, so every source
  can persist its `NormalizedItem.aliases` (task 5.6 adds `item_topics`). Alias targets are created
  as minimal **warm** rows without the `stub` flag, exactly so their own source adapters will
  snapshot them; existing `cold`/`archived` targets are promoted to warm. Deleted targets are
  skipped. This is how registry servers acquire GitHub stars and npm/PyPI downloads.
- **Derived snapshots.** `apps/worker/src/ingestion/mcp-derived.ts` reads the MCP item's alias
  targets from Postgres: the largest GitHub `latest_metrics.stars` and the best npm/PyPI
  `latest_metrics.downloads`, plus the chosen package's daily download series. The processor injects
  these queries into `AdapterContext.loadDerivedMetrics`; `fetchMetrics` makes no registry call.
  MCP snapshots persist with `preserveMetadata` and the expanded identity preservation, so a
  metrics-only payload does not blank the discovery title/description/url/name.
- **Deletes and schedules.** Registry `status=deleted` sets `NormalizedItem.deleted`, persisted as
  `is_deleted=true`; the upsert ORs the flag so an active payload never resurrects a deleted row.
  The §7.2 rows are `mcp-discover` (`0 */2 * * *`), `mcp-discover-full` (`30 0 * * 0`),
  `mcp-discover-gh-npm` (`50 */6 * * *`), and `mcp-snapshot` (`25 * * * *`). An additive
  `mcp-snapshot-warm` (`35 */6 * * *`) is required because new registry items start warm and would
  otherwise never receive derived metrics (ADR-0015).
- **Fixtures.** `packages/sources/src/mcp/__fixtures__` contains four live registry entries
  (GitHub+npm, npm-only, remote-only, and a `status=deleted` entry), a live GitHub search page, a
  live npm search page, and the observed registry schema/cursor metadata. The schema URL is pinned
  to `2025-12-11/server.schema.json`.
- **Deferred.** Any alias-confidence updates remain deferred; `item_topics` persistence is now
  implemented by the shared upsert in task 5.6. The inactive registry `search` query is not used;
  discovery relies on cursor paging. The 50k/500-page bound and the warm snapshot row are documented
  in ADR-0015.
- Acceptance coverage: unit — registry normalization (GitHub/npm/remote/deleted), GitHub and npm
  fallback normalization/admission, cursor pagination and watermark rules, v0.1→v0 fallback,
  truncation, fallback filtering, no-token npm-only fallback, derived snapshot/backfill paths, and
  the five scheduler rows; integration — alias target creation/promotion, derived stars/downloads,
  metadata preservation, linked-target filtering, and sticky deletes. Live evidence is below.

### Task 5.5 live acceptance (2026-10-20)

- **Full registry sync.** The earlier 10k-bound passes stopped at exactly 100 pages and correctly
  left the cursor unset. After raising the bound to 50k/500 pages, run 295 completed with
  **48,379 seen / 48,379 upserted / 0 failed / 484 list calls**, and set
  `mcp:registry:cursor_ts=2026-10-20T17:48:12.344Z`. Postgres then held 48,400 MCP rows including
  1,324 deleted (48,379 registry servers plus the fallback rows).
- **Incremental pass.** Run 296 used the stored cursor: **6 seen / 6 upserted / 1 list call** and
  advanced the cursor to `2026-10-20T17:51:56.581Z`. A run without `updated_since` would have
  repeated the full 48k walk, so this is direct evidence the watermark was sent.
- **Derived metrics, no upstream calls.** Run 297 refreshed GitHub target 94143
  (`asklokesh/loki-mode`, created as an alias stub) to 1,100 stars. Run 298 then refreshed registry
  item 93995 (`io.github.asklokesh/loki-mode`) with **1 item / 0 API calls**: latest metrics became
  `{stars: 1100, downloads: 3127}`, the `stars` snapshot was 1,100 at 17:00Z, and the daily
  `downloads` rows were 3,127 (2026-10-18) and 9,484 (2026-10-17). The item kept its discovery
  `name`, `display_name`, registry `url`, and `primary_metric=stars`.
- **Alias targets and deletes.** Before the fallback pass, 48,632 registry MCP→target aliases all
  pointed at `warm`/`hot` targets (zero cold), confirming warm creation/promotion. Sampled deleted
  registry rows have
  `is_deleted=true`, `is_archived=true`, `metadata.registryStatus=deleted`, and no aliases.
- **Fallback discovery.** Run 300 (`strategy=github-npm`) completed with **782 seen / 782 upserted /
  0 failed / 11 search calls**, creating 717 `github:{owner/name}` and 67 `npm:{pkg}` items. Every
  created fallback item is warm and has its alias; a join found **zero** fallback items sharing a
  target with a registry owner, so the linked-target filter excluded the already-represented hits.
- **Schema drift.** The full pass logged one warning for older entries carrying
  `2025-09-29/server.schema.json` while the pinned expectation is `2025-12-11`; all 48,379 entries
  still normalized with zero failures, which is the intended warn-and-continue behavior.

### Task 5.6 notes

- **Shared alias resolver.** All six adapters emit `NormalizedItem.aliases`, and every source now
  goes through the same worker `persistAliases` path. It creates warm stub targets for unseen
  aliases, promotes existing `cold`/`archived` targets, skips self-links and deleted targets, and
  relies on the `(item_id, alias_item_id, relation)` unique index to dedupe repeated aliases. The
  new `apps/worker/test/int/aliases.int.test.ts` covers all six §5.4 relation values in one
  transaction and asserts the resulting warm stubs; the MCP integration test still covers
  promotion and sticky deletes.
- **API surfacing.** `GET /v1/items/:id/aliases` and the item-detail `aliases` array were already
  implemented in task 3.3 (`loadItemAliasLinks` returns outgoing and incoming rows with the row's
  own relation, confidence, evidence and direction). Task 5.6 adds no route or schema changes;
  the existing real-Postgres test continues to assert both directions and the public ETag path.
- **Topic persistence.** The generic upsert now writes `topics` and `item_topics` alongside items.
  Slugs are normalized again at the persistence boundary with `normalizeTopicSlugs` (dedupe,
  synonym folding, invalid-slug rejection, 20-topic cap). Links are additive: a later payload that
  omits a topic does not delete an earlier observation. `topics.item_count` is recomputed only for
  the touched topics. This closes the `item_topics` deferrals recorded in the adapter notes. The
  additive semantics and count maintenance are recorded in ADR-0016.
- **Contract project.** `packages/sources/test/contract` contains one file per source
  (`github`, `npm`, `pypi`, `huggingface`, `arxiv`, `mcp`) with 13 probes total. They validate real
  responses against the adapters' Zod schemas: GitHub REST search/repo, one GraphQL batch and the
  stargazer count/history endpoints; npm search, packument, point, single range and bulk downloads;
  both PyPI RSS feeds plus project JSON, overall and recent stats; HF model/dataset/space lists and
  model detail; the arXiv Atom export plus HF daily-paper and paper-detail payloads; and MCP
  `/v0.1` list/detail plus the `/v0` fallback list. The helper retries only 429/5xx, times out at
  30 s, and never logs query strings or tokens.
- **Contract gating and CI.** The root Vitest config has a separate `contract` project, so
  `pnpm test` and `pnpm test:int` never touch the network. `CONTRACT=1` is checked by the test
  helper; without it all 13 probes are reported skipped. `pnpm --filter sources test:contract`
  selects only that project. The nightly `contract` CI job runs it with `GITHUB_TOKENS` and
  `HF_TOKEN` secrets and, on failure, opens or comments on a single `Nightly contract tests failed`
  issue. A missing GitHub token is a hard failure, not a silent skip.
- **Local contract acceptance (2026-10-21).** `CONTRACT=1 pnpm --filter sources test:contract`
  passed **6 files / 13 tests in 70.6 s** with the local tokens supplied through the shell. All
  probes returned valid payloads; no schema drift was observed. The registry probes returned 200
  for both `/v0.1` and `/v0`, and the detail response validated as `{server, _meta}`. Without
  `CONTRACT=1`, the same command reports 6 files / 13 tests skipped.


## Phase 6 notes

- **Task 6.1 / Docker-network acceptance.** The home page was loaded through the compose network
  (`http://localhost:3000/`) and rendered the seeded combined board plus the source spotlights. The
  web image is a pure API client; no database package is imported at runtime.
- **Tailwind/shadcn foundation.** Tailwind v4 lives in `apps/web/src/app/globals.css`; the local
  `components/ui/*` primitives follow the shadcn structure (CVA + Radix + `cn`) without adding the
  shadcn CLI as a runtime dependency. `next-themes` drives the dark default; the palette follows
  `docs/mockups/home-final.html`. The API wire schemas are mirrored in `apps/web/src/lib/schemas.ts`
  and every fetch is parsed with Zod at the boundary.
- **Runtime-import constraint.** `@trendr/core` exports server-only helpers (Redis, Lua file reads);
  importing its runtime barrel from a client component broke the Next build. Web code therefore
  uses `import type` from core only and mirrors the small runtime enums locally. This is a build
  boundary, not a contract change: local schemas are checked against the API in the smoke test.
- **Task 6.2.** `/trending/[scope]/[window]` and the `/trending/[scope]` alias are URL-state driven
  (`window`, `lang`, `topic`, `kind`, `new`). `LiveLeaderboard` uses SWR plus SSE, exponential
  reconnect and a reduced-motion-aware rank-change animation. The fake-event component test passes
  (1/1) and the URL helper test passes (3/3). `pnpm --filter @trendr/web build` marks every data
  route dynamic instead of prebuilding empty boards.
- **Task 6.3.** The item route fetches detail, a year of daily metric history, 30 days of score
  history for all three windows, the 24h score explanation and aliases. Cumulative metrics render
  an area, daily-count metrics bars plus a 7-day moving average, and gauges a line; the range and
  log controls are client-side. The chart animations are disabled so SSR/hydration and headless
  screenshots show the final series immediately. A wrong slug returns a 308 to the canonical slug.
  Lighthouse SEO on `/item/13/open-webui-open-webui` scored **100** on 2026-10-21 in both the
  local production build and the Docker stack (`localhost:3000`), using Chrome headless and
  Lighthouse 12.8.2.
- **Task 6.4.** Search groups results by source and supports source/kind filters and cursor paging;
  `/new` has source tabs, a window/kind form and a dedicated "New in MCP" strip; `/topics` is an
  additive index and `/topics/[slug]` renders a topic board; `/compare` validates 2–5 IDs, offers a
  client picker, and renders indexed or raw multi-series charts plus a standing table.
  `apps/web/scripts/smoke.mjs` exercises all of these against a running stack
  (`pnpm --filter @trendr/web smoke`); both the local and Docker (`localhost:3000`) runs passed
  9/9 checks.
- **Task 6.5.** Root, item and source OG images use `next/og` and return `image/png`
  (1200×630; the item image includes the 30-day sparkline, delta, percentile and rank). The
  sitemap and robots routes are dynamic, and item/leaderboard/home pages emit schema.org JSON-LD.
  `/item/13/open-webui-open-webui/opengraph-image` returned a valid 88 KB PNG locally.

### Phase 6 deviations

| # | Spec location | Finding | Resolution |
| --- | --- | --- | --- |
| R-13 | §12.1 / task 6.2 | The spec asks for ISR and prebuilt params for data pages; the Docker web image is built before the API exists, so build-time fetches would bake empty boards. | Data routes use `force-dynamic` with API-side Redis caching and 60–300 s fetch hints. `generateStaticParams` was removed from the leaderboard routes. |
| R-14 | §12.4 sitemap | The spec asks for up to 5,000 item URLs. `/v1/trending` caps `limit` at 100, and crawling 50 cursor pages on every sitemap request is wasteful. | The sitemap emits the combined top 100 plus 100 per source (≤700 canonical item URLs), all leaderboard/topic/static routes; search and deep archive remain crawlable through internal links. |
| R-15 | §12.4 OG runtime | The spec labels OG routes "Edge". | `runtime = 'nodejs'`; the routes reuse the server API client (`API_INTERNAL_URL`) and `next/og` produces the same PNG. Tested locally. |
| R-16 | §12.1 `/compare` | The spec calls the page "Client (SWR)". | The page fetches the validated comparison on the server; only the picker, scale toggle and chart are a client island. There is no live SSE contract for comparisons, so SWR would add no behaviour. |
| R-17 | §12.4 item title | The spec's sample title embeds `+{delta} {metric}`. | Titles use the item display name (template `%s · Trendr`) because long names and mixed source metrics make the delta suffix noisy; the delta remains in the OG image and description. |
| R-18 | §12.1 routes | `/topics` (index) and the "New in MCP" section are not listed as separate routes/content. | Additive only; both reuse existing API endpoints and do not change contracts. |
| R-19 | §12.3 Zod gating | The spec says response validation is development-only. | Schemas are parsed on every server fetch. The payloads are small and this catches API drift at the boundary; the browser only receives already-validated data. |

## Phase 7 notes

- **Task 7.1.** `packages/email` centralizes the `EmailSender` boundary (ADR-0017); the API sends
  the `${WEB_PUBLIC_URL}/auth/verify?token=…` link through SMTP to Mailpit in development.
  Magic links are single-use 15-minute rows whose SHA-256 is stored; verification creates an
  unverified user when needed, sets `email_verified_at`/`last_login_at`, synchronizes the role
  from the authoritative `ADMIN_EMAILS` list (promoting or demoting), and returns a 15-minute
  JWT plus a rotating 30-day `dt_refresh` cookie. The same role sync runs on magic-link issuance
  and refresh, so removing an address demotes the stored user before the next refresh; already
  signed access JWTs retain their role until the 15-minute TTL expires. Reusing a consumed
  refresh token revokes the entire family (theft detection), and logout revokes the family.
  The integration suite adds an `axllent/mailpit` Testcontainer (`test/global-setup.ts`) and reads
  the real message through the Mailpit API; `scripts/auth-smoke.mjs` repeats the flow against the
  Compose stack in CI. The web app keeps access tokens in memory only and restores sessions from
  the httpOnly cookie on load.
- **Rate limits.** `/v1/auth/*` has a shared 5 requests/minute per-IP counter
  (`apirl:auth:{ip}`) plus the spec's 3 magic links/hour per email (`apirl:magic:{sha256(email)}`).
  The per-IP key uses the same `clientIp(request, TRUST_PROXY)` helper as the global limiter
  (Cloudflare's `CF-Connecting-IP` only when the proxy is trusted, otherwise the socket peer);
  the magic-link audit IP uses the same derivation. Both counters fail closed with 429 and
  `Retry-After`; the email counter is per normalized address, so unknown addresses are
  indistinguishable.

- **Task 7.2.** `/v1/me|watchlists` implements create/list/rename/delete, item list with
  current 24h/7d summaries, idempotent PUT/DELETE, and the §15 caps (20 lists, 500 items).
  Every route scopes by `user_id`, so another user's watchlist returns 404 rather than leaking
  existence. Adding an item promotes it from cold to warm immediately. The dashboard renders the
  lists, and the item page has a watch button that remembers the current path through sign-in.
  When a signed-in user saves their first item, the API finds no watchlist and the web creates a
  default "My watchlist"; the first list created becomes the default. Integration coverage:
  `apps/api/test/int/watchlists.int.test.ts` (3/3).
- **Task 7.3.** Alert CRUD supports all four §13.1 rules inside the spec's `params` discriminator,
  the 50-rule cap, target ownership checks and 404 IDOR behaviour. `evaluate-alerts` runs after
  each scoring run, evaluates only rows from the run's source, applies cooldowns, and inserts with
  the deterministic `{alertId}:{itemId}:{window}:{epoch-hour bucket}` unique key. A seeded spike
  produces exactly one `alert_events` row after two evaluations and the alert email arrives in
  Mailpit (`apps/worker/test/int/alerts.int.test.ts`, 1/1). More than five events for one user in
  one run share a single `send-alert-email` job carrying `alertEventIds`; smaller groups keep
  one job per event. The dashboard manages rules and shows recent events, while an item page can
  create an item-targeted rule without a watchlist.
- **Task 7.4.** `PUT /v1/me/digest` persists sources, topics, watchlist inclusion, day-of-week and
  enabled/unsubscribed state. The scheduler enqueues `build-weekly-digest` daily at 08:00 UTC;
  it reuses the cached `digest:content:{date}` payload, selects enabled due subscriptions and
  enqueues `send-digest` with `digest.{subId}.{weekStart}`. A `(subscription_id, week_start)`
  unique claim makes a repeated send a no-op; provider failure releases the claim for retry.
  The React Email template includes per-source sections, new MCP servers, papers and "Your
  watchlist this week", with plain text and RFC 8058 headers. `GET /v1/unsubscribe` previews the
  token; `POST` performs the idempotent unsubscribe (the web page uses POST). Integration:
  `apps/worker/test/int/digest.int.test.ts` sends through Mailpit, verifies one `digest_sends`
  row, and skips the second send; `account.int.test.ts` covers preferences and one-click POST.
- **Task 7.5.** `GET/POST/DELETE /v1/me/api-keys` list prefixes, show the full
  `dt_live_…` key exactly once, cap active keys at five, and revoke without deleting the audit
  row. Keys use the core HMAC helper and only the prefix is stored in clear. The settings page
  creates read keys, copies the one-time reveal, lists last use and revokes. Integration coverage
  includes hash verification, the five-key cap, duplicate names, revocation and IDOR
  (`account.int.test.ts`, 4/4 including alert CRUD and digest). The compose CI job creates a
  user through Mailpit, then exercises the watchlist, digest, alert and API-key endpoints and uses
  the revealed key against `/v1/trending` (`scripts/auth-smoke.mjs`).
- **Phase 7 verification (2026-10-22).** `pnpm lint`, `pnpm typecheck`, `pnpm build` and
  `pnpm test` pass (523 unit tests); `pnpm test:int` passes all 137 integration tests across 28
  files; the opt-in contract suite exits 0 with its 13 live probes skipped; the OpenAPI export
  contains 43 paths; and the full Compose stack is healthy with `readyz` returning
  `{db: ok, redis: ok, migrations: ok}`. `scripts/auth-smoke.mjs` then passed against Compose for
  magic-link login, refresh rotation/logout, watchlist, digest, alert CRUD, API-key
  create/list/revoke and API-key authentication. The first image build hit transient npm registry
  `ETIMEDOUT`s while fetching deploy-only dependencies and succeeded on retry; no application
  failure was involved.

### Phase 7 deviations

| # | Spec location | Finding | Resolution |
| --- | --- | --- | --- |
| R-20 | §10.5 cookie flags | The spec requires `Secure` on `dt_refresh`. A browser on `http://localhost:3000` (the documented local origin, API on `:4000`) may reject a Secure cookie, which would make local sign-in untestable. | `cookieSecure` follows `NODE_ENV === 'production'`; production always sends `Secure`, local http sends it without. `HttpOnly`, `SameSite=Lax` and `Path=/v1/auth` are unconditional. |
| R-21 | §13.3 | `EmailSender` is specified under `apps/worker/src/notify/email.ts`, but the API also needs it for magic links. | Moved to shared `packages/email` with no domain-layer dependency (ADR-0017); worker alerts/digests will reuse it. |
| R-22 | §10.5 / §18 task 7.1 | The spec's 30-day refresh lifetime is fixed; `REFRESH_TTL_DAYS` already exists in the typed env schema. | The service and cookie use `REFRESH_TTL_DAYS` with a 30-day default, so tests can shorten it without changing the wire contract. |
| R-23 | §10.5 optional Turnstile | `TURNSTILE_SECRET` is declared but Turnstile is explicitly optional and not part of task 7.1's acceptance gate. | Deferred to the Phase 9 security checklist; magic links still have per-email and per-IP limits plus generic 202 responses. |
| R-24 | §12.1 dashboard | The spec does not define what the dashboard does when a user saves an item before creating a list. | The API stays strict (the watchlist id must exist); the web creates a default "My watchlist" on the first save. The first list created by any client becomes the default. |
| R-25 | §13.1 batching | The spec names one `send-alert-email` job per event but also requires a combined email after five events. | `NotifyJobSchema.send-alert-email` accepts an optional `alertEventIds[]`; batched jobs reuse the first event's `alert.{eventId}` id and single-event jobs keep the original shape. |
| R-26 | §13.1 `rank_entered` | The spec reads `lb:{scope}:{window}:{lang}` but Phase 6 publishes only the all-language boards. | The evaluator reads the `_all` board and applies `lang`/`topic` filters in memory. A language-specific board can be added later without changing the API or rule shape. |
| R-27 | §13.1 `rank_entered` | `prevRank` is not persisted on a Redis board after the atomic swap. | `publishBoard` copies the pre-swap ZSET to `lbprev:{scope}:{window}:{lang}:{runId}` (48 h TTL) before publishing; the evaluator reads that snapshot. A repeated scoring attempt reuses the existing snapshot so retries compare against the same board. |
| R-28 | §13.1 threshold rules | The spec describes a previous-run comparison using `latest_metrics`. | The evaluator compares the two most recent snapshots for the configured metric. This uses the same metric stream as `latest_metrics`, tolerates missed scoring runs, and records both `previousValue` and `currentValue` in the event payload. |
| R-29 | §13.1 `new_alias` | The spec does not define the lookback when a rule has never fired. | The evaluator uses `last_triggered_at`, or the rule's `created_at` before the first firing, and caps the event payload at ten aliases. |
| R-30 | §13.2 digest content | The spec builds content from Redis leaderboards; the API/worker already have a canonical SQL current-run path, and per-source boards can be absent outside published scopes. | Content is read from `scores` joined to `score_runs_current` (the same rows and rank columns that produce the boards) with the spec's limits: 10/source, 5/all, 5 new MCP, 5 papers. This avoids a second ranking implementation and lets the digest run without a live Redis board copy. |
| R-31 | §13.2 scheduler payload | The `build-weekly-digest` job is scheduled without a `weekStart`; the spec's processor input is not shown. | `weekStart` is optional for the build job only; the worker computes the current UTC Monday and passes the explicit value to every `send-digest` child. |
| R-32 | §10.4 API keys | The spec's create body has `name` and `expiresInDays` but the table also has `scopes` and `rate_limit_per_min`. | User-created keys are read-only and use the 120/min default. Admin-scope keys remain seeded/operator-managed, so a normal account cannot mint its own admin credential. `expiresInDays` is converted to `expires_at` server-side. |

## Phase 8 notes

- **Task 8.1.** `apps/mcp` now builds a real `McpServer` with stdio and stateless Streamable HTTP
  transports. `POST /mcp` creates a per-request server/transport pair; `GET`/`DELETE` return 405,
  and `GET /healthz` feeds the Compose healthcheck. `ApiClient` is an interface with a typed
  `HttpApiClient` implementation, RFC 7807 error mapping, response-schema validation, a 15 s
  timeout, optional `X-API-Key` forwarding, and manual 302 handling for `/v1/items/lookup`.
  `@trendr/config/mcp` validates only the MCP subset of the env (ADR-0018).
- **Task 8.2.** The five §11 tools (`get_trending`, `search_items`, `get_item_history`,
  `compare_items`, `whats_new_in_mcp`) register input/output schemas and read-only annotations and
  return both structured content and compact Markdown. `whats_new_in_mcp` merges repository URLs
  and npm/PyPI package aliases for the first 15 items; later items remain listed without aliases.
- **Task 8.3.** The README documents Inspector, Claude Desktop stdio and Cursor HTTP configuration.
  `scripts/mcp-smoke.mjs` exercises `initialize` → `tools/list` → `get_trending` over the Compose
  HTTP boundary, and CI runs it after the scoring/trending assertion.
- **Test coverage.** `apps/mcp/test/tools.test.ts` (9), `validation.test.ts` (6),
  `api-client.test.ts` (6) and `http.test.ts` (1) cover every tool, validation failures, RFC 7807
  errors, lookup redirects, output schemas/Markdown, bearer auth and the real HTTP transport. The
  config test suite adds MCP-only env parsing without API/worker secrets.

### Phase 8 deviations

| # | Spec location | Finding | Resolution |
| --- | --- | --- | --- |
| R-33 | §11 / GAP-6 | The spec pins `@modelcontextprotocol/sdk` v1 while SDK v2 is available, and older v1 releases required a Zod v3 compatibility shim. | Pinned `1.32.1`; its peer range accepts Zod 4, so no shim is needed. Recorded in ADR-0018. |
| R-34 | §14 env | `@trendr/config` validates the full API/worker environment at import time, but standalone MCP clients only have MCP + API URL variables. | Added the `@trendr/config/mcp` subpath with all MCP variables plus `API_INTERNAL_URL`; the root export is unchanged for other processes. |
| R-35 | §11.2 | The spec requires Streamable HTTP but does not define session or GET/DELETE behaviour. | HTTP is stateless: a fresh server/transport per POST; GET/DELETE return 405 per the SDK stateless pattern. `/healthz` is additive for Compose. |
| R-36 | §11.1 `get_item_history` | `maxDailyGain` is not defined for the three metric kinds. | cumulative: largest day-over-day increase (hourly rolled up); daily_count: largest daily value; gauge: largest positive point-to-point increase. Empty series returns zeros. |
| R-37 | §11.1 `whats_new_in_mcp` | The API does not expose `registryName` or package metadata on `/v1/new`; aliases are the only source of repo/package links. | Derive `registryName` from the registry URL, use GitHub aliases for `repoUrl`, and npm/PyPI aliases for packages. Alias fetches are best-effort and capped at 15 per call (spec limit); later items keep an empty package list. |
| R-38 | §11.2 auth | The spec only says tools forward `X-API-Key`; HTTP client auth is unspecified. `MCP_API_KEY` is blank in `.env.example`. | `MCP_API_KEY` is optional (anonymous public rate limit when absent); `/mcp` has optional static bearer auth via `MCP_HTTP_AUTH_TOKENS`. Production should set both. |
| R-39 | §11 resources/prompt | §11 lists optional resources and a `weekly_briefing` prompt; task 8.2/8.3 acceptance only requires five tools and README configuration. | Deferred to keep Phase 8 scoped. The tool schemas and server instructions leave room to add them without changing the REST boundary. |
| R-40 | §18 task 8.3 | The spec's Claude Desktop snippet uses `npx @trendr/mcp`, but the workspace package is private and not published. | Added the `trendr-mcp` bin and shebang, but README uses an absolute `node apps/mcp/dist/main.js` path for a checkout and documents `npx` as post-publish only. |

## Phase 9 notes

- **Task 9.1.** Both processes expose a token-guarded `/metrics` built with `prom-client` and the
  `trendr_` prefix. The API owns HTTP, cache, SSE and pool series; the worker owns ingestion,
  upstream-error, rate-limit, queue, job, scoring, freshness, alert, email, snapshot-partition and
  token-expiry series. `Queue.getJobCounts` is polled every 15 s and `items.last_snapshot_at` every
  60 s. `trendr_rate_limit_wait_seconds` is observed around the Redis token bucket's blocked
  `take()`, so the wait histogram is real rather than inferred from retry counts. The API's global
  JWT hook exempts `/metrics`: a scrape bearer is `METRICS_TOKEN`, not an access token, and without
  the exemption Compose (where `jwtSecret` is always set) answered 401 before the route guard ran.
- **Task 9.2.** `infra/prometheus/alerts.yml` implements the six §14.2 rules; CI runs `promtool
  check rules` against the same Prometheus image Compose uses. Prometheus, Grafana and Jaeger
  images are pinned. Prometheus does **not** expand environment variables inside config files
  (governance vote, prometheus/prometheus#2357; `--config.expand-env` is not a Prometheus flag), so
  Compose renders `${METRICS_TOKEN}` with `configs.content` into a read-only
  `/etc/prometheus/metrics.token` that both jobs read through
  `authorization.credentials_file` — the token is still never committed. Grafana provisions the
  **Trendr
  Overview** dashboard (API, ingestion, upstream limits, queues, scoring, cache, email, DB pool and
  runtime panels) from JSON. The Compose `obs` profile starts Prometheus, Grafana and Jaeger;
  `scripts/obs-smoke.mjs` asserts that rules loaded, both scrape targets are `up`, and the
  dashboard is visible.
- **Task 9.3.** API Helmet now emits a deny-all CSP; the web middleware emits a nonce-based CSP that
  Next applies to its scripts. Cookie-authenticated unsafe methods require
  `X-Requested-With: trendr`; the web refresh/logout paths and auth integration tests send it.
  Public `/v1/*` GETs get wildcard CORS without credentials, private prefixes keep the allowlist.
  Request bodies are capped at 64 KB and body schemas are strict. CI keeps gitleaks and
  `pnpm audit --prod --audit-level high`, and an aggregate test walks every source `__fixtures__`
  directory for GitHub/HF/npm/PyPI token shapes and auth headers. ESLint bans `sql.raw`.
- **Task 9.4.** The `maintenance` queue now dispatches `create-partitions`, `rollup-daily`,
  `retention`, `cleanup-tokens` and `retier-items`. Retention drops old snapshot partitions, prunes
  scores to the §6.5 hourly/daily policy, removes alert events after 180 days, and deletes
  unreferenced ingestion runs after 30 days in bounded batches. `maintenance-cli.ts` enqueues the
  real job so a running worker updates `trendr_snapshots_default_rows`; the runbook documents both
  that path and the direct-SQL fallback, score-retention verification, partition checks, token
  rotation and incident checklists.
- **Task 9.5.** OpenTelemetry is optional and deferred (R-41). Jaeger remains provisioned in the
  `obs` profile for a future SDK integration.

### Phase 9 deviations

| # | Spec location | Finding | Resolution |
| --- | --- | --- | --- |
| R-41 | §9.5 / §14.6 | The spec marks OpenTelemetry tracing optional; enabling it means a new SDK, exporter lifecycle, sampling policy and trace-context propagation through BullMQ. | Deferred for Phase 9; no tracing SDK is loaded, Jaeger is available in the `obs` profile. Recorded in ADR-0019. |
| R-42 | §9.3 / §15 | Turnstile is explicitly optional; the existing magic-link endpoint already has per-IP and per-email limits plus a generic 202 response. | Not added. Adding an external challenge would require a new env secret, web widget and fail-open/fail-closed policy; the current rate limits are the active mitigation. |
| R-43 | §14.1 freshness | A literal `max(last_snapshot_at)` over `items` includes soft-deleted and upstream-archived rows, so a healthy tier could stay permanently stale because of a dead project. | `trendr_data_freshness_seconds` excludes `is_deleted` and `is_archived` rows; the alert measures what the scheduler can still refresh. |
| R-44 | §7.10 / 9.4 manual runs | Executing maintenance directly in an operator shell would leave the worker's `trendr_snapshots_default_rows` gauge stale. | `maintenance-cli.ts` enqueues the job onto `maintenance` and waits for the worker result; direct SQL is documented only as an emergency fallback. |
| R-45 | §15 body size | The spec requires a 64 KB cap but does not define the error body. | Fastify's 413 is mapped through the existing RFC 7807 error handler; the cap applies to JSON and URL-encoded bodies globally, including public auth routes. |

## Phase 10 notes

- **Task 10.1.** `docker-compose.prod.yml` builds the one-origin VPS topology: GHCR images, no
  published Postgres/Redis/MCP ports, nginx as the only `80`/`443` listener, Cloudflare origin TLS,
  real-IP handling, SSE-safe proxying, and the one-shot `migrate` service ahead of API/worker.
  `infra/scripts/bootstrap-vps.sh` installs Docker, the deploy user, the firewall and the backup
  timer; `.github/workflows/publish.yml` publishes multi-arch images on `v*` tags or manual
  dispatch. Main-branch publishing stays disabled until the `API_PUBLIC_URL` repository variable
  exists.
- **Task 10.2.** `render.yaml` is the managed alternative. It deploys prebuilt images because a
  Render Blueprint cannot pass `dockerBuildArgs` and the web image bakes `NEXT_PUBLIC_API_URL`.
  Paid API (for `preDeployCommand`), worker, Postgres and Key Value; free web/MCP. Default
  `*.onrender.com` hosts are cross-site (`onrender.com` is on the Public Suffix List), so the
  Blueprint sets `COOKIE_SAME_SITE=none`; moving both services to custom subdomains of one
  registrable domain allows `lax`. The local validation is against Render's published JSON Schema
  (`https://render.com/schema/render.yaml.json`) plus Prettier. **A live Blueprint sync is still
  pending** because no Render account/CLI is available in this environment; that is the remaining
  acceptance item for task 10.2.
- **Task 10.3.** README now includes a Mermaid architecture diagram, copy-paste
  `/v1/trending`, `/v1/items/:id`, `/v1/search` and SSE examples, remote MCP setup, an ADR-0001…0021
  index and the §19.2 interview talking points. The status table shows Phase 10 in progress.
  **Screenshots remain blocked** on a live deployment; k6 and scoring tuning are likewise deferred.
- **Task 10.4.** `infra/k6/trending.js` ramps `/v1/trending` to 200 RPS and enforces p95 < 50 ms,
  error rate < 1%, check rate > 99% and zero dropped iterations. The anonymous tier is 60
  requests/minute per IP, so the run needs a dedicated API key with a temporarily raised
  `rate_limit_per_min` (or a staging instance with the limiter relaxed); `infra/k6/README.md`
  documents both and holds the result template. **The deployed run and recorded p95 are pending**
  the live VPS.
- **GAP-9 resolution and caveats.** Limits were checked against the providers' docs on
  2026-11-02. Free-tier allowances change frequently; re-check before relying on any row.

| Piece | Current free allowance (2026-11-02) | Verdict for Trendr |
| --- | --- | --- |
| Render web | 512 MB, 750 instance-hours/workspace/month, 5 GB bandwidth, 500 pipeline minutes, 15-minute idle spin-down, no private inbound | Demo only; the Blueprint keeps web and MCP free and accepts cold starts |
| Render Postgres | 1 GB, one per workspace, expires 30 days after creation (14-day grace), no backups/pooling | Not durable; the Blueprint uses paid `0.5c-1g` with a 15 GB disk |
| Render Key Value | 25 MB, one per workspace, in-memory, 50 connections, no persistence | Cannot hold BullMQ jobs across a restart; paid `256mb` with `noeviction` + `journal-snapshot` |
| Render worker | None | Scheduler/ingest require the paid `0.5c-512mb` minimum |
| Neon Postgres | 1 GB/project, 20 GB/account, 100 CU-hours/project, 5 GB egress, 5-minute scale-to-zero | The 0.5 GB assumption is conservative, but `daily_metrics` retention is missing (below) |
| Upstash Redis | 250 MB, 500K commands/month, 10 GB bandwidth | BullMQ polling/blocking burns the command quota; cache-only |
| Resend | 3,000 emails/month, 100/day | Sufficient for magic links and a small digest list; the sender domain must be verified |
| Vercel Hobby | Free for non-commercial use; 100 GB fast data transfer, 1M CDN requests/month | Web front end only; no worker or BullMQ |
| Fly.io | No free tier for new organizations; 2-hour/7-day trial; 256 MB Machine ≈ $2.19/month | Viable paid worker host, not a free one |
| Oracle Always Free | Arm Ampere allowance (verify region/capacity) | Capacity is often unavailable and idle resources can be reclaimed |

- **The Neon 0.5 GB budget does not hold as written.** §6.5 assumes `daily_metrics` is held to
  ≈ 90 days, but the maintenance job rolls the table up and never prunes it. At the low-tier caps
  (≈ 12.5k items × 2–3 metrics) the table grows by roughly 0.6–1 GB per year, so a 1 GB Neon
  project would eventually hit the storage cap even with short snapshot/score retention. The 15 GB
  Render disk absorbs this for years at demo size. Before using Neon free long-term, add a
  `daily_metrics` retention job (the 30-day download window needs at least 60 days) and record the
  measured row width; do not rely on the current table-size estimate.
- **Cost.** Render runs about $47/month at these plans (API $7 + worker $7 + Postgres $19 + 15 GB
  disk ≈ $4 + Key Value $10) plus bandwidth overages. The VPS path is about $6–8/month plus a
  domain and backup egress. See ADR-0021 for the full comparison.

## Post-audit maintenance (2026-11)

| # | Finding | Resolution |
| --- | --- | --- |
| R-46 | `pnpm audit --prod --audit-level high` failed on `body-parser@2.3.0` via the MCP SDK's Express dependency (`GHSA-27r3-jxmh-p828`). | `pnpm-workspace.yaml` overrides `body-parser` to `^2.4.0`; Express 5.3.0 accepts the patched release. |
| R-47 | `fast-uri` 3.1.8 and 4.2.2 carried four URI-parsing advisories (`GHSA-w74x-v6f9-j3xg`, `GHSA-wjr9-j795-jxcr`, `GHSA-xhq7-xmqj-769h`, `GHSA-333x-w4r6-6crp`). | Scoped overrides pin the 3.x line to `^3.1.9` and the 4.x line to `^4.2.3`; both lines remain in the dependency graph. |
| R-48 | `@fastify/static@10.1.x` pulls `glob@13`, which depends on vulnerable `minimatch@10` (`GHSA-3g3m-2fjr-6pw4`, `GHSA-g3hv-75wg-m249`). | `glob` is overridden to `^14.0.3`, which pulls `minimatch@11.0.3`; the `/docs`/OpenAPI integration tests still pass. |
| R-49 | `deepmerge@4.3.1` (`GHSA-gcqx-w48m-w2h4`, low) reaches the worker through the email renderer; no `4.3.2` release is published. | Accepted. The dependency is only used while rendering email content, and the advisory has no available fix yet. |
| R-50 | Fixed integration-test anchors start at 2026-08-20, but migrations create only the current month −2/+3 window, so the 2026-11-01 run routed 3,792 seed rows into `snapshots_default` and failed the ISS-7 assertion. | `test/global-setup.ts` now creates partitions from 2026-08-01, and the seed test asserts `snapshots_default` stays empty. Production behaviour is unchanged. |
| R-51 | The 2026-10-29 `compose-smoke` job failed on a transient corepack download during image build. | Both node Dockerfiles retry the pinned pnpm install three times before failing the build. |
| R-52 | H-2: concurrent refreshes with one cookie revoked the whole family and signed every tab out. | A used token replayed within 15 s returns typed `refresh-rotated` 401 with `Retry-After`, without revoking or clearing; outside the window reuse still revokes. Web Locks plus a typed one-shot retry in the client. Deliberate §10.5 deviation; ADR-0022. |
| R-53 | H-3: refresh shared the 5/min sign-in bucket, so routine page loads could 429 and the old client treated that as signed out. | Magic-link/verify/logout keep 5/min; refresh gets 60/min per presented-cookie hash plus a 120/min per-IP guard; anonymous refresh skips the buckets; client uses `trendr.hasSession` and treats 429/5xx as transient. Deliberate §10.5 deviation; ADR-0023. |
| R-54 | M-1: the §7.5 trigram fallback used `word_similarity(...) > 0`, which no GIN index can serve, and the only trigram index was on raw `display_name`. | Function moved to the indexable `lower(display_name) %> lower(q)` operator with a transaction-scoped `pg_trgm.word_similarity_threshold` of 0.15, backed by `items_display_name_trgm_idx`. The candidate floor rises from “any shared trigram” to 0.15 word similarity; the §18 `nxt` → `next.js` pair (≈0.29) still matches. ADR-0025. |
| R-55 | M-11: §6.3 bootstraps only two months back and three ahead, so a missed create-partitions run can put rows in `snapshots_default` and then block the overlapping partition. | Twelve months ahead, a pre-flight guard that refuses the whole window before DDL, `trendr_partition_lead_days` and the `PartitionLeadShort` alert. ADR-0026. |

- **Agent rules file:** `CLAUDE.md` was renamed to `AGENTS.md` so agent tooling that reads
  `AGENTS.md` picks it up automatically. The content is still the verbatim Section 0 rules;
  `TRENDR_SPEC.md` §0/§18 still name `CLAUDE.md` because the spec is frozen.

## Production-readiness review (2026-11-02)

- [`PRODUCTION_READINESS_REVIEW.md`](./PRODUCTION_READINESS_REVIEW.md) records the 27-finding
  review of `main` at `2ad0396` (0 Critical, 4 High, 12 Medium, 11 Low; “Ready with conditions”).
  The PDF is truncated on page 9, so the Medium and Low findings are table-level one-liners only.
- The four High findings were re-verified against the code here: spoofable `CF-Connecting-IP`,
  refresh-reuse family revocation without a grace window, a shared 5/min auth bucket that includes
  refresh, and the rename-back unique violation on `items_source_upstream_uq`.
- H-1 is fixed without a spec deviation: the API validates `CF-Connecting-IP` with `net.isIP` and
  falls back to `request.ip`; nginx overwrites the header and closes non-Cloudflare peers with 444;
  UFW and the `TRENDR-INGRESS` Docker chain restrict 80/443 to the published ranges.
- Two fixes deviate from §10.5 and are recorded as R-52/R-53 with ADR-0022/0023: the 15 s
  refresh-reuse grace (H-2) and the separate refresh rate-limit bucket (H-3), together with the
  naming additions for the new Redis keys and metrics.
- M-1 and M-11 also ship with deliberate changes to the documented behaviour and are recorded as
  R-54/R-55 with ADR-0025/0026.

## Naming additions (production-readiness remediation)

`TRENDR_SPEC.md` is frozen, so names introduced by the review fixes are recorded here instead of
Appendix B.

| Name                                  | Kind           | Finding | Purpose                                                                   |
| ------------------------------------- | -------------- | ------- | ------------------------------------------------------------------------- |
| `TRENDR-INGRESS`                      | iptables chain | H-1     | Filters Docker forwarded 80/443 to Cloudflare ranges in `DOCKER-USER`     |
| `trendr-cloudflare-ips.service`       | systemd unit   | H-1     | Fetches ranges, regenerates nginx includes, reloads nginx, reapplies rules |
| `trendr-cloudflare-ips.timer`         | systemd unit   | H-1     | Weekly refresh (Sunday 03:30 UTC)                                          |
| `infra/cloudflare/ips.txt`            | generated file | H-1     | Canonical Cloudflare range list shared by nginx and the firewall          |
| `nginx-real-ip.conf`, `nginx-geo.conf` | generated file | H-1     | `set_real_ip_from` and `geo` allowlist includes                           |
| `apirl:magic:{sha256(email)}`         | Redis key      | L-1     | Per-address magic-link issuance window (3/h) at 60 s–1 h granularity      |
| `apirl:auth:{ip}`                     | Redis key      | H-3     | Strict 5/min sign-in bucket for magic-link/verify/logout                  |
| `apirl:auth:refresh:{sha256-prefix}`  | Redis key      | H-3     | Per-presented-cookie refresh budget (60/min)                              |
| `apirl:auth:refresh:ip:{ip}`          | Redis key      | H-3     | Coarse per-IP refresh guard (120/min)                                     |
| `trendr_auth_refresh_reuse_total{outcome}` | metric    | H-2     | Grace vs theft-classified refresh reuse                                   |
| `trendr.hasSession`                   | localStorage key | H-3   | Non-sensitive web session hint; never a credential                        |
| `items_display_name_trgm_idx`         | GIN index      | M-1     | Functional trigram index on `lower(display_name)` used by the search fallback |
| `TRIGRAM_WORD_SIMILARITY_THRESHOLD`   | constant       | M-1     | 0.15 word-similarity floor for the fallback, set per transaction          |
| `snapshot_partition_lead_days()`      | SQL function   | M-11    | Days until the newest monthly partition's upper bound                     |
| `snapshot_partition_window_rows()`    | SQL function   | M-11    | Default-partition rows that would block a create-partitions window        |
| `PartitionWindowBlockedError`         | error class    | M-11    | Pre-flight failure before partition DDL                                   |
| `trendr_partition_lead_days`          | metric         | M-11    | Partition lead in days; `PartitionLeadShort` alerts below 60              |
| `PartitionLeadShort`                  | alert          | M-11    | Warns when the partition lead is under 60 days                            |
| `trendr_scoring_runs_total{outcome}`  | metric         | M-3     | Scored runs vs skips caused by a held source lock                         |
| `trendr_rate_limit_degraded_total`    | metric         | L-11    | Rate-limit store failures after which the API failed open                 |
| `admin_audit_log`                     | table          | M-6     | Durable operator mutation trail (actor, action, target, payload)          |

## Environment quirks worth knowing


- `docker compose port <svc> <port>` exits **0** printing `invalid IP:0` when the port is only
  `expose`d — use `docker inspect … NetworkSettings.Ports` (all `null` = unpublished) or a host
  `curl` (connection refused) to verify.
- `postgres:16-alpine` logs a harmless `no usable system locales were found` warning during init.
- On this Windows machine a **native `postgres.exe` service also listens on 5432** and shadows the
  compose port-forward whenever the compose container is down (symptom: `password authentication
  failed for user "trendr"` from host-side scripts, while in-network clients are fine). Check with
  `netstat -ano | grep :5432` and re-`docker compose start postgres redis` after Docker restarts;
  host tools should treat in-network access (`docker compose exec …`) as the source of truth.
- The worker metrics port (`9464`) is `expose`d for Prometheus and must never be published; the
  acceptance check does an in-network GET (`docker compose exec api …`) plus a host-side refusal
  check.
- On this machine **host port 3000 was taken by an unrelated project** (`gmail-bulk-sender`'s
  `next start`). The process was stopped in Phase 6, so compose `web` now publishes
  `localhost:3000`; the same check works in CI. If it reappears, verify web in-network instead
  (`docker run --network trendr_default` + a curl to the container name).
- Docker Desktop's container→`api.github.com` path occasionally fails with a bare `fetch failed`
  while the same request from the host (or a later container request) succeeds. The 17:30Z
  2026-10-19 discover job hit this on its first four attempts (in-process retries included) and
  succeeded on the fifth; treat such flakes as environmental and let §7.5 retries absorb them
  before suspecting the adapter. The same container→`api.npmjs.org` path flaked on 2026-10-20
  (host `curl` returned 200 while container `fetch` gave `ETIMEDOUT`); the npm live daily passed
  on a reduced set on attempt 3. Explicit `429` HTML responses with `Retry-After: 0` are a
  different, rate-limit issue handled above.
- **Root cause found (2026-10-20):** the flake was Node 22's `autoSelectFamily` (Happy Eyeballs)
  trying the Docker NAT64 AAAA address, which blackholes for these AWS/Fastly hosts; `wget` and
  raw IPv4 TCP worked while `fetch`/`https.get` timed out. The builder stage had
  `NODE_OPTIONS=--dns-result-order=ipv4first`, but `runner` starts from `FROM node:22-alpine`
  again, so the setting never reached the deployed process. `infra/docker/node.Dockerfile` now
  sets `--dns-result-order=ipv4first --no-network-family-autoselection` in **both** stages; with
  autoselection off, `pypistats.org` fetches from the worker are consistently 200. This also
  explains the earlier npm/GitHub flakes.
