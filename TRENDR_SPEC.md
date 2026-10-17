# Trendr — Architecture & Design Specification

> **Version:** 1.1 · **Date:** 2026-10-18 · **Owner:** Nayan Kunwar · **Status:** Ready to build
> **Language:** TypeScript everywhere (backend, workers, web, MCP server, scripts)
> **Audience:** an AI coding agent (Claude Code / Cursor) that implements the system end to end, plus human reviewers.

Trendr ranks developer and AI artifacts by **growth velocity**, not absolute size. It covers six sources: GitHub repos, npm packages, PyPI packages, Hugging Face models (plus datasets and spaces as an option), arXiv AI papers, and MCP servers / agent tools. Think gittrend.io, but across ecosystems, with a public API, live updates, alerts, and an MCP server so AI agents can ask "what is trending?"

### Changelog v1.1 (2026-10-18)

Review fixes against v1.0 (backup kept as `TRENDR_SPEC.v1.0.md`):

- **ISS-1** `scores` volume: only eligible items (`final_score > 0`) get a `scores` row; hourly runs kept `SCORES_HOURLY_RETENTION_HOURS` (48 h), then one run per (source, window, UTC day) kept `SCORES_DAILY_RETENTION_DAYS` (365 d); concrete retention SQL (6.5); capacity line with worked numbers; `/v1/items/:id/scores` granularity (10.1, 10.4); tests (16) and acceptance (18: 2.4, 9.4).
- **ISS-2** `TrendingQuery.newOnly` parses `'true'|'false'|'1'|'0'` explicitly (no `z.coerce` on booleans); test `?newOnly=false` → `false`.
- **ISS-3** 8.6: the SQL's 36 h bound is only the outer limit; tier staleness (3 h / 12 h / 36 h) and the `stale` flag are computed in `run-scoring.ts`.
- **ISS-4** Removed the dead arXiv `stars` entry from the scoring params; papers score on HF `upvotes` only, linked code repos score as GitHub items (`github:stars`).
- **ISS-5** Spec file name is `TRENDR_SPEC.md` everywhere.
- **ISS-6** `ensure_snapshot_partitions` builds bounds as explicit UTC literals (`+00`); DB `TimeZone` is UTC (compose `-c timezone=UTC` + `ALTER DATABASE ... SET timezone`).
- **ISS-7** New gauge `trendr_snapshots_default_rows` (set by `maintenance:create-partitions`) and alert `SnapshotsDefaultNotEmpty`.
- **ISS-8** Worker port 9464 no longer published on the host (`expose` only); worker `/metrics` requires `Bearer ${METRICS_TOKEN}`; Prometheus sends it; CI checks worker health with `docker compose exec`.
- **ISS-9** `apps/web/public/.gitkeep` is required (tree + task 0.3) so the web Dockerfile `COPY` never fails.
- **GAPS** "Open decisions (ADRs to record)" list GAP-1..GAP-12 in Section 18, each mapped to the phase that resolves it; scoring parameter tuning added as task 10.5.

---

## Table of Contents

0. [Instructions for the AI Coding Agent (read first)](#0-instructions-for-the-ai-coding-agent-read-first)
1. [Overview, Goals, Non-Goals, Success Criteria](#1-overview-goals-non-goals-success-criteria)
2. [Tech Stack (pinned) and Justification](#2-tech-stack-pinned-and-justification)
3. [Architecture](#3-architecture)
4. [Monorepo Structure](#4-monorepo-structure)
5. [Core TypeScript Interfaces](#5-core-typescript-interfaces)
6. [Database Schema](#6-database-schema)
7. [Ingestion Design (per source)](#7-ingestion-design-per-source)
8. [Scoring Algorithm](#8-scoring-algorithm)
9. [Caching](#9-caching)
10. [REST API](#10-rest-api)
11. [MCP Server](#11-mcp-server)
12. [Frontend](#12-frontend)
13. [Notifications](#13-notifications)
14. [Observability](#14-observability)
15. [Security](#15-security)
16. [Testing Strategy](#16-testing-strategy)
17. [DevOps](#17-devops)
18. [Phased Build Plan](#18-phased-build-plan)
19. [Stretch Goals and Interview Talking Points](#19-stretch-goals-and-interview-talking-points)
20. [Appendix A: Verified External API Facts](#appendix-a-verified-external-api-facts)
21. [Appendix B: Glossary and Naming Registry](#appendix-b-glossary-and-naming-registry)

---

## 0. Instructions for the AI Coding Agent (read first)

Copy this whole section into the agent's system or project rules file (`CLAUDE.md` / `.cursor/rules/trendr.mdc`).

```text
You are implementing "Trendr" from TRENDR_SPEC.md, which lives at the repo root.

HOW TO USE THE SPEC
- Section 18 (Phased Build Plan) is your task list. Do the tasks in order. Do not start a phase
  until the previous phase's acceptance criteria all pass.
- Sections 5, 6, 9 and 10 are contracts. Names of tables, columns, queues, Redis keys, env vars,
  metrics and endpoints MUST match the spec exactly. Appendix B is the naming registry. If you need
  a new name, add it to Appendix B in the same commit.
- If the spec is ambiguous or wrong, choose the simplest option that fits the rest of the spec,
  write the decision in docs/adr/NNNN-title.md (ADR format), and keep going. Do not stall.
- Anything marked "verify" is an external API detail that was not confirmed. Check it against the
  live API (a recorded fixture is fine) before you rely on it, and record the result in the ADR or a
  code comment.

CONVENTIONS
- TypeScript strict mode everywhere ("strict": true, "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true). No `any`. Use `unknown` and narrow it with Zod. Avoid
  `as` casts except at proven boundaries, and add a comment when you use one.
- ESM only ("type": "module"). Node 22 LTS. pnpm workspaces + Turborepo.
- ESLint (typescript-eslint strict-type-checked) + Prettier. CI fails on lint errors.
- Validate every external input with Zod: env, HTTP requests, upstream API responses, job payloads.
- Never read process.env outside packages/config. Import the typed `env` object instead.
- Use the `logger` from packages/logger only. No console.log in committed code (scripts excepted).
- Errors: throw typed errors (packages/core/src/errors.ts). The API maps them to RFC 7807.
- Conventional Commits (feat:, fix:, chore:, test:, docs:, refactor:, perf:, ci:).
- Keep every step PR-sized: each commit compiles, passes tests, and touches one concern.
- Write tests FIRST for core logic: scoring, normalization, rate limiter, adapters' normalize().
- Never commit secrets. .env stays git-ignored; only .env.example is committed.
  Recorded HTTP fixtures must have Authorization headers and tokens stripped.
- Keep README.md current: setup, commands, architecture summary, env var table.
- Every phase ends with: `pnpm lint && pnpm typecheck && pnpm test` green AND
  `docker compose up --build` producing healthy containers (`/healthz` 200, `/readyz` 200).
- DB changes go only through Drizzle migrations in packages/db/migrations (raw SQL is allowed for
  partitioning). Never edit an applied migration; add a new one.
- Idempotency: every ingestion write is an upsert on a natural key (see Section 6). Re-running a job
  must not duplicate data.
- Be a polite client: respect upstream rate limits and robots/ToS (Section 7). Send the
  User-Agent "Trendr/1.0 (+https://github.com/<owner>/trendr)".

DEFINITION OF DONE (per task)
- Code + tests + docs updated, CI green, docker compose healthy, acceptance criteria met.
```

---

## 1. Overview, Goals, Non-Goals, Success Criteria

### 1.1 Problem

Developers and AI engineers want to know what is gaining traction **right now** across ecosystems. GitHub Trending covers only GitHub, uses opaque scoring, and has no API. Download charts for npm and PyPI favor long-established packages. AI moves fast: a model, a paper, its reference repo, its PyPI package and its MCP server can all trend in the same week, and nobody links them together.

### 1.2 Product summary

- **Leaderboards** ranked by growth velocity over `24h`, `7d` and `30d` windows, per source and combined ("All").
- **Filters:** source, language (GitHub), topic/tag, item kind, minimum size, "new only" (created in the last 30 days).
- **Item detail pages:** metadata, metric history charts, score history, cross-source aliases (repo ↔ npm ↔ PyPI ↔ MCP server ↔ paper ↔ HF model).
- **Search** across all items: Postgres full-text search plus trigram fuzzy matching.
- **Accounts:** watchlists, alert rules (velocity spike, rank entry, threshold), weekly digest email.
- **Live:** an SSE stream that pushes leaderboard changes after each scoring run.
- **Public REST API** with API keys and OpenAPI docs.
- **MCP server** that exposes trends to AI agents (stdio and Streamable HTTP).

### 1.3 Goals

| # | Goal |
|---|------|
| G1 | Correct, explainable velocity ranking. Every score can be decomposed into delta, base, relative growth and factors through the API (`/v1/items/:id/score-explain`). |
| G2 | Robust ingestion that stays inside every upstream rate limit, retries safely, writes idempotently and records each run in `ingestion_runs`. |
| G3 | Fast reads: leaderboard p95 < 50 ms server-side from Redis; item detail p95 < 150 ms cold and < 20 ms warm. |
| G4 | Production-grade operations: metrics, structured logs, health checks, CI, Docker, one-command local setup. |
| G5 | Interview showcase: clear trade-offs (BullMQ vs Kafka, partitioning vs Timescale, Fastify vs Express, cursor pagination, outbox) with ADRs. |

### 1.4 Non-goals (v1)

- Scraping HTML pages (github.com/trending, pypi.org pages). Documented APIs and feeds only.
- Full historical backfill for every item ever. Backfill is bounded (Section 7.9).
- Real-time (sub-minute) metrics. Hourly is the finest granularity.
- Social sources (X, Reddit, Hacker News). These are stretch goals.
- Multi-tenant orgs, billing, or paid plans.
- A mobile app.
- ML-based ranking. Scoring is deterministic and formula-based.

### 1.5 Success criteria

| Criterion | Target |
|-----------|--------|
| Tracked items (steady state, single small VPS) | ≥ 20k GitHub repos, ≥ 5k npm, ≥ 2k PyPI, ≥ 5k HF models, ≥ 3k papers/month, all MCP registry servers |
| Freshness | Hot tier ≤ 70 min old; daily sources ≤ 26 h after upstream publish |
| Scoring run | All sources × 3 windows in < 60 s for 50k items |
| Ingestion success rate | ≥ 99% of jobs succeed within retries; DLQ < 0.5% |
| Upstream compliance | 0 primary-rate-limit violations (HTTP 403/429 with remaining=0) per day after warm-up |
| Tests | Core packages ≥ 90% line coverage; overall ≥ 80%; CI < 10 min |
| DX | `git clone && cp .env.example .env && docker compose up` gives a working app with seed data |

---

## 2. Tech Stack (pinned) and Justification

Versions were checked against the npm registry on 2026-10-17. Pin with `^` on the major shown, commit `pnpm-lock.yaml`, and set `"packageManager": "pnpm@10.x"` (any current pnpm major works; record the choice in an ADR).

| Concern | Choice | Version | Why |
|---|---|---|---|
| Runtime | Node.js LTS | 22.x | Native `fetch`/undici, stable ESM, `--env-file`, long LTS. |
| Language | TypeScript | ^5.9 | Strict mode. TS 6/7 (the native Go compiler) exist, but 5.9 has the widest tooling compatibility (ts-eslint, drizzle-kit, Next). Moving up is a one-line ADR later. |
| Monorepo | pnpm workspaces + Turborepo | turbo ^2 | Content-hashed task caching, `dependsOn` pipelines, one lockfile. |
| HTTP framework | **Fastify** | ^5 | See 2.1. |
| Validation / env | Zod | ^4 | One schema serves runtime validation, TS types and OpenAPI (via `fastify-type-provider-zod` ^7, which needs zod ≥ 4.1.5). |
| ORM | **Drizzle ORM** + drizzle-kit | ^0.45 / ^0.31 | See 2.2. Driver: `pg` (node-postgres) ^8. |
| Database | PostgreSQL | 16 | Native declarative partitioning, `pg_trgm`, FTS, `jsonb`. **Default: plain Postgres with monthly range partitions** (runs on Neon or Render). Optional: TimescaleDB hypertable (Section 6.6). |
| Cache / queue backend | Redis | 7.x | Sorted-set leaderboards, token buckets (Lua), pub/sub for SSE fan-out, BullMQ backend. |
| Jobs / scheduling | **BullMQ** | ^6 (peer: ioredis ^5) | See 2.3. Cron via Job Schedulers (`upsertJobScheduler`). |
| Redis client | ioredis | ^5 | Required peer of BullMQ; also used for cache and pub/sub. |
| HTTP client (upstream) | undici (built-in `fetch`) + small wrapper | Node 22 built-in | Keep-alive agent, timeouts via `AbortSignal.timeout`, no extra dependency. |
| XML parsing (arXiv Atom, PyPI RSS) | fast-xml-parser | ^5 | Fast, no native deps. |
| Frontend | Next.js App Router | **15.5.x** (latest 15 line) | Requested pin. Server Components + ISR for SEO; Next 16 exists, so upgrading is an ADR. |
| UI | Tailwind CSS ^4 + shadcn/ui + Recharts ^3 + SWR ^2 | | |
| Logging | pino | ^10 | Fastify's native logger; JSON; redaction. `pino-pretty` in dev only. |
| Metrics | prom-client | ^15 | `/metrics` in Prometheus format, as in Shortly. |
| Tracing (optional) | OpenTelemetry Node SDK + auto-instrumentations | latest | OTLP exporter, off by default (`OTEL_ENABLED=false`). |
| Tests | Vitest ^5, Supertest (plus Fastify `inject`), Testcontainers (`@testcontainers/postgresql`, `@testcontainers/redis`), nock / undici `MockAgent` | | |
| Email | Resend SDK (prod) / Nodemailer SMTP to Mailpit (dev) | resend ^6 | Behind an `EmailSender` interface. |
| MCP | `@modelcontextprotocol/sdk` | ^1.32 | Official TS SDK; stdio and Streamable HTTP transports. |
| Containers | Docker, Docker Compose v2 | | Multi-stage builds, `turbo prune` for small images. |
| CI | GitHub Actions | | Lint, typecheck, unit, integration (Testcontainers), build images. |
| Reverse proxy (VPS) | nginx (or Caddy) | | Same setup as Shortly. SSE needs `proxy_buffering off`. |
| Edge | Cloudflare | | CDN and caching of public GETs; DDoS protection. |

### 2.1 Fastify vs Express → **Fastify**

- **Schema-first:** route schemas (Zod through the type provider) validate input, serialize output, and generate OpenAPI from one source of truth. Express needs three separate libraries for the same.
- **Performance:** a faster router and `fast-json-stringify` serialization matter for leaderboard endpoints that return 100 rows.
- **Encapsulated plugins:** `fastify-plugin` with decorators (`app.db`, `app.redis`, `app.cache`) gives clean dependency injection and testable modules.
- **Built-in pino logger** with request ids; `app.inject()` makes HTTP tests fast without opening a port.
- **Trade-off:** a smaller ecosystem than Express and some learning curve. Nayan knows Express from Shortly, so choosing Fastify on purpose is itself a good interview story.

### 2.2 Drizzle vs Prisma → **Drizzle**

- SQL-first and transparent, so the queries you read are the queries that run. This matters for window functions, `percentile_cont`, `DISTINCT ON`, and partition-pruned time-range scans.
- No query-engine binary, small Docker images, fast cold start.
- Migrations are plain SQL files you can edit. **Partitioned tables, partition-creation functions and Timescale DDL go in raw SQL migrations**, which Prisma handles poorly.
- Typed schema in TS that `drizzle-zod` can reuse.
- **Trade-off:** Drizzle cannot model `PARTITION BY` declaratively. The `snapshots` table is declared in Drizzle for typing, and its DDL comes from a hand-written migration (Section 6.3).

### 2.3 BullMQ vs Kafka vs RabbitMQ → **BullMQ**

| Need | BullMQ | Kafka | RabbitMQ |
|---|---|---|---|
| Cron scheduling | Built in (job schedulers) | No (needs external cron) | No (plugin/delayed exchange) |
| Delayed jobs + retries with backoff | Built in | Manual | Via DLX/TTL patterns |
| Per-queue concurrency and global rate limiting | Built in (`limiter`, `concurrency`) | Partition-bound | Prefetch only |
| Extra infrastructure | None (Redis is already needed for cache) | ZooKeeper/KRaft cluster | Broker |
| Replay / event log | Weak | Excellent | Weak |
| Throughput need here | ~10⁵ jobs/day, easily handled | Overkill | Fine |

The workload is **task scheduling with retries**, not a high-throughput event stream. One Redis serves cache, rate limiting, pub/sub and queues, which keeps the free-tier deployment small.

**Stretch (Section 19):** a transactional **outbox** table (`outbox_events`) written in the same transaction as `scores` and `alert_events`, relayed to **RabbitMQ** (topic exchange `trendr.events`) for external consumers. This reuses Shortly's pattern and shows that BullMQ (jobs) and a broker (domain events) fit together.

---

## 3. Architecture

### 3.1 Component diagram

```mermaid
flowchart LR
  subgraph Upstream["Upstream public APIs"]
    GH[GitHub REST + GraphQL]
    NPM[npm registry + api.npmjs.org]
    PYPI[PyPI JSON/RSS + pypistats.org]
    HF[Hugging Face Hub API]
    ARX[arXiv export API]
    MCPR[MCP Registry API]
  end

  subgraph Worker["apps/worker (BullMQ)"]
    SCH[Scheduler<br/>job schedulers / cron]
    ING[Ingestion processors<br/>ingest-github ... ingest-mcp]
    SCO[Scoring processor<br/>queue: scoring]
    NOT[Notifier processor<br/>queues: notify, digest]
    MNT[Maintenance<br/>queue: maintenance]
  end

  subgraph Data
    PG[(PostgreSQL 16<br/>items, snapshots (partitioned),<br/>daily_metrics, scores, ...)]
    RD[(Redis 7<br/>BullMQ, lb:* ZSETs,<br/>item cache, rl:* buckets,<br/>pub/sub events:leaderboard)]
  end

  API[apps/api<br/>Fastify REST + SSE + /metrics]
  WEB[apps/web<br/>Next.js 15]
  MCP[apps/mcp<br/>MCP server stdio + HTTP]
  MAIL[Resend / SMTP]
  CF[Cloudflare] --> NGINX[nginx]
  NGINX --> WEB
  NGINX --> API
  NGINX --> MCP

  SCH -->|enqueue| RD
  ING -->|token bucket| RD
  ING --> GH & NPM & PYPI & HF & ARX & MCPR
  ING -->|upsert items/snapshots/daily_metrics| PG
  ING -->|enqueue scoring| RD
  SCO -->|read series| PG
  SCO -->|write scores| PG
  SCO -->|rebuild lb:* atomically| RD
  SCO -->|PUBLISH events:leaderboard| RD
  SCO -->|enqueue evaluate-alerts| RD
  NOT --> PG
  NOT --> MAIL
  API --> RD
  API --> PG
  API -->|SUBSCRIBE events:leaderboard → SSE| RD
  WEB -->|server fetch + SWR + EventSource| API
  MCP -->|HTTP + API key| API
  Prom[Prometheus] -.scrape.-> API & Worker
  Graf[Grafana] -.-> Prom
```

### 3.2 Components

| Component | Process | Responsibilities | Scales by |
|---|---|---|---|
| **api** (`apps/api`) | Fastify HTTP server, port `4000` | Public REST `/v1/*`, auth, API keys, admin endpoints, SSE `/v1/stream/leaderboard`, OpenAPI `/docs`, `/healthz`, `/readyz`, `/metrics`. Reads Redis first, falls back to Postgres. Never calls upstream APIs. | Stateless; horizontal replicas. SSE fan-out goes through Redis pub/sub, so any replica can serve any client. |
| **scheduler** (in `apps/worker`, role `scheduler`) | Registers BullMQ job schedulers on boot (idempotent `upsertJobScheduler`) | Cron for discovery, snapshots per tier, daily metrics, scoring, re-tiering, digests, partition maintenance. | Exactly one active instance is fine: schedulers are stored in Redis and deduplicated by id, so a duplicate scheduler causes no double runs. |
| **ingestion workers** (role `ingest`) | One BullMQ `Worker` per source queue (`ingest-github`, `ingest-npm`, `ingest-pypi`, `ingest-huggingface`, `ingest-arxiv`, `ingest-mcp`) | Run `SourceAdapter` methods: `discover`, `fetchMetrics`, `normalize`. Upsert into `items`, `item_aliases`, `snapshots`, `daily_metrics`. Record each run in `ingestion_runs`. Respect the per-source token bucket. | Per-queue concurrency (`WORKER_CONCURRENCY_INGEST`). Rate limits are global per source through Redis, so adding workers never exceeds upstream limits. |
| **scoring worker** (role `scoring`) | Queue `scoring`, job `compute-scores` | Load series for each (source, window), compute scores (Section 8), write `scores` (one row per **eligible** item/window/run; ineligible items get no row and are only counted in `trendr_scoring_items`), rebuild `lb:*` ZSETs atomically, publish a diff on `events:leaderboard`, enqueue `notify:evaluate-alerts`. | Single active job per source (Redis lock `lock:score:{source}`); work is CPU-bound and runs in batches. |
| **notifier worker** (role `notify`) | Queues `notify` (jobs `evaluate-alerts`, `send-alert-email`) and `digest` (`build-weekly-digest`, `send-digest`) | Evaluate alert rules against new scores, insert `alert_events` (deduplicated), send email, build the weekly digest. | Concurrency 5; email provider rate-limited through the BullMQ `limiter`. |
| **maintenance** (role `scoring`, reuses the process) | Queue `maintenance` | `create-partitions` (next 3 months), `retention` (drop or roll up old partitions), `retier-items`, `cleanup-tokens`. | Single. |
| **web** (`apps/web`) | Next.js 15, port `3000` | SSR/ISR pages, charts, filters, auth UI, watchlists, OG images. Talks to the API only (no direct DB access). | Stateless. |
| **mcp-server** (`apps/mcp`) | Node, port `4100` (HTTP) or stdio | MCP tools (Section 11) backed by the public REST API with a service API key. | Stateless. |

### 3.3 Data flow (happy path, GitHub hot tier)

```mermaid
sequenceDiagram
  participant S as Scheduler
  participant Q as Redis (BullMQ)
  participant W as ingest-github worker
  participant GH as GitHub GraphQL
  participant DB as Postgres
  participant SC as scoring worker
  participant API as api (SSE)
  participant B as Browser

  S->>Q: add snapshot{tier:hot, batch:0..N} (cron 5 * * * *)
  Q->>W: job snapshot (jobId github.snapshot.hot.2026-10-17T14.0)
  W->>DB: insert ingestion_runs(status=running)
  W->>Q: acquire rl:github:graphql tokens (Lua)
  W->>GH: query { r0: repository(owner,name){stargazerCount forkCount ...} ... r49 }
  GH-->>W: 200 + rateLimit{remaining,resetAt}
  W->>DB: upsert snapshots ON CONFLICT (item_id, metric, captured_at) DO UPDATE
  W->>DB: update ingestion_runs(status=succeeded, items_ok, api_calls)
  W->>Q: add scoring compute-scores{source:github} (jobId dedupe per hour)
  Q->>SC: compute-scores
  SC->>DB: read series, write scores(run_id)
  SC->>Q: build lb:github:24h:_all:tmp:{runId} → MULTI RENAME → lb:github:24h:_all ... EXEC
  SC->>Q: PUBLISH events:leaderboard {source, window, top movers}
  Q-->>API: message (subscriber)
  API-->>B: SSE event: leaderboard.update
```

### 3.4 Process topology by environment

| Env | Topology |
|---|---|
| Local | `docker compose up`: postgres, redis, api, worker (all roles), web, mcp, mailpit; prometheus and grafana behind profile `obs`. |
| Free tier (Render/Fly + Neon + Upstash) | api, web and worker (all roles in one process) as separate services; Neon Postgres; Upstash Redis (watch command quotas, see 17.6). |
| VPS (recommended for demos) | One 2 vCPU / 4 GB VPS running the same compose file, nginx and Cloudflare in front. Cheapest and fully under your control, and the same setup as Shortly. |

`WORKER_ROLES` (comma list: `scheduler,ingest,scoring,notify`) controls which processors a worker process starts, so the same image can run as one process or split into several.

---

## 4. Monorepo Structure

```text
trendr/
├── TRENDR_SPEC.md                    # this file
├── README.md
├── CLAUDE.md                         # = Section 0 (agent rules)
├── package.json                      # root scripts: dev, build, lint, typecheck, test, test:int, db:*, ingest:bootstrap, worker:score, fixtures:record
├── pnpm-workspace.yaml               # packages: ["apps/*", "packages/*"]
├── turbo.json
├── tsconfig.base.json                # strict settings shared by all packages
├── eslint.config.js                  # flat config, typescript-eslint strictTypeChecked
├── .prettierrc
├── .env.example
├── .gitignore / .dockerignore / .nvmrc (22)
├── docker-compose.yml
├── docker-compose.override.yml       # dev: bind mounts, hot reload
├── infra/
│   ├── docker/
│   │   ├── node.Dockerfile           # shared multi-stage, ARG APP=api|worker|mcp
│   │   └── web.Dockerfile            # Next.js standalone build
│   ├── nginx/nginx.conf
│   ├── prometheus/prometheus.yml
│   ├── prometheus/alerts.yml
│   └── grafana/
│       ├── provisioning/datasources/prometheus.yml
│       ├── provisioning/dashboards/dashboards.yml
│       └── dashboards/trendr-overview.json
├── docs/
│   ├── adr/0001-fastify-over-express.md
│   ├── adr/0002-drizzle-over-prisma.md
│   ├── adr/0003-bullmq-over-kafka.md
│   ├── adr/0004-partitioned-snapshots.md
│   └── runbook.md
├── .github/workflows/
│   ├── ci.yml
│   └── docker-publish.yml
├── apps/
│   ├── api/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── main.ts               # bootstrap: env, logger, buildApp(), listen, graceful shutdown
│   │   │   ├── app.ts                # buildApp(deps): registers plugins + routes (used by tests)
│   │   │   ├── plugins/
│   │   │   │   ├── db.ts             # decorates app.db (Drizzle) + app.pool
│   │   │   │   ├── redis.ts          # app.redis (commands), app.redisSub (subscriber)
│   │   │   │   ├── cache.ts          # app.cache: readThrough(), invalidate()
│   │   │   │   ├── auth.ts           # JWT verify, app.authenticate, app.requireAdmin
│   │   │   │   ├── api-key.ts        # X-API-Key → api_keys lookup (hashed), scopes
│   │   │   │   ├── rate-limit.ts     # @fastify/rate-limit with Redis store, tiered limits
│   │   │   │   ├── errors.ts         # setErrorHandler → RFC 7807 problem+json
│   │   │   │   ├── security.ts       # @fastify/helmet, @fastify/cors, @fastify/cookie
│   │   │   │   ├── metrics.ts        # prom-client registry, http histograms, GET /metrics
│   │   │   │   ├── openapi.ts        # @fastify/swagger + @fastify/swagger-ui at /docs
│   │   │   │   └── etag.ts           # weak ETag + 304 for GETs, Cache-Control helpers
│   │   │   ├── routes/
│   │   │   │   ├── health.ts         # /healthz /readyz
│   │   │   │   ├── trending.ts       # GET /v1/trending
│   │   │   │   ├── items.ts          # /v1/items/:id, /history, /scores, /score-explain, /aliases
│   │   │   │   ├── search.ts         # GET /v1/search
│   │   │   │   ├── topics.ts         # GET /v1/topics, /v1/languages
│   │   │   │   ├── compare.ts        # GET /v1/compare
│   │   │   │   ├── stream.ts         # GET /v1/stream/leaderboard (SSE)
│   │   │   │   ├── auth.ts           # /v1/auth/magic-link, /verify, /refresh, /logout
│   │   │   │   ├── me.ts             # /v1/me, watchlists, alerts, digest, api-keys
│   │   │   │   ├── unsubscribe.ts    # GET/POST /v1/unsubscribe
│   │   │   │   └── admin.ts          # /v1/admin/ingest, /runs, /dlq, /items/:id/retier
│   │   │   ├── services/             # business logic, framework-free (unit-testable)
│   │   │   │   ├── leaderboard.service.ts
│   │   │   │   ├── item.service.ts
│   │   │   │   ├── search.service.ts
│   │   │   │   ├── auth.service.ts
│   │   │   │   ├── watchlist.service.ts
│   │   │   │   ├── alert.service.ts
│   │   │   │   └── admin.service.ts
│   │   │   ├── schemas/              # Zod request/response schemas (exported for web + mcp)
│   │   │   │   ├── common.ts         # Problem, Cursor, Pagination, enums
│   │   │   │   ├── trending.ts
│   │   │   │   ├── items.ts
│   │   │   │   ├── me.ts
│   │   │   │   └── admin.ts
│   │   │   └── sse/broadcaster.ts    # one Redis subscriber → many SSE clients
│   │   └── test/
│   │       ├── e2e/*.e2e.test.ts     # Testcontainers + app.inject / supertest
│   │       └── helpers/              # buildTestApp(), seed()
│   ├── worker/
│   │   ├── src/
│   │   │   ├── main.ts               # reads WORKER_ROLES, starts processors, graceful shutdown
│   │   │   ├── queues.ts             # Queue instances + names (re-export from core)
│   │   │   ├── scheduler.ts          # upsertJobScheduler definitions (Section 7.2)
│   │   │   ├── processors/
│   │   │   │   ├── ingest.processor.ts       # generic: resolves adapter by source, runs job type
│   │   │   │   ├── scoring.processor.ts
│   │   │   │   ├── notify.processor.ts
│   │   │   │   ├── digest.processor.ts
│   │   │   │   └── maintenance.processor.ts
│   │   │   ├── ingestion/
│   │   │   │   ├── run-recorder.ts           # ingestion_runs lifecycle
│   │   │   │   ├── upsert.ts                 # bulk upserts items/aliases/snapshots/daily_metrics
│   │   │   │   ├── tiering.ts                # retier rules
│   │   │   │   └── alias-resolver.ts         # cross-source linking
│   │   │   ├── scoring/
│   │   │   │   ├── load-series.ts            # SQL to fetch window endpoints / daily sums
│   │   │   │   ├── publish-leaderboards.ts   # Redis ZSET rebuild + pub/sub
│   │   │   │   └── run-scoring.ts
│   │   │   ├── notify/
│   │   │   │   ├── evaluate-alerts.ts
│   │   │   │   ├── build-digest.ts
│   │   │   │   └── templates/ (alert.tsx, digest.tsx via @react-email/components)
│   │   │   ├── dlq.ts                        # failed-final → dead-letter queue
│   │   │   └── metrics-server.ts             # :9464/healthz (open) + /metrics (Bearer METRICS_TOKEN); Docker network only
│   │   └── test/
│   ├── web/
│   │   ├── next.config.ts            # output: 'standalone'
│   │   ├── public/.gitkeep           # REQUIRED: web.Dockerfile COPYs apps/web/public (fails if the dir is missing)
│   │   ├── src/app/                  # see Section 12
│   │   ├── src/components/
│   │   ├── src/lib/api.ts            # typed fetch client using @trendr/core types
│   │   └── tailwind / components.json (shadcn)
│   └── mcp/
│       ├── src/
│       │   ├── main.ts               # MCP_TRANSPORT=stdio|http
│       │   ├── server.ts             # McpServer + tool registration
│       │   ├── tools/
│       │   │   ├── get-trending.ts
│       │   │   ├── search-items.ts
│       │   │   ├── get-item-history.ts
│       │   │   ├── compare-items.ts
│       │   │   └── whats-new-in-mcp.ts
│       │   └── api-client.ts         # calls API_INTERNAL_URL with MCP_API_KEY
│       └── test/
└── packages/
    ├── config/
    │   └── src/
    │       ├── env.ts                # Zod env schema, parse once, export `env`
    │       ├── constants.ts          # SOURCES, WINDOWS, TIERS, defaults
    │       └── index.ts
    ├── logger/
    │   └── src/index.ts              # pino factory: createLogger({service}), redact paths
    ├── db/
    │   ├── drizzle.config.ts
    │   ├── migrations/               # 0000_init.sql, 0001_partitions.sql, ...
    │   └── src/
    │       ├── client.ts             # createDb(url, poolMax) → { db, pool }
    │       ├── schema/
    │       │   ├── enums.ts
    │       │   ├── items.ts          # items, item_aliases, topics, item_topics
    │       │   ├── metrics.ts        # snapshots, daily_metrics, scores
    │       │   ├── users.ts          # users, auth_tokens, api_keys
    │       │   ├── engagement.ts     # watchlists, watchlist_items, alerts, alert_events,
    │       │   │                     # digest_subscriptions, digest_sends
    │       │   ├── ops.ts            # ingestion_runs, outbox_events
    │       │   └── index.ts
    │       ├── repositories/         # typed query helpers used by api + worker
    │       │   ├── items.repo.ts
    │       │   ├── snapshots.repo.ts
    │       │   ├── scores.repo.ts
    │       │   └── runs.repo.ts
    │       ├── seed.ts               # dev seed from fixtures
    │       └── partitions.ts         # ensurePartitions(monthsAhead)
    ├── core/
    │   └── src/
    │       ├── types.ts              # Source, ItemKind, Window, Item, MetricSnapshot, Score ...
    │       ├── errors.ts             # AppError hierarchy
    │       ├── queues.ts             # QUEUE names, job payload Zod schemas
    │       ├── redis-keys.ts         # key builders (single source of truth)
    │       ├── scoring/
    │       │   ├── params.ts         # per-source/window constants (Section 8.3)
    │       │   ├── velocity.ts       # computeRawScore()
    │       │   ├── normalize.ts      # robustZ(), percentileRank()
    │       │   ├── anomaly.ts        # detectBurst()
    │       │   ├── series.ts         # valueAt(), interpolate(), coverage()
    │       │   └── index.ts
    │       ├── rate-limit/
    │       │   ├── token-bucket.lua
    │       │   └── token-bucket.ts   # RedisTokenBucket.take(key, n)
    │       ├── http/
    │       │   ├── fetch-json.ts     # timeout, retries, backoff+jitter, header capture
    │       │   └── backoff.ts
    │       ├── topics.ts             # topic slug normalization + synonym table
    │       └── ids.ts                # canonical external-id normalizers
    └── sources/
        └── src/
            ├── adapter.ts            # SourceAdapter interface + base helpers
            ├── registry.ts           # getAdapter(source)
            ├── github/
            │   ├── github.adapter.ts
            │   ├── graphql.ts        # batched repository query builder
            │   ├── rest.ts           # search + conditional GET (ETag)
            │   ├── schemas.ts        # Zod for upstream responses
            │   └── __fixtures__/*.json
            ├── npm/        (npm.adapter.ts, schemas.ts, __fixtures__/)
            ├── pypi/       (pypi.adapter.ts, rss.ts, schemas.ts, __fixtures__/)
            ├── huggingface/(huggingface.adapter.ts, schemas.ts, __fixtures__/)
            ├── arxiv/      (arxiv.adapter.ts, atom.ts, schemas.ts, __fixtures__/)
            └── mcp/        (mcp.adapter.ts, schemas.ts, __fixtures__/)
```

Package names: `@trendr/config`, `@trendr/logger`, `@trendr/db`, `@trendr/core`, `@trendr/sources`; apps `@trendr/api`, `@trendr/worker`, `@trendr/web`, `@trendr/mcp`. Dependency direction (enforced with `eslint-plugin-boundaries` or `dependency-cruiser`): `config ← logger ← core ← db ← sources ← apps`. `core` must not import `db`. Packages build with `tsup` to `dist/` (ESM plus `.d.ts`); apps run with `tsx` in dev and compiled JS in prod.

`turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**", "!.next/cache/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "lint": {},
    "test": { "dependsOn": ["^build"], "outputs": ["coverage/**"] },
    "test:int": { "dependsOn": ["^build"], "cache": false },
    "dev": { "cache": false, "persistent": true }
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  }
}
```

---

## 5. Core TypeScript Interfaces

All types live in `packages/core/src/types.ts`. They are derived from Zod schemas, so runtime and compile-time agree.

```ts
// packages/core/src/types.ts
import { z } from 'zod';

export const SOURCES = ['github', 'npm', 'pypi', 'huggingface', 'arxiv', 'mcp'] as const;
export const SourceSchema = z.enum(SOURCES);
export type Source = z.infer<typeof SourceSchema>;

/** Leaderboard scope: one source or the combined board. */
export const LeaderboardScopeSchema = z.enum(['all', ...SOURCES]);
export type LeaderboardScope = z.infer<typeof LeaderboardScopeSchema>;

export const ITEM_KINDS = ['repo', 'package', 'model', 'dataset', 'space', 'paper', 'mcp_server'] as const;
export const ItemKindSchema = z.enum(ITEM_KINDS);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const WINDOWS = ['24h', '7d', '30d'] as const;
export const WindowSchema = z.enum(WINDOWS);
export type Window = z.infer<typeof WindowSchema>;
export const WINDOW_HOURS: Record<Window, number> = { '24h': 24, '7d': 168, '30d': 720 };
export const WINDOW_DAYS: Record<Window, number> = { '24h': 1, '7d': 7, '30d': 30 };

export const TIERS = ['hot', 'warm', 'cold', 'archived'] as const;
export const TierSchema = z.enum(TIERS);
export type Tier = z.infer<typeof TierSchema>;

/**
 * Metric semantics drive the scoring math:
 *  - cumulative: monotonic-ish counter sampled by snapshots (stars, likes, upvotes, downloads_total)
 *  - daily_count: upstream gives per-day aggregates (npm/PyPI downloads); never diff these
 *  - gauge: point-in-time value with no growth meaning (HF trending_score, open_issues)
 */
export const METRICS = [
  'stars', 'forks', 'watchers', 'open_issues',
  'downloads', 'downloads_total', 'likes', 'upvotes', 'trending_score', 'comments',
] as const;
export const MetricSchema = z.enum(METRICS);
export type Metric = z.infer<typeof MetricSchema>;
export type MetricKind = 'cumulative' | 'daily_count' | 'gauge';
export const METRIC_KIND: Record<Metric, MetricKind> = {
  stars: 'cumulative', forks: 'cumulative', watchers: 'cumulative', open_issues: 'gauge',
  downloads: 'daily_count', downloads_total: 'cumulative', likes: 'cumulative',
  upvotes: 'cumulative', trending_score: 'gauge', comments: 'cumulative',
};

/** Canonical item as stored in `items`. */
export interface Item {
  id: bigint;                       // items.id (bigint identity); serialized as string in JSON
  source: Source;
  kind: ItemKind;
  externalId: string;               // canonical natural key, see ids.ts (e.g. "vercel/next.js", "@scope/pkg", "2610.21185")
  upstreamId: string | null;        // stable upstream id if any (GitHub node_id, HF _id, MCP registry name)
  name: string;                     // short name ("next.js")
  displayName: string;              // "vercel/next.js"
  description: string | null;
  url: string;                      // canonical upstream URL
  homepage: string | null;
  language: string | null;          // GitHub primary language, "python" for PyPI, "javascript" for npm
  license: string | null;
  owner: string | null;
  topics: string[];                 // normalized slugs
  primaryMetric: Metric;
  latestMetrics: Partial<Record<Metric, number>>;
  tier: Tier;
  upstreamCreatedAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastSnapshotAt: Date | null;
  isArchived: boolean;
  flags: ItemFlag[];
  metadata: Record<string, unknown>; // source-specific (validated per source by Zod)
}
export type ItemFlag = 'burst_suspected' | 'fork' | 'deprecated' | 'gated' | 'yanked' | 'manual_hidden';

/** One point of a time series (row in `snapshots`). captured_at is the *bucket start*. */
export interface MetricSnapshot {
  itemId: bigint;
  metric: Metric;
  capturedAt: Date;   // date_trunc('hour') for hot/warm, date_trunc('day') for cold
  observedAt: Date;   // actual fetch time
  value: number;      // stored as bigint; JS number is safe up to 2^53
  runId: bigint | null;
}

/** One day of an aggregate (row in `daily_metrics`). */
export interface DailyMetric {
  itemId: bigint;
  metric: Metric;
  day: string;        // 'YYYY-MM-DD' UTC
  value: number;      // daily_count: count that day; cumulative: end-of-day level
}

export interface ScoreComponents {
  delta: number;            // absolute growth in window
  base: number;             // level (cumulative) or prior-period total (daily_count)
  relGrowth: number;        // delta / (base + k)
  rawScore: number;         // log-damped velocity (Section 8.2)
  ageFactor: number;
  confidence: number;       // 0..1 data coverage
  anomalyPenalty: number;   // 1 = none, <1 penalized
  finalScore: number;       // raw * age * confidence * anomaly
}

export interface Score extends ScoreComponents {
  itemId: bigint;
  source: Source;
  window: Window;
  runId: bigint;
  computedAt: Date;
  zScore: number;           // robust z within (source, window)
  percentile: number;       // 0..100 within (source, window)
  rankSource: number;       // 1-based
  rankAll: number | null;   // 1-based rank in combined board (null if not eligible)
  flags: ScoreFlag[];
}
export type ScoreFlag = 'below_threshold' | 'insufficient_data' | 'burst_suspected' | 'new_item' | 'negative_growth';

/** What a leaderboard row looks like on the wire. */
export interface LeaderboardEntry {
  rank: number;
  item: Pick<Item, 'source' | 'kind' | 'externalId' | 'displayName' | 'description' | 'url' | 'language' | 'topics' | 'primaryMetric'> & { id: string };
  window: Window;
  delta: number;
  relGrowth: number;
  score: number;            // finalScore for source boards, zScore for 'all'
  percentile: number;
  current: number;          // current level of primary metric (or last-day downloads)
  sparkline: number[];      // up to 30 points
  flags: ScoreFlag[];
}
```

### 5.1 SourceAdapter

```ts
// packages/sources/src/adapter.ts
import type { Logger } from '@trendr/logger';
import type { RedisTokenBucket } from '@trendr/core/rate-limit';
import type { Item, ItemKind, Metric, Source, Tier } from '@trendr/core';

/** Lightweight reference to an upstream item, before normalization. */
export interface DiscoveredRef {
  source: Source;
  kind: ItemKind;
  externalId: string;                 // canonical (see ids.ts)
  hint?: { reason: string; query?: string; rank?: number };
  raw?: unknown;                      // upstream payload if discovery already returned full data
}

/** Upstream payload + metrics for one item, as fetched (pre-normalization). */
export interface FetchedItem<TRaw = unknown> {
  ref: DiscoveredRef;
  raw: TRaw;                          // validated with the adapter's Zod schema
  fetchedAt: Date;
  notModified?: boolean;              // conditional request returned 304
  notFound?: boolean;                 // 404/410: mark item deleted/archived
}

export interface NormalizedItem {
  item: Omit<Item, 'id' | 'firstSeenAt' | 'lastSeenAt' | 'lastSnapshotAt' | 'tier' | 'flags' | 'latestMetrics'> & {
    flags?: Item['flags'];
  };
  /** Cumulative/gauge values observed now → `snapshots`. */
  snapshots: Array<{ metric: Metric; value: number }>;
  /** Per-day aggregates (npm/PyPI downloads) → `daily_metrics`. */
  daily: Array<{ metric: Metric; day: string; value: number }>;
  /** Cross-source links discovered from metadata → `item_aliases`. */
  aliases: Array<{ source: Source; kind: ItemKind; externalId: string; relation: AliasRelation; confidence: number; evidence: string }>;
}
export type AliasRelation = 'same_project' | 'package_of' | 'mcp_server_of' | 'paper_code' | 'model_of_paper' | 'registry_entry_of';

export interface AdapterContext {
  logger: Logger;
  bucket: RedisTokenBucket;           // per-source rate limiter (Section 7.4)
  signal: AbortSignal;                // job cancellation / shutdown
  now: () => Date;                    // injectable clock for tests
  runId: bigint;
}

export interface DiscoverOptions { since?: Date; maxItems: number; strategy?: string }
export interface FetchOptions { tier: Tier; includeDailyHistoryDays?: number }

export interface SourceAdapter<TRaw = unknown> {
  readonly source: Source;
  readonly kinds: readonly ItemKind[];
  /** Max refs per fetchMetrics() call (GraphQL batch 50, npm bulk 128, HF 1, PyPI 1, arXiv 100). */
  readonly batchSize: number;

  /** Find candidate items to add to (or refresh in) the tracked set. Must be paginated & bounded. */
  discover(ctx: AdapterContext, opts: DiscoverOptions): AsyncIterable<DiscoveredRef[]>;

  /** Fetch current metadata + metrics for a batch of known refs. Never throws for single-item 404s. */
  fetchMetrics(ctx: AdapterContext, refs: DiscoveredRef[], opts: FetchOptions): Promise<FetchedItem<TRaw>[]>;

  /** Pure function: upstream payload → canonical shape. No I/O. 100% unit-tested with fixtures. */
  normalize(fetched: FetchedItem<TRaw>): NormalizedItem | null;

  /** Optional: historical series for backfill (npm range, pypistats overall, GitHub stargazers). */
  backfill?(ctx: AdapterContext, ref: DiscoveredRef, days: number): Promise<NormalizedItem['daily']>;
}
```

### 5.2 Job payloads and queue names

```ts
// packages/core/src/queues.ts
import { z } from 'zod';
import { SourceSchema, TierSchema, WindowSchema } from './types.js';

export const QUEUE = {
  ingest: {
    github: 'ingest-github', npm: 'ingest-npm', pypi: 'ingest-pypi',
    huggingface: 'ingest-huggingface', arxiv: 'ingest-arxiv', mcp: 'ingest-mcp',
  },
  scoring: 'scoring',
  notify: 'notify',
  digest: 'digest',
  maintenance: 'maintenance',
  deadLetter: 'dead-letter',
} as const;  // BullMQ queue names must not contain ':'

export const IngestJobSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('discover'), source: SourceSchema, strategy: z.string(), maxItems: z.number().int().positive() }),
  z.object({ type: z.literal('snapshot'), source: SourceSchema, tier: TierSchema, batch: z.number().int().nonnegative(), batchCount: z.number().int().positive() }),
  z.object({ type: z.literal('daily'), source: SourceSchema, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ type: z.literal('backfill'), source: SourceSchema, itemId: z.string(), days: z.number().int().min(1).max(365) }),
  z.object({ type: z.literal('refresh-item'), source: SourceSchema, itemId: z.string() }),
]);
export type IngestJob = z.infer<typeof IngestJobSchema>;

export const ScoringJobSchema = z.object({
  source: SourceSchema,
  windows: z.array(WindowSchema).default(['24h', '7d', '30d']),
  trigger: z.enum(['schedule', 'ingest', 'admin']),
});
export const NotifyJobSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('evaluate-alerts'), scoreRunId: z.string(), source: SourceSchema }),
  z.object({ type: z.literal('send-alert-email'), alertEventId: z.string() }),
]);
export const DigestJobSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('build-weekly-digest'), weekStart: z.string() }),
  z.object({ type: z.literal('send-digest'), subscriptionId: z.string(), weekStart: z.string() }),
]);
export const MaintenanceJobSchema = z.object({
  type: z.enum(['create-partitions', 'retention', 'retier-items', 'rollup-daily', 'cleanup-tokens']),
});

/** Deterministic jobIds → BullMQ dedupes identical jobs (idempotency key). */
export const jobId = {
  snapshot: (s: string, tier: string, hourIso: string, batch: number) => `${s}.snapshot.${tier}.${hourIso}.${batch}`,
  daily: (s: string, day: string) => `${s}.daily.${day}`,
  discover: (s: string, strategy: string, slot: string) => `${s}.discover.${strategy}.${slot}`,
  scoring: (s: string, slot: string) => `score.${s}.${slot}`,       // slot = 10-min bucket
  sendDigest: (subId: string, week: string) => `digest.${subId}.${week}`,
  alertEmail: (eventId: string) => `alert.${eventId}`,
  evaluateAlerts: (scoreRunId: string) => `alerts.${scoreRunId}`,
};
// hourIso format is 'YYYY-MM-DDTHH' (UTC, no colons); slot for scoring = 'YYYY-MM-DDTHH-mm' floored to 10 min.
```

> BullMQ custom job ids must not contain `:`, so jobId builders use `.`. Never use pure integers as custom ids.

### 5.3 Errors

```ts
// packages/core/src/errors.ts
export abstract class AppError extends Error {
  abstract readonly status: number;
  abstract readonly type: string;       // RFC 7807 "type" suffix
  constructor(message: string, readonly details?: Record<string, unknown>) { super(message); }
}
export class NotFoundError extends AppError { status = 404; type = 'not-found'; }
export class ValidationError extends AppError { status = 400; type = 'validation-error'; }
export class UnauthorizedError extends AppError { status = 401; type = 'unauthorized'; }
export class ForbiddenError extends AppError { status = 403; type = 'forbidden'; }
export class ConflictError extends AppError { status = 409; type = 'conflict'; }
export class RateLimitedError extends AppError { status = 429; type = 'rate-limited'; }
/** Upstream error with retry semantics, used by workers (not exposed via API). */
export class UpstreamError extends Error {
  constructor(message: string, readonly source: string, readonly status: number | null,
              readonly retryAfterMs: number | null, readonly retryable: boolean) { super(message); }
}
```

### 5.4 Canonical external ids (`packages/core/src/ids.ts`)

| Source | Kind | `external_id` format | Example | `upstream_id` |
|---|---|---|---|---|
| github | repo | `owner/name`, lowercase | `vercel/next.js` | GraphQL `node_id` (survives renames) |
| npm | package | the package name as published (lowercase per npm rules) | `@modelcontextprotocol/sdk` | null |
| pypi | package | PEP 503 normalized: `re.sub(r"[-_.]+", "-", name).lower()` | `sentence-transformers` | null |
| huggingface | model/dataset/space | `{kind}s/{repo_id}` | `models/google/embeddinggemma-2` | HF `_id` |
| arxiv | paper | arXiv id without version | `2610.21185` | null |
| mcp | mcp_server | registry `server.name`; for servers found only outside the registry: `github:owner/name` or `npm:<pkg>` | `io.github.owner/server`, `github:acme/weather-mcp` | registry name (null otherwise) |

Renames: when a GitHub GraphQL batch returns an item whose `nameWithOwner` differs from `external_id`, update `external_id` and keep the old name as an alias row (`relation='same_project'`, `evidence='github_rename'`).

---

## 6. Database Schema

### 6.1 Conventions

- `bigint GENERATED ALWAYS AS IDENTITY` primary keys for high-volume tables; `uuid` (`gen_random_uuid()`) for user-facing entities (users, watchlists, alerts, api keys), so ids cannot be enumerated.
- All timestamps are `timestamptz` and in UTC. Days are `date` (UTC day).
- Every ingestion write is an `INSERT ... ON CONFLICT (natural key) DO UPDATE`. Natural keys are listed per table.
- Extensions: `pg_trgm`, `citext`, `pgcrypto` (for `gen_random_uuid`, built in since PG13, but enabling it is harmless).

### 6.2 Full SQL DDL (migration `0000_init.sql`)

```sql
-- 0000_init.sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE source_t      AS ENUM ('github','npm','pypi','huggingface','arxiv','mcp');
CREATE TYPE item_kind_t   AS ENUM ('repo','package','model','dataset','space','paper','mcp_server');
CREATE TYPE tier_t        AS ENUM ('hot','warm','cold','archived');
CREATE TYPE metric_t      AS ENUM ('stars','forks','watchers','open_issues','downloads','downloads_total',
                                   'likes','upvotes','trending_score','comments');
CREATE TYPE window_t      AS ENUM ('24h','7d','30d');
CREATE TYPE run_status_t  AS ENUM ('queued','running','succeeded','partial','failed','skipped');
CREATE TYPE job_type_t    AS ENUM ('discover','snapshot','daily','backfill','refresh-item','score','digest','maintenance');
CREATE TYPE alias_rel_t   AS ENUM ('same_project','package_of','mcp_server_of','paper_code','model_of_paper','registry_entry_of');
CREATE TYPE alert_type_t  AS ENUM ('velocity_spike','rank_entered','threshold_crossed','new_alias');
CREATE TYPE user_role_t   AS ENUM ('user','admin');
CREATE TYPE token_kind_t  AS ENUM ('magic_link','refresh');

-- ───────────── catalog ─────────────
CREATE TABLE items (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source              source_t     NOT NULL,
  kind                item_kind_t  NOT NULL,
  external_id         text         NOT NULL,
  upstream_id         text,
  name                text         NOT NULL,
  display_name        text         NOT NULL,
  description         text,
  url                 text         NOT NULL,
  homepage            text,
  language            text,
  license             text,
  owner               text,
  primary_metric      metric_t     NOT NULL,
  latest_metrics      jsonb        NOT NULL DEFAULT '{}'::jsonb,
  metadata            jsonb        NOT NULL DEFAULT '{}'::jsonb,
  tier                tier_t       NOT NULL DEFAULT 'cold',
  flags               text[]       NOT NULL DEFAULT '{}',
  is_archived         boolean      NOT NULL DEFAULT false,
  is_deleted          boolean      NOT NULL DEFAULT false,
  upstream_created_at timestamptz,
  first_seen_at       timestamptz  NOT NULL DEFAULT now(),
  last_seen_at        timestamptz  NOT NULL DEFAULT now(),
  last_snapshot_at    timestamptz,
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  search_tsv          tsvector GENERATED ALWAYS AS (
                        setweight(to_tsvector('simple', coalesce(display_name,'')), 'A') ||
                        setweight(to_tsvector('english', coalesce(description,'')), 'B')
                      ) STORED,
  CONSTRAINT items_source_external_uq UNIQUE (source, external_id)
);
CREATE UNIQUE INDEX items_source_upstream_uq ON items (source, upstream_id) WHERE upstream_id IS NOT NULL;
CREATE INDEX items_tier_idx          ON items (source, tier) WHERE NOT is_deleted;
CREATE INDEX items_language_idx      ON items (language) WHERE language IS NOT NULL;
CREATE INDEX items_search_idx        ON items USING gin (search_tsv);
CREATE INDEX items_name_trgm_idx     ON items USING gin (display_name gin_trgm_ops);
CREATE INDEX items_created_idx       ON items (source, upstream_created_at DESC);

CREATE TABLE item_aliases (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id       bigint      NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  alias_item_id bigint      NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  relation      alias_rel_t NOT NULL,
  confidence    real        NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence      text        NOT NULL,           -- e.g. 'npm.repository.url', 'mcp.registry.packages', 'hf.paper.githubRepo'
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_aliases_no_self CHECK (item_id <> alias_item_id),
  CONSTRAINT item_aliases_uq UNIQUE (item_id, alias_item_id, relation)
);
CREATE INDEX item_aliases_alias_idx ON item_aliases (alias_item_id);

CREATE TABLE topics (
  id    int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug  text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,49}$'),
  name  text NOT NULL,
  item_count int NOT NULL DEFAULT 0          -- maintained by retier-items job
);
CREATE TABLE item_topics (
  item_id  bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  topic_id int    NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, topic_id)
);
CREATE INDEX item_topics_topic_idx ON item_topics (topic_id, item_id);

-- ───────────── time series ─────────────
-- snapshots: see 0001_partitions.sql (partitioned by month)

CREATE TABLE daily_metrics (
  item_id bigint   NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  metric  metric_t NOT NULL,
  day     date     NOT NULL,
  value   bigint   NOT NULL CHECK (value >= 0),
  PRIMARY KEY (item_id, metric, day)
);
CREATE INDEX daily_metrics_day_idx ON daily_metrics (day);

-- ───────────── ops / audit ─────────────
CREATE TABLE ingestion_runs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source        source_t,                       -- null for cross-source jobs (digest, maintenance)
  job_type      job_type_t   NOT NULL,
  job_id        text         NOT NULL,          -- BullMQ job id (idempotency key)
  attempt       int          NOT NULL DEFAULT 1,
  status        run_status_t NOT NULL DEFAULT 'running',
  params        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  started_at    timestamptz  NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  items_seen    int NOT NULL DEFAULT 0,
  items_upserted int NOT NULL DEFAULT 0,
  items_failed  int NOT NULL DEFAULT 0,
  api_calls     int NOT NULL DEFAULT 0,
  not_modified  int NOT NULL DEFAULT 0,          -- 304 responses (GitHub ETag)
  rate_limit_remaining int,
  error         text,
  CONSTRAINT ingestion_runs_job_attempt_uq UNIQUE (job_id, attempt)
);
CREATE INDEX ingestion_runs_source_started_idx ON ingestion_runs (source, started_at DESC);
CREATE INDEX ingestion_runs_status_idx ON ingestion_runs (status) WHERE status IN ('running','failed');

CREATE TABLE scores (
  item_id         bigint    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  "window"        window_t  NOT NULL,
  run_id          bigint    NOT NULL REFERENCES ingestion_runs(id),
  source          source_t  NOT NULL,
  computed_at     timestamptz NOT NULL,
  delta           double precision NOT NULL,
  base            double precision NOT NULL,
  rel_growth      double precision NOT NULL,
  raw_score       double precision NOT NULL,
  age_factor      double precision NOT NULL,
  confidence      double precision NOT NULL,
  anomaly_penalty double precision NOT NULL,
  final_score     double precision NOT NULL,
  z_score         double precision NOT NULL,
  percentile      double precision NOT NULL,
  rank_source     int,
  rank_all        int,
  flags           text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (item_id, "window", run_id)
);
CREATE INDEX scores_board_idx ON scores (source, "window", run_id, final_score DESC);  -- also serves per-run deletes (6.5)
CREATE INDEX scores_item_time_idx ON scores (item_id, "window", computed_at DESC);
-- Only eligible rows (final_score > 0) are inserted (8.4). Not partitioned: see 6.5 for volume and retention.

-- Pointer to the current scoring run per (source, window); swapped atomically after a run.
CREATE TABLE score_runs_current (
  source   source_t NOT NULL,
  "window" window_t NOT NULL,
  run_id   bigint   NOT NULL REFERENCES ingestion_runs(id),
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (source, "window")
);

-- ───────────── users & auth ─────────────
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext NOT NULL UNIQUE,
  display_name      text,
  role              user_role_t NOT NULL DEFAULT 'user',
  email_verified_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_login_at     timestamptz
);

CREATE TABLE auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        token_kind_t NOT NULL,
  token_hash  bytea NOT NULL UNIQUE,          -- sha256(token); raw token never stored
  family_id   uuid,                           -- refresh-token rotation family (reuse detection)
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_ip  inet,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id, kind);
CREATE INDEX auth_tokens_expiry_idx ON auth_tokens (expires_at);

CREATE TABLE api_keys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             text NOT NULL,
  prefix           text NOT NULL UNIQUE,       -- 'dt_live_' + 8 chars, shown in UI
  key_hash         bytea NOT NULL UNIQUE,      -- HMAC-SHA256(API_KEY_PEPPER, full key)
  scopes           text[] NOT NULL DEFAULT '{read}',   -- read | admin
  rate_limit_per_min int NOT NULL DEFAULT 120,
  last_used_at     timestamptz,
  expires_at       timestamptz,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_keys_user_name_uq UNIQUE (user_id, name)
);

-- ───────────── engagement ─────────────
CREATE TABLE watchlists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT watchlists_user_name_uq UNIQUE (user_id, name)
);
CREATE UNIQUE INDEX watchlists_one_default ON watchlists (user_id) WHERE is_default;

CREATE TABLE watchlist_items (
  watchlist_id uuid   NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  item_id      bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (watchlist_id, item_id)
);
CREATE INDEX watchlist_items_item_idx ON watchlist_items (item_id);

CREATE TABLE alerts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              alert_type_t NOT NULL,
  item_id           bigint REFERENCES items(id) ON DELETE CASCADE,
  watchlist_id      uuid REFERENCES watchlists(id) ON DELETE CASCADE,
  "window"          window_t NOT NULL DEFAULT '24h',
  params            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- validated by AlertParamsSchema (Section 13)
  cooldown_hours    int NOT NULL DEFAULT 24 CHECK (cooldown_hours BETWEEN 1 AND 720),
  enabled           boolean NOT NULL DEFAULT true,
  last_triggered_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alerts_target_ck CHECK (
    (type = 'rank_entered' AND item_id IS NULL AND watchlist_id IS NULL)   -- filter in params
    OR (type <> 'rank_entered' AND num_nonnulls(item_id, watchlist_id) = 1)
  )
);
CREATE INDEX alerts_item_idx ON alerts (item_id) WHERE enabled;
CREATE INDEX alerts_watchlist_idx ON alerts (watchlist_id) WHERE enabled;
CREATE INDEX alerts_type_idx ON alerts (type) WHERE enabled;

CREATE TABLE alert_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id        uuid   NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  item_id         bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  score_run_id    bigint NOT NULL REFERENCES ingestion_runs(id),
  dedupe_key      text   NOT NULL UNIQUE,      -- alert_id:item_id:window:cooldown_bucket
  payload         jsonb  NOT NULL,
  triggered_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  delivery_status text NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','sent','failed','suppressed'))
);
CREATE INDEX alert_events_pending_idx ON alert_events (delivery_status) WHERE delivery_status = 'pending';

CREATE TABLE digest_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  sources       source_t[] NOT NULL DEFAULT '{github,npm,pypi,huggingface,arxiv,mcp}',
  topics        text[] NOT NULL DEFAULT '{}',
  include_watchlist boolean NOT NULL DEFAULT true,
  day_of_week   smallint NOT NULL DEFAULT 1 CHECK (day_of_week BETWEEN 0 AND 6),  -- 0=Sun
  enabled       boolean NOT NULL DEFAULT true,
  unsubscribed_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE digest_sends (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id     uuid NOT NULL REFERENCES digest_subscriptions(id) ON DELETE CASCADE,
  week_start          date NOT NULL,                -- Monday (UTC) of the digest week
  status              text NOT NULL CHECK (status IN ('pending','sent','failed','skipped')),
  provider_message_id text,
  sent_at             timestamptz,
  CONSTRAINT digest_sends_uq UNIQUE (subscription_id, week_start)
);

-- Stretch: transactional outbox (Section 19)
CREATE TABLE outbox_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate     text NOT NULL,                 -- 'leaderboard' | 'alert'
  event_type    text NOT NULL,                 -- 'leaderboard.updated' | 'alert.triggered'
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;
```

### 6.3 Partitioned `snapshots` (migration `0001_partitions.sql`)

```sql
-- 0001_partitions.sql
CREATE TABLE snapshots (
  item_id     bigint      NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  metric      metric_t    NOT NULL,
  captured_at timestamptz NOT NULL,             -- bucket start (hour or day)
  observed_at timestamptz NOT NULL DEFAULT now(),
  value       bigint      NOT NULL CHECK (value >= 0),
  run_id      bigint,
  PRIMARY KEY (item_id, metric, captured_at)    -- partition key included → valid unique key
) PARTITION BY RANGE (captured_at);

CREATE TABLE snapshots_default PARTITION OF snapshots DEFAULT;

-- Every session on this database defaults to UTC (date ↔ timestamptz casts, e.g. in rollup-daily, depend on it).
DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC'); END $$;

-- Creates monthly partitions [month_start, next_month) in UTC for N months back/ahead; idempotent.
-- Bounds are rendered as explicit '+00' literals, so they are UTC midnights whatever the session TimeZone is.
CREATE OR REPLACE FUNCTION ensure_snapshot_partitions(months_back int, months_ahead int)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  m    timestamp;   -- month start as UTC wall-clock time (timestamp WITHOUT time zone)
  lo   text;        -- e.g. '2026-10-01 00:00:00+00'
  hi   text;        -- e.g. '2026-11-01 00:00:00+00'
  part text;
BEGIN
  FOR i IN -months_back..months_ahead LOOP
    m    := date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i);
    part := format('snapshots_%s', to_char(m, 'YYYY_MM'));
    lo   := to_char(m, 'YYYY-MM-DD HH24:MI:SS') || '+00';
    hi   := to_char(m + interval '1 month', 'YYYY-MM-DD HH24:MI:SS') || '+00';
    IF to_regclass(part) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF snapshots FOR VALUES FROM (%L::timestamptz) TO (%L::timestamptz)',
        part, lo, hi);
      EXECUTE format('CREATE INDEX %I ON %I USING brin (captured_at)', part || '_brin', part);
    END IF;
  END LOOP;
END $$;

SELECT ensure_snapshot_partitions(2, 3);

-- Retention: drops whole partitions older than keep_months (O(1), no vacuum bloat).
CREATE OR REPLACE FUNCTION drop_old_snapshot_partitions(keep_months int)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  r record; dropped int := 0;
  cutoff date := (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => keep_months))::date;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'snapshots' AND c.relname ~ '^snapshots_\d{4}_\d{2}$'
  LOOP
    IF to_date(substr(r.relname, 11), 'YYYY_MM') < cutoff THEN
      EXECUTE format('DROP TABLE %I', r.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END $$;
```

The `maintenance:create-partitions` job runs daily and calls `ensure_snapshot_partitions(0, 3)`. The `snapshots_default` partition must stay empty, because rows there block creating a partition for that range. Enforcement: after creating partitions, the same job runs `SELECT count(*) FROM snapshots_default` and sets the gauge `trendr_snapshots_default_rows` (14.1); the Prometheus alert `SnapshotsDefaultNotEmpty` (14.2) fires when it is `> 0`.

**Time zone:** all partition math is UTC. The DB session `TimeZone` is UTC by three independent means: the server setting `timezone = 'UTC'` (compose `command: ["postgres", "-c", "timezone=UTC"]`, 17.1), the `ALTER DATABASE ... SET timezone` above (covers Neon and other managed hosts where server flags are not available), and the explicit `+00` bound literals inside `ensure_snapshot_partitions`. An integration test (1.2) asserts `SHOW TimeZone` = `UTC` and that partition bounds are UTC midnights even in a session with `SET TimeZone = 'Asia/Kolkata'`.

**Idempotent snapshot upsert** (bulk, run by `apps/worker/src/ingestion/upsert.ts`):

```sql
INSERT INTO snapshots (item_id, metric, captured_at, observed_at, value, run_id)
SELECT * FROM unnest($1::bigint[], $2::metric_t[], $3::timestamptz[], $4::timestamptz[], $5::bigint[], $6::bigint[])
ON CONFLICT (item_id, metric, captured_at)
DO UPDATE SET value = EXCLUDED.value, observed_at = EXCLUDED.observed_at, run_id = EXCLUDED.run_id
WHERE snapshots.observed_at < EXCLUDED.observed_at;   -- last-writer-wins by observation time
```

Then the same transaction updates `items.latest_metrics`, `items.last_snapshot_at`, and `items.last_seen_at`.

**Daily rollup** (`maintenance:rollup-daily`, 00:20 UTC) writes the end-of-day level for cumulative metrics:

```sql
INSERT INTO daily_metrics (item_id, metric, day, value)
SELECT DISTINCT ON (item_id, metric) item_id, metric, $1::date, value
FROM snapshots
WHERE captured_at >= $1::date AND captured_at < $1::date + 1
  AND metric IN ('stars','forks','likes','upvotes','downloads_total','comments','watchers')
ORDER BY item_id, metric, captured_at DESC
ON CONFLICT (item_id, metric, day) DO UPDATE SET value = EXCLUDED.value;
```

### 6.4 Drizzle schema (excerpt; the full schema mirrors 6.2 one-to-one)

```ts
// packages/db/src/schema/enums.ts
import { pgEnum } from 'drizzle-orm/pg-core';
import { SOURCES, ITEM_KINDS, TIERS, METRICS, WINDOWS } from '@trendr/core';
export const sourceEnum = pgEnum('source_t', SOURCES);
export const itemKindEnum = pgEnum('item_kind_t', ITEM_KINDS);
export const tierEnum = pgEnum('tier_t', TIERS);
export const metricEnum = pgEnum('metric_t', METRICS);
export const windowEnum = pgEnum('window_t', WINDOWS);
export const runStatusEnum = pgEnum('run_status_t', ['queued', 'running', 'succeeded', 'partial', 'failed', 'skipped']);
export const jobTypeEnum = pgEnum('job_type_t', ['discover', 'snapshot', 'daily', 'backfill', 'refresh-item', 'score', 'digest', 'maintenance']);
export const aliasRelEnum = pgEnum('alias_rel_t', ['same_project', 'package_of', 'mcp_server_of', 'paper_code', 'model_of_paper', 'registry_entry_of']);
export const alertTypeEnum = pgEnum('alert_type_t', ['velocity_spike', 'rank_entered', 'threshold_crossed', 'new_alias']);
export const userRoleEnum = pgEnum('user_role_t', ['user', 'admin']);
export const tokenKindEnum = pgEnum('token_kind_t', ['magic_link', 'refresh']);
```

```ts
// packages/db/src/schema/items.ts
import { sql } from 'drizzle-orm';
import { bigint, boolean, customType, index, integer, jsonb, pgTable, primaryKey, real, text,
         timestamp, unique, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { itemKindEnum, metricEnum, sourceEnum, tierEnum, aliasRelEnum } from './enums.js';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const items = pgTable('items', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
  source: sourceEnum('source').notNull(),
  kind: itemKindEnum('kind').notNull(),
  externalId: text('external_id').notNull(),
  upstreamId: text('upstream_id'),
  name: text('name').notNull(),
  displayName: text('display_name').notNull(),
  description: text('description'),
  url: text('url').notNull(),
  homepage: text('homepage'),
  language: text('language'),
  license: text('license'),
  owner: text('owner'),
  primaryMetric: metricEnum('primary_metric').notNull(),
  latestMetrics: jsonb('latest_metrics').$type<Partial<Record<string, number>>>().notNull().default({}),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  tier: tierEnum('tier').notNull().default('cold'),
  flags: text('flags').array().notNull().default(sql`'{}'`),
  isArchived: boolean('is_archived').notNull().default(false),
  isDeleted: boolean('is_deleted').notNull().default(false),
  upstreamCreatedAt: timestamp('upstream_created_at', { withTimezone: true }),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSnapshotAt: timestamp('last_snapshot_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  searchTsv: tsvector('search_tsv').generatedAlwaysAs(sql`setweight(to_tsvector('simple', coalesce(display_name,'')), 'A') || setweight(to_tsvector('english', coalesce(description,'')), 'B')`),
}, (t) => [
  unique('items_source_external_uq').on(t.source, t.externalId),
  uniqueIndex('items_source_upstream_uq').on(t.source, t.upstreamId).where(sql`upstream_id IS NOT NULL`),
  index('items_tier_idx').on(t.source, t.tier).where(sql`NOT is_deleted`),
  index('items_search_idx').using('gin', t.searchTsv),
  index('items_name_trgm_idx').using('gin', sql`display_name gin_trgm_ops`),
]);

export const itemAliases = pgTable('item_aliases', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
  itemId: bigint('item_id', { mode: 'bigint' }).notNull().references(() => items.id, { onDelete: 'cascade' }),
  aliasItemId: bigint('alias_item_id', { mode: 'bigint' }).notNull().references(() => items.id, { onDelete: 'cascade' }),
  relation: aliasRelEnum('relation').notNull(),
  confidence: real('confidence').notNull(),
  evidence: text('evidence').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('item_aliases_uq').on(t.itemId, t.aliasItemId, t.relation),
  check('item_aliases_no_self', sql`${t.itemId} <> ${t.aliasItemId}`),
  index('item_aliases_alias_idx').on(t.aliasItemId),
]);

export const topics = pgTable('topics', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  itemCount: integer('item_count').notNull().default(0),
});
export const itemTopics = pgTable('item_topics', {
  itemId: bigint('item_id', { mode: 'bigint' }).notNull().references(() => items.id, { onDelete: 'cascade' }),
  topicId: integer('topic_id').notNull().references(() => topics.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.itemId, t.topicId] }), index('item_topics_topic_idx').on(t.topicId, t.itemId)]);
```

```ts
// packages/db/src/schema/metrics.ts
import { bigint, date, doublePrecision, index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { metricEnum, sourceEnum, windowEnum } from './enums.js';
import { items } from './items.js';
import { ingestionRuns } from './ops.js';

/** Declared for typing only. DDL lives in migrations/0001_partitions.sql (PARTITION BY RANGE). */
export const snapshots = pgTable('snapshots', {
  itemId: bigint('item_id', { mode: 'bigint' }).notNull(),
  metric: metricEnum('metric').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  value: bigint('value', { mode: 'number' }).notNull(),
  runId: bigint('run_id', { mode: 'bigint' }),
}, (t) => [primaryKey({ columns: [t.itemId, t.metric, t.capturedAt] })]);

export const dailyMetrics = pgTable('daily_metrics', {
  itemId: bigint('item_id', { mode: 'bigint' }).notNull().references(() => items.id, { onDelete: 'cascade' }),
  metric: metricEnum('metric').notNull(),
  day: date('day', { mode: 'string' }).notNull(),
  value: bigint('value', { mode: 'number' }).notNull(),
}, (t) => [primaryKey({ columns: [t.itemId, t.metric, t.day] }), index('daily_metrics_day_idx').on(t.day)]);

export const scores = pgTable('scores', {
  itemId: bigint('item_id', { mode: 'bigint' }).notNull().references(() => items.id, { onDelete: 'cascade' }),
  window: windowEnum('window').notNull(),
  runId: bigint('run_id', { mode: 'bigint' }).notNull().references(() => ingestionRuns.id),
  source: sourceEnum('source').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  delta: doublePrecision('delta').notNull(),
  base: doublePrecision('base').notNull(),
  relGrowth: doublePrecision('rel_growth').notNull(),
  rawScore: doublePrecision('raw_score').notNull(),
  ageFactor: doublePrecision('age_factor').notNull(),
  confidence: doublePrecision('confidence').notNull(),
  anomalyPenalty: doublePrecision('anomaly_penalty').notNull(),
  finalScore: doublePrecision('final_score').notNull(),
  zScore: doublePrecision('z_score').notNull(),
  percentile: doublePrecision('percentile').notNull(),
  rankSource: integer('rank_source'),
  rankAll: integer('rank_all'),
  flags: text('flags').array().notNull().default(sql`'{}'`),
}, (t) => [
  primaryKey({ columns: [t.itemId, t.window, t.runId] }),
  index('scores_board_idx').on(t.source, t.window, t.runId, t.finalScore.desc()),
  index('scores_item_time_idx').on(t.itemId, t.window, t.computedAt.desc()),
]);

export const scoreRunsCurrent = pgTable('score_runs_current', {
  source: sourceEnum('source').notNull(),
  window: windowEnum('window').notNull(),
  runId: bigint('run_id', { mode: 'bigint' }).notNull().references(() => ingestionRuns.id),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.source, t.window] })]);
```

`users.ts`, `engagement.ts` and `ops.ts` follow 6.2 column for column (the agent writes them mechanically). Migration workflow: `drizzle-kit generate` produces `0000_init.sql` from the TS schema. **Then hand-check it against 6.2**: generated columns, partial indexes and CHECK constraints must match. `0001_partitions.sql` is hand-written and added with `drizzle-kit generate --custom --name partitions`. Exclude `snapshots` from drizzle-kit's diffing with `tablesFilter: ['!snapshots*']` in `drizzle.config.ts`, so kit never tries to recreate it.

### 6.5 Retention policy

| Data | Keep | Mechanism |
|---|---|---|
| `snapshots` (hourly/daily raw) | `SNAPSHOT_RETENTION_MONTHS` (default 3; 1 on Neon free) | `drop_old_snapshot_partitions()` in `maintenance:retention`, daily 03:30 UTC |
| `daily_metrics` | Forever (≈ 50k items × 3 metrics × 365 ≈ 55M rows/yr, about 3–4 GB). On a small DB, keep 400 days. | `DELETE ... WHERE day < now() - interval '400 days'` in batches of 10k |
| `scores` | Eligible rows only (8.4). **Every** run for `SCORES_HOURLY_RETENTION_HOURS` (default 48); after that, **one run per (source, window, UTC day)**, the last run of that day, for `SCORES_DAILY_RETENTION_DAYS` (default 365). The current run in `score_runs_current` is never deleted. | `maintenance:retention` (daily 03:30 UTC), SQL below, deleting one (source, window, run) at a time |
| `ingestion_runs` | 30 days (runs referenced by kept `scores` are retained) | Batched delete |
| `alert_events` | 180 days | Batched delete |
| `auth_tokens` | Delete 7 days after expiry | `maintenance:cleanup-tokens` |
| Redis `lb:*` | Overwritten every scoring run; TTL 6 h as a safety net | Section 9 |

**`scores` retention SQL** (`packages/db/src/repositories/scores.repo.ts` → `pruneScores(hourlyHours, dailyDays)`, called by `maintenance:retention`). Step 1 is cheap because it reads only `ingestion_runs` (a few thousand rows) and probes `scores_board_idx`; step 2 deletes per (source, window, run), so each statement is short and touches one index range.

```sql
-- Step 1: list the (source, window, run) groups to delete.
-- $1 = SCORES_HOURLY_RETENTION_HOURS, $2 = SCORES_DAILY_RETENTION_DAYS
WITH runs AS (            -- scoring runs past the hourly horizon that still have rows for a window
  SELECT r.id AS run_id, r.source, w."window", r.started_at,
         (r.started_at AT TIME ZONE 'UTC')::date AS utc_day
  FROM ingestion_runs r
  CROSS JOIN unnest(enum_range(NULL::window_t)) AS w("window")
  WHERE r.job_type = 'score'
    AND r.started_at < now() - make_interval(hours => $1)
    AND EXISTS (SELECT 1 FROM scores s
                WHERE s.source = r.source AND s."window" = w."window" AND s.run_id = r.id)
),
daily_keep AS (           -- the last run of each UTC day per (source, window), inside the daily horizon
  SELECT DISTINCT ON (source, "window", utc_day) run_id, source, "window"
  FROM runs
  WHERE started_at >= now() - make_interval(days => $2)
  ORDER BY source, "window", utc_day, started_at DESC, run_id DESC
)
SELECT run_id, source, "window" FROM runs
EXCEPT SELECT run_id, source, "window" FROM daily_keep
EXCEPT SELECT run_id, source, "window" FROM score_runs_current;   -- never delete a live board

-- Step 2: for each returned group, in its own short transaction:
DELETE FROM scores WHERE source = $1 AND "window" = $2 AND run_id = $3;
```

Runs older than the daily horizon fall out of `daily_keep` and are deleted whole. A UTC day is complete long before it crosses the 48 h horizon, so the "last run of the day" is final when it is chosen. `ingestion_runs` rows referenced by kept `scores` stay (row above). Afterwards the job logs the deleted row count. `scores` is **not partitioned**: thinning keeps one run per day inside every day, so dropping day or month partitions could not replace the per-run `DELETE`, and the year-end cut (one run per (source, window) per day, about 64k rows) is small. Set `autovacuum_vacuum_scale_factor = 0.02` on `scores` (in the migration) so space freed by the daily thinning (about 1.5M rows/day at the defaults) is reused quickly. Revisit monthly partitioning by `computed_at` only if the delete step takes longer than 5 minutes (record it in an ADR).

**Capacity estimate** (row sizes include tuple header and alignment; indexes at ~75% fill):

| Table | Worked numbers (defaults) | Steady state |
|---|---|---|
| `snapshots` | 2k hot × 24 + 3k warm × 4 + 45k cold × 1 ≈ 105k buckets/day × ~2.2 metrics ≈ 230k rows/day ≈ 7M rows/month ≈ 0.6 GB/month incl. PK | × 3 months ≈ **1.8 GB** |
| `daily_metrics` | ≈ 50k items × 3 metrics × 400 days ≈ 60M rows × ~65 B | ≈ **3.9 GB** (400-day cap) |
| `scores` | Scoreable items N ≈ 85k (Σ `TRACKED_MAX_*` = 75k + arXiv ≈ 6k + MCP ≈ 4k). Eligible fraction e ≈ 0.25 (assumed 20–30%; 24h boards are sparser, 30d denser). Rows per scoring cycle (all sources, 3 windows) = 85k × 3 × 0.25 ≈ **64k**. Hourly tier: 24 runs/day × 2 days × 64k ≈ 3.1M rows. Daily tier: 365 × 64k ≈ 23.3M rows. Row ≈ 190 B heap + ≈ 135 B for the 3 B-tree indexes ≈ 325 B | 3.1M × 325 B ≈ 1.0 GB + 23.3M × 325 B ≈ 7.6 GB ≈ **8.6 GB** (v1.0 policy, every row for 30 days: 85k × 3 × 24 × 30 ≈ 184M rows ≈ 60 GB) |
| everything else | items, aliases, runs, users, alerts | < **0.5 GB** |
| **Total** | | ≈ **15 GB** |

**Fits the 2 vCPU / 4 GB VPS** (17.6, Postgres container capped at 1 GB RAM with `shared_buffers=256MB`): disk use of ≈ 15 GB fits the 40 GB SSD of that class with room for WAL and a local dump. Memory is fine because the hot working set is small: the current run (≈ 64k rows ≈ 20 MB), the last 48 h of runs for cursors and alerts (≈ 1 GB on disk, read by index range), and the current snapshot partition. The daily tier is read only by `/v1/items/:id/scores` (one index range per item via `scores_item_time_idx`).

**Neon free (≈ 0.5 GB storage):** set `TRACKED_MAX_GITHUB=5000`, `TRACKED_MAX_NPM=2000`, `TRACKED_MAX_PYPI=500`, `TRACKED_MAX_HUGGINGFACE=2000`, `SNAPSHOT_RETENTION_MONTHS=1`, `SCORES_HOURLY_RETENTION_HOURS=24`, `SCORES_DAILY_RETENTION_DAYS=30`. Then N ≈ 12.5k (incl. ≈ 2k papers, ≈ 1k MCP), rows/cycle ≈ 12.5k × 3 × 0.25 ≈ 9.4k, `scores` ≈ (24 × 9.4k + 30 × 9.4k) ≈ 0.51M rows ≈ **0.17 GB**; `snapshots` (1 month at this size) ≈ 0.15 GB; `daily_metrics` must be held to ≈ 90 days (≈ 12.5k × 2 metrics × 90 ≈ 2.3M rows ≈ 0.15 GB; 60 days is the minimum the 30d download window needs). Total ≈ 0.5 GB: workable for a demo, with no headroom.

### 6.6 Optional TimescaleDB variant

When `TIMESCALE_ENABLED=true` (image `timescale/timescaledb:latest-pg16`), apply `0001_partitions.timescale.sql` instead:

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE TABLE snapshots ( /* same columns, same PK */ );
SELECT create_hypertable('snapshots', by_range('captured_at', INTERVAL '7 days'));
ALTER TABLE snapshots SET (timescaledb.compress, timescaledb.compress_segmentby = 'item_id, metric');
SELECT add_compression_policy('snapshots', INTERVAL '14 days');
SELECT add_retention_policy('snapshots', INTERVAL '90 days');
-- Optional continuous aggregate replacing rollup-daily:
CREATE MATERIALIZED VIEW snapshots_daily WITH (timescaledb.continuous) AS
SELECT item_id, metric, time_bucket('1 day', captured_at) AS day, last(value, captured_at) AS value
FROM snapshots GROUP BY 1, 2, 3;
```

Application code does not change; only the maintenance job skips partition functions when Timescale is enabled. Neon does not support the Timescale extension in managed form (verify), which is why plain partitioning is the default.

---

## 7. Ingestion Design (per source)

### 7.1 General pipeline

Every ingest job follows the same flow, implemented once in `apps/worker/src/processors/ingest.processor.ts`:

1. Parse the payload with `IngestJobSchema`. On failure, throw `UnrecoverableError` and send the job to the DLQ.
2. `runRecorder.start()` inserts into `ingestion_runs (job_id, attempt, source, job_type, params)`.
3. Resolve the adapter with `getAdapter(source)` and build an `AdapterContext` (logger child with `runId` and `jobId`, token bucket, abort signal).
4. By job type:
   - `discover`: iterate `adapter.discover()`. For each page, upsert minimal `items` rows (tier `warm` for new items) and enqueue `backfill` for items that need history (npm, PyPI, small GitHub repos).
   - `snapshot`: select the batch of tracked items for `(source, tier)` using `ORDER BY id` and `id % batchCount = batch`. Chunk by `adapter.batchSize`, call `fetchMetrics` and then `normalize`, and upsert.
   - `daily`: as `snapshot`, but only the daily series (npm, PyPI).
   - `backfill` / `refresh-item`: a single item.
5. Bulk upsert in one transaction per chunk: `items` (metadata), `item_topics`, `snapshots`, `daily_metrics`, then alias resolution (`item_aliases`, creating stub items for unseen alias targets with tier `cold`). Topic normalization (`packages/core/src/topics.ts`) maps GitHub topics, npm keywords, PyPI classifiers/keywords, HF `pipeline_tag`/`library_name`/tags and arXiv categories (`cs.CL` → `nlp`, `cs.CV` → `computer-vision`, `cs.LG` → `machine-learning`, `cs.AI` → `ai`) to slugs matching `^[a-z0-9][a-z0-9-]{0,49}$`. A synonym table (`mcp-server`, `model-context-protocol` → `mcp`; `llms` → `llm`) keeps topics comparable across sources. Each item keeps at most 20 topics.
6. `runRecorder.finish()` sets status `succeeded`, `partial` (some items failed) or `failed`, plus counters and the last observed `rate_limit_remaining`.
7. On success of `snapshot` or `daily`, enqueue `scoring` with `jobId = score.{source}.{10-min slot}` (debounced).

Per-item errors (404, schema mismatch) are counted and logged but do not fail the job. If more than 50% of items fail, or a systemic error occurs (auth, network, rate limit), the job throws and BullMQ retries it.

### 7.2 Schedules (all cron expressions in UTC; registered with `queue.upsertJobScheduler`)

| Scheduler id | Queue / job | Cron | Notes |
|---|---|---|---|
| `gh-discover-new` | `ingest-github` discover `new-hot` | `*/30 * * * *` | Repos created in the last 7 days |
| `gh-discover-rising` | `ingest-github` discover `rising` | `10 */2 * * *` | Created in the last 30 days, ≥ 100 stars |
| `gh-discover-topics` | `ingest-github` discover `topics` | `20 */3 * * *` | Topic list (7.3.1) |
| `gh-snapshot-hot` | `ingest-github` snapshot hot | `5 * * * *` | Fan-out into N batch jobs |
| `gh-snapshot-warm` | `ingest-github` snapshot warm | `15 */6 * * *` | |
| `gh-snapshot-cold` | `ingest-github` snapshot cold | `30 1 * * *` | Spread across 01:30–04:00 via delayed batches |
| `npm-discover` | `ingest-npm` discover `keywords` | `0 */6 * * *` | |
| `npm-daily` | `ingest-npm` daily | `30 2 * * *`, retry `0 6 * * *` | npm stats land soon after UTC midnight |
| `pypi-discover` | `ingest-pypi` discover `rss` | `*/30 * * * *` | RSS newest and updates |
| `pypi-daily` | `ingest-pypi` daily | `0 5 * * *`, retry `0 11 * * *` | pypistats updates once per day (exact time: verify) |
| `hf-discover` | `ingest-huggingface` discover `trending` | `0 * * * *` | |
| `hf-snapshot-hot` | `ingest-huggingface` snapshot hot | `10 * * * *` | |
| `hf-snapshot-warm` | `ingest-huggingface` snapshot warm | `40 */6 * * *` | |
| `hf-snapshot-cold` | `ingest-huggingface` snapshot cold | `45 2 * * *` | |
| `arxiv-discover` | `ingest-arxiv` discover `new-listings` | `0 3 * * *` | Once per day (results change only daily) |
| `arxiv-snapshot` | `ingest-arxiv` snapshot hot | `20 * * * *` | HF upvotes for papers ≤ 30 days old |
| `mcp-discover` | `ingest-mcp` discover `registry` | `0 */2 * * *` | Incremental `updated_since` |
| `mcp-discover-full` | `ingest-mcp` discover `full` | `30 0 * * 0` | Weekly full registry resync (catches missed deletes) |
| `mcp-discover-gh-npm` | `ingest-mcp` discover `github-npm` | `50 */6 * * *` | GitHub topic plus npm keyword |
| `mcp-snapshot` | `ingest-mcp` snapshot hot | `25 * * * *` | Derived from aliases (no upstream calls) |
| `score-safety` | `scoring` compute-scores (per source) | `40 * * * *` | Safety net in addition to ingest-triggered runs |
| `rollup-daily` | `maintenance` rollup-daily | `20 0 * * *` | |
| `create-partitions` | `maintenance` create-partitions | `0 1 * * *` | |
| `retention` | `maintenance` retention | `30 3 * * *` | |
| `retier-items` | `maintenance` retier-items | `0 5 * * *` | |
| `cleanup-tokens` | `maintenance` cleanup-tokens | `0 4 * * 0` | |
| `digest-daily` | `digest` build-weekly-digest | `0 8 * * *` | Picks subscriptions whose `day_of_week` = today |

```ts
// apps/worker/src/scheduler.ts (excerpt)
import { queues } from './queues.js';
export async function registerSchedulers(): Promise<void> {
  await queues.ingest.github.upsertJobScheduler(
    'gh-snapshot-hot',
    { pattern: '5 * * * *', tz: 'UTC' },
    { name: 'snapshot-fanout', data: { type: 'snapshot', source: 'github', tier: 'hot', batch: 0, batchCount: 1 },
      opts: { attempts: 3, backoff: { type: 'custom' }, removeOnComplete: 1000, removeOnFail: 5000 } },
  );
  // ...one call per row in the table above. upsert is idempotent → safe on every boot.
}
```

The `snapshot-fanout` job counts tracked items for the tier and enqueues `ceil(count / FANOUT_BATCH_ITEMS)` child `snapshot` jobs (`FANOUT_BATCH_ITEMS=500`), each with a deterministic `jobId.snapshot(...)`. Cold batches get `delay = i * spreadMs` so they spread across the window.

### 7.3 Per-source design

#### 7.3.1 GitHub (`packages/sources/src/github`)

| Aspect | Design |
|---|---|
| Auth | `GITHUB_TOKENS` holds a comma-separated list of fine-grained PATs with **public read-only** access (no scopes needed for public data). Use one token per worker; with several tokens the adapter round-robins and keeps a bucket per token (`rl:github:core:{tokenIdx}`). Respect GitHub's ToS: do not rotate many tokens just to evade limits; 1–2 tokens is enough for this design. |
| Documented limits | REST: **5,000 req/h** per user for a PAT; 60/h unauthenticated. **Search: 30 req/min** authenticated (search code: 10/min); each search returns **at most 1,000 results**. GraphQL: **5,000 points/h** per user; `first` 1–100; ≤ 500,000 nodes per call. Secondary: ≤ 100 concurrent requests; ≤ 900 points/min per REST endpoint, 2,000/min for GraphQL; ≤ 90 s CPU per 60 s. Headers: `x-ratelimit-limit/remaining/used/reset/resource`; on 403/429 honour `retry-after`, otherwise wait until `x-ratelimit-reset`; for a secondary limit without headers wait ≥ 60 s and then back off exponentially. Source: docs.github.com "Rate limits for the REST API", "Search", "GraphQL rate limits". |
| Discovery (REST search) | `GET https://api.github.com/search/repositories?q={q}&sort=stars&order=desc&per_page=100&page={1..10}`. Strategies: **new-hot** `q=created:>{today-7d} stars:>=20`; **rising** `q=created:>{today-30d} stars:>=100`; **topics** `q=topic:{t} pushed:>{today-14d} stars:>=10` for `t ∈ {mcp-server, mcp, model-context-protocol, llm, ai-agents, agent, rag, langchain, transformers, diffusion, typescript, rust, nextjs, devtools, cli}`; **active-established** `q=stars:>=1000 pushed:>{today-1d}` sort=updated (daily). Beat the 1,000-result cap by slicing date ranges: if `total_count > 1000`, split `created:` into halves recursively (max depth 4). Budget: ≤ 25 search req/min (bucket `rl:github:search`, capacity 25, refill 25/60 s). |
| Snapshot (GraphQL batch) | `POST https://api.github.com/graphql` with ≤ 50 aliased `repository(owner:, name:)` fields per query, which is about 1 point each (verify the exact cost from `rateLimit.cost`, which is always requested). Fields: `id nameWithOwner stargazerCount forkCount watchers{totalCount} issues(states:OPEN){totalCount} primaryLanguage{name} repositoryTopics(first:20){nodes{topic{name}}} licenseInfo{spdxId} description homepageUrl createdAt pushedAt isArchived isFork`. Missing repos come back as `null` with a `NOT_FOUND` error per alias: mark `is_deleted`. Renames are detected via `nameWithOwner` (Section 5.4). |
| Conditional requests | `refresh-item` and metadata refresh use REST `GET https://api.github.com/repos/{owner}/{repo}` with `If-None-Match: {etag}`. The ETag is stored in Redis `etag:github:{itemId}` (TTL 7 d). **A 304 does not count against the primary rate limit when the request is authorized** (GitHub best-practices docs). On 304, re-use `items.latest_metrics` and write a snapshot with the same values (keeps series continuity) while incrementing `ingestion_runs.not_modified`. |
| Backfill | Stars history for new repos with < 20k stars: `GET /repos/{o}/{r}/stargazers?per_page=100&page=N` with `Accept: application/vnd.github.star+json` (adds `starred_at`). Read `Link rel="last"` and walk backward until `starred_at < now-35d`; cap at `BACKFILL_GITHUB_MAX_PAGES=50`. Aggregate into end-of-day cumulative values in `daily_metrics` (`metric='stars'`). Stargazer pagination depth limits for very large repos: verify (commonly reported cap around 400 pages). |
| Tracked-set target | Hot 2,000 · warm 3,000 · cold ≤ 45,000 (`TRACKED_MAX_GITHUB=50000`). |
| Budget check | GraphQL: hot 40 q/h + warm 60 q/6h + cold 1,000 q/day ≈ 92 points/h on average; search ≈ 60 req per 2 h; REST ≈ 300/h (refresh plus backfill). Comfortably under 5,000/h, leaving headroom for a second worker. |
| Primary metric | `stars` (cumulative). Secondary: `forks`, `watchers`, `open_issues` (gauge). |

#### 7.3.2 npm (`packages/sources/src/npm`)

| Aspect | Design |
|---|---|
| Endpoints | Search: `GET https://registry.npmjs.org/-/v1/search?text={q}&size={≤250}&from={offset}` (documented params: `text`, `size` default 20 max 250, `from`, and `quality`/`popularity`/`maintenance` weights). Search text supports qualifiers like `keywords:mcp` (observed working; verify any other qualifiers). The response includes `downloads.weekly/monthly` and `updated`. Packument (metadata): `GET https://registry.npmjs.org/{pkg}` (scoped names encoded `@scope%2Fname`), or the abbreviated form with `Accept: application/vnd.npm.install-v1+json` (lacks `repository`, so use the full doc for alias resolution, at most weekly). Downloads: point `GET https://api.npmjs.org/downloads/point/{period}/{pkg}` and range `GET https://api.npmjs.org/downloads/range/{start}:{end}/{pkg}` (`period` ∈ `last-day|last-week|last-month|last-year` or `YYYY-MM-DD[:YYYY-MM-DD]`). |
| Documented limits | Download counts are **computed once per day, soon after UTC midnight**. `last-day` is the last *available* day. Bulk queries: comma-separated list, **≤ 128 packages, ≤ 365 days**, and **scoped packages are not supported in bulk**. Single queries: ≤ 18 months of data, earliest 2015-01-10. Request rate limits for registry and downloads are **not documented (verify)**. Use conservative buckets: `rl:npm:registry` 5 req/s, `rl:npm:downloads` 2 req/s. Search responses carry `Cache-Control: max-age=300` (observed). |
| Discovery | Keyword queries (`text=keywords:{k}`) for `k ∈ {mcp, mcp-server, modelcontextprotocol, ai, llm, agent, ai-agent, openai, anthropic, langchain, rag, embeddings, vector-database, cli, typescript, react, nextjs, vite, bun}`. Paginate `from` up to 1,000 per keyword. Also: packages referenced by tracked GitHub repos (alias resolution) and packages listed in MCP registry entries (`registryType=npm`). Admission filter: `downloads.weekly ≥ NPM_MIN_WEEKLY_DOWNLOADS` (default 200) **or** published in the last 30 days. |
| Daily metrics | **Velocity comes from the daily download series, never from diffing a counter.** The `daily` job fetches `range/{D-2}:{D}` (3 days, to absorb late-landing data) for all tracked packages: unscoped in bulk chunks of 128 (one request), scoped one request each. Upsert into `daily_metrics(metric='downloads')`. For bulk responses, map package → `{downloads:[{day,downloads}]}`. If day D is missing, the job finishes `partial` and the 06:00 retry fills it. |
| Backfill | On first admission: `range/{D-60}:{D}` (fits a 30-day window plus the previous 30 days for comparison). |
| Tracked-set target | `TRACKED_MAX_NPM=10000` (≈ 80 bulk requests plus scoped singles per day). |
| Primary metric | `downloads` (daily_count). `language='javascript'` (or `'typescript'` if the packument has `types`/`typings` or a TS keyword). |

#### 7.3.3 PyPI (`packages/sources/src/pypi`)

| Aspect | Design |
|---|---|
| Endpoints | Metadata: `GET https://pypi.org/pypi/{project}/json` (returns `ETag`; cached by the CDN; `Cache-Control: max-age=900` observed; `X-PyPI-Last-Serial`). Discovery feeds: `https://pypi.org/rss/packages.xml` (newest packages), `https://pypi.org/rss/updates.xml` (latest updates). Downloads: pypistats `GET https://pypistats.org/api/packages/{project}/overall?mirrors=false` (daily series) and `GET https://pypistats.org/api/packages/{project}/recent` (`last_day/last_week/last_month`). |
| Documented limits | PyPI: "Due to the heavy caching and CDN use, there is currently **no rate limiting of PyPI APIs at the edge**"; XML-RPC may be rate limited and is deprecated (do not use; it has no search). pypistats: **IP-based rate limiting** application-wide (numbers not published, verify); **time series kept only 180 days**; data **updated once daily**; etiquette is to cache and call each endpoint at most once per day per package, and not to bulk-download everything (use BigQuery `bigquery-public-data.pypi.file_downloads` for bulk; stretch). Buckets: `rl:pypi:json` 10 req/s, `rl:pypi:stats` 1 req per 2 s (≈ 1,800/h). |
| Discovery | (1) RSS newest/updates, filtered by name or summary keywords (`llm, agent, mcp, rag, langchain, transformer, diffusion, embedding, openai, anthropic, torch, jax`). (2) Seed list `pypi/seed.json` (≈ 300 notable AI/dev packages). (3) Packages linked from tracked GitHub repos (`pyproject`-style project URLs found via PyPI JSON `info.project_urls`, reverse-linked when a GitHub repo name matches a PyPI project whose project URL points back to it), MCP registry entries (`registryType=pypi`), and HF/papers. Admission: `recent.last_week ≥ PYPI_MIN_WEEKLY_DOWNLOADS` (default 500) or a first release within 30 days. |
| Daily metrics | The `daily` job calls `overall?mirrors=false` once per package per day and keeps the `without_mirrors` category. It upserts the last 3 days (late-data safety) into `daily_metrics(metric='downloads')`. |
| Backfill | Same call (the series already covers 180 days); keep 60 days on first admission. |
| Tracked-set target | `TRACKED_MAX_PYPI=2000` (2,000 calls × 2 s ≈ 67 min/day, done in batches between 05:00 and 06:10 UTC). |
| Primary metric | `downloads` (daily_count). `language='python'`. |

#### 7.3.4 Hugging Face (`packages/sources/src/huggingface`)

| Aspect | Design |
|---|---|
| Endpoints | List: `GET https://huggingface.co/api/models?sort={trendingScore|likes|downloads|lastModified|createdAt}&direction=-1&limit=100&expand[]=likes&expand[]=downloads&expand[]=downloadsAllTime&expand[]=trendingScore&expand[]=createdAt&expand[]=pipeline_tag&expand[]=tags&expand[]=library_name` with pagination through `cursor` from the `Link: <...>; rel="next"` header (observed). The same shape applies to `/api/datasets` and `/api/spaces` (optional, `HF_INCLUDE_DATASETS`/`HF_INCLUDE_SPACES`; verify the sort fields for spaces). Detail: `GET https://huggingface.co/api/models/{repo_id}?expand[]=likes&expand[]=downloadsAllTime&expand[]=downloads&expand[]=trendingScore` (observed fields). Trending feed: `GET https://huggingface.co/api/trending?type=model&limit=N` (in the official OpenAPI spec). Papers: `GET https://huggingface.co/api/daily_papers?date=YYYY-MM-DD&limit=N` (params `p, limit, date, week, month, submitter, sort`) and `GET https://huggingface.co/api/papers/{arxivId}` (fields `upvotes`, `linkedModels`, `linkedDatasets`, `linkedSpaces`; daily-paper entries also carry `githubRepo` and `githubStars` when known). OpenAPI: `https://huggingface.co/.well-known/openapi.json`. |
| Documented limits | Fixed **5-minute windows**. Hub API bucket: **anonymous 500 / 5 min per IP, free user 1,000 / 5 min, PRO 2,500** (values as of Sep 2025, which HF says may change). Headers: `RateLimit: "api";r={remaining};t={secondsToReset}` and `RateLimit-Policy: "fixed window";"api";q={quota};w=300` (observed). HTTP 429 when exceeded. Always send `Authorization: Bearer ${HF_TOKEN}`. Bucket `rl:huggingface:api`: capacity `HF_RATE_PER_5MIN × 0.8`, refill over 300 s. On 429, parse `t=` and pause the bucket until reset. |
| Discovery | Each hour: top 500 models by `trendingScore` (5 pages), top 200 newest by `createdAt` with `likes ≥ 5`. Daily: top 1,000 by `likes`. Optional datasets/spaces: top 200 by `trendingScore`. Every list item already includes metrics, so **discovery pages double as snapshots** for the listed items (upsert snapshot rows from list payloads, saving detail calls). |
| Snapshot | Hot or warm items not covered by this hour's list pages: one detail call each (`batchSize=1`, concurrency 4). |
| Metrics | `likes` (cumulative, **primary**), `downloads_total` from `downloadsAllTime` (cumulative), `trending_score` (gauge, stored for display or tie-breaks, never as velocity). `downloads` from HF is a rolling ~30-day count (verify) and is stored only in `latest_metrics`, **not** as a snapshot series. |
| Aliases | Tags `arxiv:{id}` on models → `model_of_paper` (confidence 0.9; verify the tag format against fixtures). `cardData`/README GitHub links are out of scope for v1. |
| Tracked-set target | Hot 1,000 · warm 2,000 · cold ≤ 10,000. |

#### 7.3.5 arXiv (`packages/sources/src/arxiv`)

| Aspect | Design |
|---|---|
| Endpoint | `GET https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.LG+OR+cat:cs.CV&sortBy=submittedDate&sortOrder=descending&start={n}&max_results=200`. Returns Atom 1.0 XML (parsed with fast-xml-parser), including errors (an error is a single `<entry>` titled "Error"). Optional date filter: `submittedDate:[YYYYMMDDHHMM TO YYYYMMDDHHMM]` (GMT). |
| Documented limits | Terms of Use: **no more than one request every three seconds, and a single connection at a time**, applied across all your machines combined. `max_results` ≤ 2,000 per call and ≤ 30,000 total; refine queries returning > 1,000. **Results change only once a day** (new articles appear at midnight after processing), so **cache and query at most once per day per query**. Enforce with bucket `rl:arxiv:api` (capacity 1, refill 1 per 3 s) **plus** a Redis mutex `lock:arxiv:conn` (SET NX PX 30000) so only one in-flight request exists across all workers. Metadata is CC0; never store or serve PDFs (link to the abstract page instead). |
| Discovery | Daily at 03:00 UTC: page through results until `published < now − 3 days` (usually 1–3 pages × 200 = ≤ 9 s of politeness delay). Upsert `items(kind='paper', external_id={id without version})`. Metadata includes authors, primary category, categories, abstract, comment, and the PDF and abstract URLs. |
| Popularity signal | arXiv publishes **no popularity metrics**. Signals: (1) Hugging Face paper **upvotes** via `/api/papers/{id}` or the daily-papers feed (`metric='upvotes'`, cumulative, **primary**), charged to `rl:huggingface:api`; (2) GitHub stars of the linked code repo (`githubRepo` from HF daily papers → alias `paper_code`; that repo is tracked as a GitHub item at tier ≥ warm and scored on the GitHub boards under `github:stars`, never as part of the paper's score). Papers with no HF entry get no velocity score (flag `insufficient_data`); they still appear under "New papers" (sorted by date) and in search. |
| Snapshot | The hourly `arxiv-snapshot` job fetches today's and yesterday's HF daily papers (2 calls), then `/api/papers/{id}` for tracked papers ≤ 30 days old that were not in those lists (≤ 300 calls/h, which fits the HF budget). |
| Tracked-set target | Papers ≤ 30 days: hot; 30–90 days: cold (daily); > 90 days: archived. |

#### 7.3.6 MCP servers and agent tools (`packages/sources/src/mcp`)

| Aspect | Design |
|---|---|
| Registry endpoint | `GET https://registry.modelcontextprotocol.io/v0.1/servers?limit=100&cursor={c}&updated_since={RFC3339}&version=latest` (also served under `/v0`; both appear in `https://registry.modelcontextprotocol.io/openapi.yaml`; pick `v0.1` and fall back to `v0` on 404; verify which is the stable contract). Query params from the OpenAPI spec: `cursor`, `limit`, `updated_since`, `search` (substring on name), `version` (`latest` or exact), `include_deleted` (forced true when `updated_since` is set). The response is `{ servers: [{ server: {name, title, description, version, repository?, packages?[{registryType: npm|pypi|oci|nuget|mcpb, identifier, ...}], remotes?[{type, url}]}, _meta: {"io.modelcontextprotocol.registry/official": {status, publishedAt, updatedAt, isLatest}} }], metadata: { nextCursor, count } }` (observed). |
| Limits | Not documented (verify). Bucket `rl:mcp:registry` at 2 req/s. The registry is still in preview, so pin a schema-version check: log a warning and keep going when `$schema` changes. |
| Discovery: registry | Incremental: store `mcp:registry:cursor_ts` in Redis (last max `updatedAt`) and call with `updated_since`. A full resync runs weekly (Sunday 00:30 UTC via the `mcp-discover` job with `strategy: 'full'`). Entries with `status=deleted` become `is_deleted=true`. |
| Discovery: GitHub and npm | GitHub search `q=topic:mcp-server` and `q=topic:mcp stars:>=5` (reusing GitHub search budget and code); npm `text=keywords:mcp-server` and `text=keywords:mcp`. Each hit that is not already linked to a registry entry becomes an `mcp` item with `external_id='github:{owner/name}'` or `'npm:{pkg}'`. |
| Aliases | `server.repository.url` → GitHub repo (`mcp_server_of`, 0.95); `packages[].registryType=npm/pypi` → npm/PyPI item (`registry_entry_of`, 0.95); GitHub-derived MCP item ↔ GitHub repo (`mcp_server_of`, 1.0). Alias targets are created as stubs and promoted to tier ≥ warm so they get snapshots. |
| Metrics (derived) | The registry has no popularity data. `mcp-snapshot` (hourly, **no upstream calls**) copies, for each MCP item, the latest alias metrics from Postgres into the MCP item's own snapshots: `stars` from the linked GitHub repo (primary when present) and `downloads` daily from the linked npm/PyPI package (into `daily_metrics`). `primary_metric` = `stars` if there is a GitHub alias, else `downloads`. Items with neither are listed under "New in MCP" only. |
| Tracked set | All registry servers (latest versions) plus GitHub/npm-discovered servers above the admission thresholds (GitHub ≥ 5 stars; npm ≥ 50 weekly downloads). |

### 7.4 Rate limiting: Redis token bucket

All upstream calls go through `RedisTokenBucket.take(key, cost)`. Buckets are shared by every worker process, so scaling out never multiplies upstream load.

```lua
-- packages/core/src/rate-limit/token-bucket.lua
-- KEYS[1] = bucket key (hash: tokens, ts), KEYS[2] = pause key (string: epoch ms until which bucket is paused)
-- ARGV: capacity, refill_per_ms, cost, now_ms, ttl_ms
local capacity = tonumber(ARGV[1])
local rate     = tonumber(ARGV[2])
local cost     = tonumber(ARGV[3])
local now      = tonumber(ARGV[4])
local ttl      = tonumber(ARGV[5])

local paused_until = tonumber(redis.call('GET', KEYS[2]) or '0')
if paused_until > now then
  return { 0, paused_until - now }            -- denied, wait ms
end

local data   = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1]) or capacity
local ts     = tonumber(data[2]) or now
tokens = math.min(capacity, tokens + (now - ts) * rate)

local allowed, wait = 0, 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  wait = math.ceil((cost - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], ttl)
return { allowed, wait }
```

```ts
// packages/core/src/rate-limit/token-bucket.ts
import type { Redis } from 'ioredis';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { redisKeys } from '../redis-keys.js';

const LUA = readFileSync(new URL('./token-bucket.lua', import.meta.url), 'utf8');

export interface BucketSpec { name: string; capacity: number; refillPerSec: number }

export class RedisTokenBucket {
  constructor(private readonly redis: Redis, private readonly spec: BucketSpec) {
    redis.defineCommand('takeToken', { numberOfKeys: 2, lua: LUA });
  }
  /** Blocks (async) until `cost` tokens are available or the signal aborts. */
  async take(cost = 1, signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      // @ts-expect-error - custom command defined above (typed wrapper in real code)
      const [allowed, waitMs] = (await this.redis.takeToken(
        redisKeys.rateBucket(this.spec.name), redisKeys.ratePause(this.spec.name),
        this.spec.capacity, this.spec.refillPerSec / 1000, cost, Date.now(), 3_600_000,
      )) as [number, number];
      if (allowed === 1) return;
      await sleep(Math.min(waitMs + Math.floor(Math.random() * 50), 60_000), undefined, { signal });
    }
  }
  /** Called when upstream says we're exhausted (x-ratelimit-reset / RateLimit t= / retry-after). */
  async pauseUntil(epochMs: number): Promise<void> {
    await this.redis.set(redisKeys.ratePause(this.spec.name), String(epochMs), 'PX', Math.max(1, epochMs - Date.now()));
  }
}
```

(Replace the `@ts-expect-error` with a typed `declare module 'ioredis'` augmentation. It appears here only for brevity, and the no-`any` rule still applies.)

| Bucket name (`rl:{name}`) | Capacity | Refill | Basis |
|---|---|---|---|
| `github:core` | 500 | 1.25/s (4,500/h) | 5,000/h documented, 10% headroom |
| `github:search` | 25 | 25/60 s | 30/min documented |
| `github:graphql` | 300 points | 1.25 pt/s (4,500/h) | 5,000 pts/h documented. Debit `rateLimit.cost` after each response (pre-debit 1, then adjust). |
| `npm:registry` | 10 | 5/s | Undocumented (verify) |
| `npm:downloads` | 5 | 2/s | Undocumented (verify) |
| `pypi:json` | 20 | 10/s | No edge rate limit documented |
| `pypi:stats` | 1 | 0.5/s | IP rate limit, values unpublished (verify) |
| `huggingface:api` | `0.8 × HF_RATE_PER_5MIN` | same / 300 s | 1,000/5 min for a free token (Sep 2025) |
| `arxiv:api` | 1 | 1/3 s | ToS: 1 request per 3 s, one connection |
| `mcp:registry` | 5 | 2/s | Undocumented (verify) |

**Header feedback loop** (in `fetch-json.ts` per-source hooks):
- GitHub: when `x-ratelimit-remaining < GITHUB_RESERVE` (default 200), call `pauseUntil(x-ratelimit-reset*1000)`. Export the gauge `trendr_rate_limit_remaining{source="github",resource}`.
- HF: parse `RateLimit: "api";r=N;t=S`. When `r < 20`, pause for `S` seconds.
- On any 429/403 rate-limit response: pause using `retry-after`, else the reset header, else 60 s; the job retries.

### 7.5 HTTP client, retries, backoff with jitter

```ts
// packages/core/src/http/backoff.ts
/** "Full jitter" (AWS architecture blog): sleep = random(0, min(cap, base * 2^attempt)). */
export function backoffDelay(attempt: number, baseMs = 1_000, capMs = 5 * 60_000, rnd = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(rnd() * exp);
}
```

```ts
// packages/core/src/http/fetch-json.ts (shape)
export interface FetchJsonOptions<T> {
  url: string;
  schema: z.ZodType<T>;
  bucket: RedisTokenBucket;
  cost?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;            // default 15_000
  maxAttempts?: number;          // in-request retries for network errors/5xx, default 3
  etag?: string | null;
  onHeaders?: (h: Headers) => Promise<void>; // rate-limit feedback
  signal?: AbortSignal;
}
export type FetchJsonResult<T> =
  | { status: 'ok'; data: T; etag: string | null; headers: Headers }
  | { status: 'not_modified'; headers: Headers }
  | { status: 'not_found'; headers: Headers };
// Behaviour:
// - always sets User-Agent from env.HTTP_USER_AGENT, Accept, and auth header per source
// - 2xx → schema.safeParse; failure → UpstreamError(retryable=false) with Zod issues logged (sample payload hashed)
// - 304 → not_modified; 404/410 → not_found
// - 429/403-with-rate-limit → bucket.pauseUntil(...), throw UpstreamError(retryable=true, retryAfterMs)
// - 5xx / ECONNRESET / timeout → retry in-process with backoffDelay(attempt, 500, 10_000), then throw retryable
// - other 4xx → UpstreamError(retryable=false)
// - increments trendr_source_api_requests_total{source,status} and observes trendr_source_api_duration_seconds
```

BullMQ job-level retries (above the in-request ones):

```ts
// apps/worker/src/queues.ts (excerpt)
export const defaultJobOpts: JobsOptions = {
  attempts: 5,
  backoff: { type: 'custom' },
  removeOnComplete: { age: 24 * 3600, count: 2000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};
export const workerSettings: WorkerOptions['settings'] = {
  backoffStrategy: (attemptsMade, _type, err) => {
    if (err instanceof UpstreamError && err.retryAfterMs) return err.retryAfterMs + Math.floor(Math.random() * 5_000);
    return backoffDelay(attemptsMade, 5_000, 30 * 60_000);
  },
};
```

Non-retryable errors (schema change, 400/422, missing config) are thrown as BullMQ `UnrecoverableError` so they skip the remaining attempts.

### 7.6 Idempotency

| Layer | Mechanism |
|---|---|
| Job enqueue | Deterministic `jobId` (5.2). BullMQ ignores an `add` whose id already exists (while it is retained). |
| Run audit | `ingestion_runs UNIQUE (job_id, attempt)` |
| Snapshots | PK `(item_id, metric, captured_at)` with the bucketed `captured_at`, using `ON CONFLICT DO UPDATE ... WHERE observed_at < EXCLUDED.observed_at` |
| Daily metrics | PK `(item_id, metric, day)` upsert (late corrections overwrite) |
| Items / aliases | `UNIQUE (source, external_id)`, `UNIQUE (item_id, alias_item_id, relation)` |
| Scores | PK `(item_id, window, run_id)`, then the `score_runs_current` pointer swap inside the same transaction |
| Alerts / digests | `alert_events.dedupe_key UNIQUE`, `digest_sends UNIQUE (subscription_id, week_start)`, plus BullMQ jobIds `alert.{eventId}` and `digest.{subId}.{week}` |

### 7.7 Dead-letter queue

```ts
// apps/worker/src/dlq.ts
worker.on('failed', async (job, err) => {
  if (!job) return;
  const final = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
  if (!final) return;
  await queues.deadLetter.add('dead', {
    originalQueue: job.queueName, name: job.name, data: job.data, jobId: job.id,
    failedReason: err.message, stack: err.stack?.slice(0, 4000), attemptsMade: job.attemptsMade,
    failedAt: new Date().toISOString(),
  }, { jobId: `dlq.${job.queueName}.${job.id}`, removeOnComplete: false, removeOnFail: false });
  metrics.dlqJobsTotal.inc({ queue: job.queueName });
});
```

Admin endpoints list, retry (re-add to the original queue with a new jobId suffix `.retry{n}`) and purge DLQ jobs (Section 10). Prometheus alerts fire when `trendr_queue_depth{queue="dead-letter"} > 20`.

### 7.8 Tiering (`maintenance:retier-items`, daily, plus instant promotion)

| Tier | Rule (evaluated in this order) | Snapshot cadence |
|---|---|---|
| `hot` | On any watchlist **or** `rank_source ≤ 200` in any window of the current run **or** created ≤ 7 d ago with primary metric ≥ source admission minimum **or** HF trending top 100 **or** arXiv paper ≤ 30 d old. Capped by `TRACKED_HOT_MAX_{SOURCE}` (ties broken by best 7d percentile). | Hourly |
| `warm` | `rank_source ≤ 2000` in 7d or 30d **or** created ≤ 30 d ago **or** an alias target of a hot item | Every 6 h |
| `cold` | Seen in the last 90 days, or any positive 30d delta | Daily |
| `archived` | No positive delta for 60 d, not watched, or upstream deleted/archived | Weekly existence check only |

Instant promotion: adding an item to a watchlist calls `UPDATE items SET tier='hot'` and enqueues `refresh-item`. Daily-count sources (npm, PyPI) fetch downloads daily for every non-archived item regardless of tier; tier only controls metadata refresh cadence (hot/warm weekly, cold monthly).

### 7.9 Backfill strategy

| Source | Backfill | Trigger | Bound |
|---|---|---|---|
| GitHub | Stargazers with `starred_at` → daily cumulative stars | New item, stars < 20k | 50 pages (5,000 stars) per repo; ≤ 200 repos/h (`BACKFILL_GITHUB_PER_HOUR`) |
| npm | `downloads/range/{D-60}:{D}` | New item | 1 request (bulk for unscoped) |
| PyPI | pypistats `overall` (180 d available) | New item | 1 request, keep 60 d |
| HF | None (no public history of likes; verify whether `/api/models/{id}/likers` exposes timestamps) | — | Score confidence ramps as data accrues |
| arXiv / HF papers | None; papers are new by definition | — | — |
| MCP | Derived from alias history (copy `daily_metrics` of aliases) | New item | SQL only |
| Bootstrap | `pnpm db:seed` loads fixtures (≈ 200 items with 60 days of synthetic-but-realistic series) so the UI works offline. `pnpm ingest:bootstrap` runs discovery for every source once and then backfill. | Manual | — |

---

## 8. Scoring Algorithm

Scoring runs per `(source, window)` in `apps/worker/src/scoring/run-scoring.ts`. All math lives in **pure functions** in `packages/core/src/scoring/*` and is tested first (TDD), with property-based tests (`fast-check`) for monotonicity.

### 8.1 Inputs per item

Let `t` be the scoring time (end of the last complete hour), `W` the window length, and `m` the item's `primary_metric`.

**Cumulative metrics** (`stars`, `likes`, `upvotes`, `downloads_total`), read from `snapshots`:

- `V_now` = the latest snapshot value with `captured_at ≤ t`. It must be fresher than the staleness limit `S(tier)` = 3 h for hot, 12 h for warm, 36 h for cold; otherwise confidence is halved. (The SQL in 8.6 only applies the 36 h outer bound; the tier-specific check runs in TypeScript, see 8.6.)
- `V_then` = the value at `t − W`. It is linearly interpolated between the nearest snapshots around `t − W` when both lie within the tolerance `τ_W = max(2 h, 0.1·W)`. Otherwise it falls back to the `daily_metrics` end-of-day value for the UTC day before `t − W`.
- **Truly new item** (`upstream_created_at ≥ t − W`): `V_then = 0`, `Δ = V_now`, coverage `c = 1` (we know it started from zero).
- **Tracked late** (no data near `t − W` and the item is older than the window): `V_then = V_first`, the first observation in the window; `c = (t − t_first) / W`. No extrapolation.
- `Δ = V_now − V_then`, `B = V_then`.

**Daily-count metrics** (`downloads` for npm, PyPI, and MCP-via-alias), read from `daily_metrics`:

- `D` is the latest complete day with data, and it must satisfy `D ≥ today − 3`; otherwise the item gets the `insufficient_data` flag.
- `n = WINDOW_DAYS[W]` (1, 7, 30).
- `S_cur = Σ downloads(d)` for `d ∈ [D−n+1, D]`.
- `S_prev`:
  - `24h`: the mean of the 7 days `[D−7, D−1]`. Comparing against a weekly mean dampens weekday/weekend seasonality.
  - `7d`: `Σ [D−13, D−7]`.
  - `30d`: `Σ [D−59, D−30]`.
- `Δ = S_cur − S_prev`, `B = S_prev`; `c` = days present / days required.
- **Never diff npm or PyPI numbers as if they were a monotonic counter.** They are daily aggregates, so velocity means *the change in download rate between consecutive periods*.

### 8.2 Formulas

```
1. Eligibility    (checked in this order; first match wins)
                  if c < 0.25                        → flags += insufficient_data, final = 0
                  if Δ ≤ 0                           → flags += negative_growth, final = 0
                  if Δ < minDelta(s,m,W)             → flags += below_threshold, final = 0

2. Relative       r = min( Δ / (B + k(s,m,W)), r_max )          k = smoothing prior, r_max = 50

3. Velocity       raw = log10(1 + Δ) · r^β                      β = 0.35 (default)
                    • log10(1+Δ): absolute growth, log-damped so 50k-star repos don't dominate
                    • r^β: relative growth, sub-linear so tiny bases can't explode (k also guards)

4. Age            ageFactor = 1 + A · exp(−ageDays / τ_age)     A = 0.25, τ_age = 14 d (papers: 7 d)

5. Confidence     conf = sqrt(clamp(c, 0, 1)) · (stale ? 0.5 : 1)

6. Anomaly        p = 0.5 if burst detected (8.5), 0.7 if daily spike detected, else 1.0

7. Final          final = raw · ageFactor · conf · p

8. Normalize      within (s, W), eligible = final > 0:
                    x = ln(1 + final)
                    z = clip( (x − median(x)) / (1.4826 · MAD(x)), −3, 8 )     (robust z-score)
                    percentile = 100 · (rankAsc − 0.5) / N
                  if MAD = 0 (tiny N) → z = 0 for all, percentile still computed

9. Combined 'all' board: union of eligible items from all sources, sorted by z desc,
                  tie-break percentile desc, then final desc. Optional cap: no source exceeds
                  ALL_BOARD_MAX_SHARE (default 0.4) of the top 100 (greedy fill).
```

Why the log transform before z-scoring: `final` is heavy-tailed, and a robust z on `ln(1+final)` makes the "top 2%" of npm comparable to the "top 2%" of GitHub even though their raw scales differ by orders of magnitude. The median and MAD (median absolute deviation) resist outliers, unlike the mean and standard deviation.

### 8.3 Parameters (`packages/core/src/scoring/params.ts`)

```ts
export interface ScoringParams { k: number; minDelta: number; beta: number; rMax: number; burstMinAbs: number }
type Key = `${Source}:${Metric}`;
const kPerDay = (perDay: number, w: Window) => perDay * WINDOW_DAYS[w];

export function paramsFor(source: Source, metric: Metric, w: Window): ScoringParams {
  const base = { beta: 0.35, rMax: 50 };
  const table: Partial<Record<Key, (w: Window) => ScoringParams>> = {
    'github:stars':          (w) => ({ ...base, k: 100, minDelta: { '24h': 10, '7d': 30, '30d': 75 }[w], burstMinAbs: 300 }),
    'npm:downloads':         (w) => ({ ...base, k: kPerDay(100, w), minDelta: { '24h': 200, '7d': 1000, '30d': 3000 }[w], burstMinAbs: 10_000 }),
    'pypi:downloads':        (w) => ({ ...base, k: kPerDay(100, w), minDelta: { '24h': 200, '7d': 1000, '30d': 3000 }[w], burstMinAbs: 10_000 }),
    'huggingface:likes':     (w) => ({ ...base, k: 20, minDelta: { '24h': 5, '7d': 15, '30d': 40 }[w], burstMinAbs: 200 }),
    'arxiv:upvotes':         (w) => ({ ...base, k: 5, minDelta: { '24h': 3, '7d': 8, '30d': 15 }[w], burstMinAbs: 100 }),
    'mcp:stars':             (w) => ({ ...base, k: 30, minDelta: { '24h': 3, '7d': 10, '30d': 25 }[w], burstMinAbs: 300 }),
    'mcp:downloads':         (w) => ({ ...base, k: kPerDay(30, w), minDelta: { '24h': 50, '7d': 250, '30d': 750 }[w], burstMinAbs: 5_000 }),
  };
  const f = table[`${source}:${metric}`];
  if (!f) throw new Error(`No scoring params for ${source}:${metric}`);
  return f(w);
}
```

There is deliberately **no arXiv `stars` entry** in the table: an arXiv paper's `primary_metric` is always `upvotes` (HF paper upvotes, 7.3.5), and its linked code repo is a separate GitHub item scored under `github:stars`. `paramsFor('arxiv', 'stars', w)` therefore throws, which a unit test asserts.

Every change to these constants needs a regression fixture update (`packages/core/test/scoring.golden.test.ts`), so ranking shifts always show up in review.

### 8.4 Implementation

```ts
// packages/core/src/scoring/velocity.ts
import type { ScoreComponents, ScoreFlag, Window } from '../types.js';
import type { ScoringParams } from './params.js';

export interface VelocityInput {
  delta: number; base: number; coverage: number; stale: boolean;
  ageDays: number | null; isPaper: boolean; anomalyPenalty: number;
}

export function computeRawScore(i: VelocityInput, p: ScoringParams): ScoreComponents & { flags: ScoreFlag[] } {
  const flags: ScoreFlag[] = [];
  const zero = (f: ScoreFlag) => ({ delta: i.delta, base: i.base, relGrowth: 0, rawScore: 0, ageFactor: 1,
    confidence: 0, anomalyPenalty: i.anomalyPenalty, finalScore: 0, flags: [...flags, f] });

  if (i.coverage < 0.25) return zero('insufficient_data');
  if (i.delta <= 0) return zero('negative_growth');
  if (i.delta < p.minDelta) return zero('below_threshold');

  const relGrowth = Math.min(i.delta / (i.base + p.k), p.rMax);
  const rawScore = Math.log10(1 + i.delta) * relGrowth ** p.beta;
  const tau = i.isPaper ? 7 : 14;
  const ageFactor = i.ageDays === null ? 1 : 1 + 0.25 * Math.exp(-i.ageDays / tau);
  if (i.ageDays !== null && i.ageDays <= 30) flags.push('new_item');
  const confidence = Math.sqrt(Math.min(1, Math.max(0, i.coverage))) * (i.stale ? 0.5 : 1);
  if (i.anomalyPenalty < 1) flags.push('burst_suspected');
  const finalScore = rawScore * ageFactor * confidence * i.anomalyPenalty;
  return { delta: i.delta, base: i.base, relGrowth, rawScore, ageFactor, confidence,
           anomalyPenalty: i.anomalyPenalty, finalScore, flags };
}
```

```ts
// packages/core/src/scoring/normalize.ts
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
export function robustZ(values: readonly number[]): number[] {
  const x = values.map((v) => Math.log1p(v));
  const med = median(x);
  const mad = median(x.map((v) => Math.abs(v - med)));
  if (mad === 0) return x.map(() => 0);
  return x.map((v) => Math.min(8, Math.max(-3, (v - med) / (1.4826 * mad))));
}
export function percentileRanks(values: readonly number[]): number[] {
  const idx = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(values.length);
  idx.forEach(([, i], r) => { out[i] = (100 * (r + 0.5)) / values.length; });
  return out;
}
```

```ts
// apps/worker/src/scoring/run-scoring.ts (pseudocode)
export async function runScoring(source: Source, windows: Window[], deps: Deps): Promise<void> {
  const lock = await deps.redis.set(redisKeys.scoreLock(source), deps.jobId, 'PX', 120_000, 'NX');
  if (!lock) return;                                   // another run in progress → skip
  const run = await deps.runs.start({ source, jobType: 'score', jobId: deps.jobId });
  try {
    for (const w of windows) {
      const t = deps.now();
      // main endpoint query per (source, window) + fallback/burst passes, see 8.6
      const rows = await loadSeries(deps.db, source, w, t);
      const inputs = rows.map((r) => toVelocityInput(r, w, t));         // computes stale = t - t_now > STALENESS_LIMIT[tier]
      const scored = inputs.map((it) => ({ it, s: computeRawScore(it.velocity, paramsFor(source, it.metric, w)) }));
      const eligible = scored.filter((x) => x.s.finalScore > 0);       // = no insufficient_data / negative_growth / below_threshold
      const z = robustZ(eligible.map((x) => x.s.finalScore));
      const pct = percentileRanks(eligible.map((x) => x.s.finalScore));
      metrics.scoringItems.set({ source, window: w, eligibility: 'eligible' }, eligible.length);
      metrics.scoringItems.set({ source, window: w, eligibility: 'ineligible' }, scored.length - eligible.length);
      await deps.db.transaction(async (tx) => {
        await insertScores(tx, run.id, source, w, eligible, z, pct);     // eligible rows ONLY; ineligible items get no row
        await upsertScoreRunsCurrent(tx, source, w, run.id);
      });
    }
    await rebuildAllBoard(deps, windows);              // reads score_runs_current for ALL sources, ranks by z_score,
                                                       // applies ALL_BOARD_MAX_SHARE, UPDATEs scores.rank_all on those
                                                       // current-run rows (unnest), and publishes lb:all:{window}:{lang}
    await publishLeaderboards(deps, source, windows, run.id);           // Section 9
    await deps.queues.notify.add('evaluate-alerts', { type: 'evaluate-alerts', scoreRunId: String(run.id), source },
                                 { jobId: jobId.evaluateAlerts(String(run.id)) });
    await deps.runs.finish(run.id, 'succeeded');
  } finally {
    await deps.redis.del(redisKeys.scoreLock(source));  // released only if value matches (Lua compare-and-del)
  }
}
```

### 8.5 Anomaly and spam detection

```ts
// packages/core/src/scoring/anomaly.ts
import { median } from './normalize.js';

/** hourly: cumulative values at consecutive hour buckets within the window (≥ 12 points). */
export function detectBurst(hourly: readonly number[], delta: number, burstMinAbs: number): { penalty: number; reason?: string } {
  if (hourly.length < 12 || delta <= 0) return { penalty: 1 };
  const inc = hourly.slice(1).map((v, i) => Math.max(0, v - hourly[i]!));
  const maxInc = Math.max(...inc);
  const med = median(inc);
  const mad = median(inc.map((x) => Math.abs(x - med))) || 1;
  const isBurst = maxInc >= burstMinAbs && maxInc / delta >= 0.5 && (maxInc - med) / (1.4826 * mad) > 10;
  return isBurst ? { penalty: 0.5, reason: `single-hour +${maxInc} (${Math.round((100 * maxInc) / delta)}% of window)` } : { penalty: 1 };
}

/** daily: download counts; flags a single day > 20× median of prior 14 days and above absolute floor. */
export function detectDailySpike(daily: readonly number[], burstMinAbs: number): { penalty: number } {
  if (daily.length < 15) return { penalty: 1 };
  const last = daily.at(-1)!;
  const prior = median(daily.slice(-15, -1));
  return last >= burstMinAbs && last > 20 * Math.max(prior, 1) ? { penalty: 0.7 } : { penalty: 1 };
}
```

- **Star drops** (V falls by > 5% in a day, typically GitHub removing fake stars) set the item flag `burst_suspected` for 30 days. While the flag is set, `p = 0.5`.
- Bursts are *penalized and flagged, not removed*. A Hacker News front-page spike is legitimate. The UI shows a ⚠ badge with the reason; admins can set `manual_hidden` via `PATCH /v1/admin/items/:id`.
- Stretch: sample 100 recent stargazers (`star+json`) and compute the share of accounts younger than 30 days with 0 public repos. If it is > 50%, apply `p = 0.2`. This costs about 2 REST calls per suspicious repo.

### 8.6 Series loading SQL (cumulative metrics: one endpoint query per (source, window), plus follow-up passes)

```sql
-- $1 source, $2 t (timestamptz), $3 window interval, $4 tolerance interval
WITH tracked AS (
  SELECT id, primary_metric, upstream_created_at, tier FROM items
  WHERE source = $1 AND NOT is_deleted AND tier <> 'archived' AND NOT ('manual_hidden' = ANY(flags))
),
now_v AS (
  SELECT DISTINCT ON (s.item_id) s.item_id, s.value, s.captured_at
  FROM snapshots s JOIN tracked t ON t.id = s.item_id AND s.metric = t.primary_metric
  WHERE s.captured_at BETWEEN $2 - interval '36 hours' AND $2
  ORDER BY s.item_id, s.captured_at DESC
),
before_v AS (   -- nearest point at or before t-W (within tolerance)
  SELECT DISTINCT ON (s.item_id) s.item_id, s.value, s.captured_at
  FROM snapshots s JOIN tracked t ON t.id = s.item_id AND s.metric = t.primary_metric
  WHERE s.captured_at BETWEEN $2 - $3 - $4 AND $2 - $3
  ORDER BY s.item_id, s.captured_at DESC
),
after_v AS (    -- nearest point after t-W (within tolerance) for interpolation
  SELECT DISTINCT ON (s.item_id) s.item_id, s.value, s.captured_at
  FROM snapshots s JOIN tracked t ON t.id = s.item_id AND s.metric = t.primary_metric
  WHERE s.captured_at > $2 - $3 AND s.captured_at <= $2 - $3 + $4
  ORDER BY s.item_id, s.captured_at ASC
),
first_v AS (
  SELECT DISTINCT ON (s.item_id) s.item_id, s.value, s.captured_at
  FROM snapshots s JOIN tracked t ON t.id = s.item_id AND s.metric = t.primary_metric
  WHERE s.captured_at > $2 - $3 AND s.captured_at <= $2
  ORDER BY s.item_id, s.captured_at ASC
)
SELECT t.id, t.primary_metric, t.upstream_created_at, t.tier,
       n.value AS v_now, n.captured_at AS t_now,
       b.value AS v_before, b.captured_at AS t_before,
       a.value AS v_after,  a.captured_at AS t_after,
       f.value AS v_first,  f.captured_at AS t_first
FROM tracked t
JOIN now_v n ON n.item_id = t.id
LEFT JOIN before_v b ON b.item_id = t.id
LEFT JOIN after_v  a ON a.item_id = t.id
LEFT JOIN first_v  f ON f.item_id = t.id;
```

**Staleness is split between SQL and TypeScript.** The `now_v` CTE's `36 hours` is only the **outer bound** (the largest staleness limit, cold tier): it lets the query find `V_now` and return its timestamp as `t_now`. Items with no snapshot in the last 36 h are not returned at all, so they are not scored (equivalent to `insufficient_data`) and get no `scores` row. The **tier-specific** limit (`STALENESS_LIMIT` = 3 h hot / 12 h warm / 36 h cold) and the resulting `stale` flag (confidence × 0.5, 8.2 step 5) are computed in TypeScript in `apps/worker/src/scoring/run-scoring.ts` (`toVelocityInput`: `stale = t − t_now > STALENESS_LIMIT[tier]`), not in SQL.

**Queries per (source, window):** this endpoint query runs **once** per (source, window). It is followed by at most two smaller passes: the `daily_metrics` fallback and the burst-detection increments, both described below.

Partition pruning keeps every CTE scanning only one or two monthly partitions. The `daily_metrics` fallback for `V_then` is a second, smaller query run only for items whose `v_before` and `v_after` are both null. Daily-count series use one aggregate query with `SUM(...) FILTER (WHERE day BETWEEN ...)` for `S_cur` and `S_prev` plus `count(*)` for coverage. Hourly increments for burst detection are loaded only for the top 500 candidates by `raw` (a second pass), to keep the run under 60 s.

### 8.7 Worked numeric example (GitHub, 7d window, k = 100, β = 0.35, A = 0.25, τ = 14 d)

| Repo | Situation | B | Δ | r = Δ/(B+k) | r^β | log10(1+Δ) | raw | ageFactor | conf | p | **final** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A big-framework | 8 years old | 80,000 | 1,400 | 0.0175 | 0.2426 | 3.1464 | 0.7633 | 1.0000 | 1.0000 | 1.0 | **0.763** |
| B small-agent | 40 days old | 150 | 1,200 | 4.8000 | 1.7315 | 3.0795 | 5.3324 | 1.0144 | 1.0000 | 1.0 | **5.409** |
| C brand-new | Created 5 d ago (so B = 0, c = 1) | 0 | 900 | 9.0000 | 2.1577 | 2.9547 | 6.3753 | 1.1749 | 1.0000 | 1.0 | **7.491** |
| E burst | 3,000 gained, 2,600 of them in one hour | 400 | 3,000 | 6.0000 | 1.8722 | 3.4773 | 6.5101 | 1.0000 | 1.0000 | 0.5 | **3.255** ⚠ |
| F tracked-late | Old repo first observed 3 days ago (c = 3/7) | 2,000 | 600 | 0.2857 | 0.6450 | 2.7789 | 1.7924 | 1.0000 | 0.6547 | 1.0 | **1.173** |
| D tiny | 12 → 30 | 12 | 18 | — | — | — | 0 | — | — | — | **0** (below_threshold: 18 < 30) |

GitHub 7d ranking: **C (7.49) > B (5.41) > E (3.26, flagged) > F (1.17) > A (0.76)**. The 80k-star framework that gained 1,400 stars ranks below a 150-star project that gained 1,200 stars, which is the intended "velocity" behavior. A still beats truly tiny movers because of the `log10(1+Δ)` term and the thresholds.

Normalization: assume the GitHub 7d distribution of `x = ln(1+final)` has median 0.90 and MAD 0.35 (scale 1.4826 × 0.35 = 0.5189):

| Repo | x = ln(1+final) | z |
|---|---|---|
| C | 2.1389 | **2.388** |
| B | 1.8577 | **1.846** |
| E | 1.4481 | 1.056 |
| F | 0.7763 | −0.238 |
| A | 0.5672 | −0.641 |

npm package X, 7d: `S_prev = 10,000`, `S_cur = 25,000` → `Δ = 15,000`, `k = 7 × 100 = 700`, `r = 15,000 / 10,700 = 1.4019`, `r^β = 1.1255`, `log10(15,001) = 4.1761`, `raw = final = 4.7002`, `x = 1.7405`. With the npm 7d distribution at median 1.10 and MAD 0.30 (scale 0.4448): `z = 1.44`.

**Combined "All" 7d board:** C (2.388) > B (1.846) > npm X (1.44) > E (1.056) > ... Without normalization, npm's larger raw numbers would have crowded out the board.

### 8.8 Missing data rules (summary)

| Case | Handling |
|---|---|
| No snapshot near `t−W`, item older than W | Use `daily_metrics` end-of-day value; else first observation with `c < 1` |
| Latest snapshot stale | `conf × 0.5` (stale flag) |
| Daily-count gaps | Missing days count as missing (not as zero); `c` = present / required; `c < 0.25` → excluded |
| Counter reset (V_now < V_then by > 50%) | Treat as a data error: exclude with `insufficient_data` and log `scoring_anomaly{type="reset"}` |
| Upstream 404 | `is_deleted = true` and excluded from boards; history kept |
| Item renamed | Same `items.id` (matched via `upstream_id`), so series continuity is preserved |

---

## 9. Caching

### 9.1 Redis keyspace (`packages/core/src/redis-keys.ts` is the single source of truth)

| Key | Type | Content | TTL | Writer → Reader |
|---|---|---|---|---|
| `lb:{scope}:{window}:{lang}` | ZSET | member = `itemId`, score = `final_score` (source boards) or `z_score` (scope `all`) | 6 h (safety; replaced each run) | scoring → api |
| `lbmeta:{scope}:{window}` | HASH | `runId`, `computedAt`, `count`, `version` | 6 h | scoring → api (ETag) |
| `card:{itemId}:{window}` | STRING (JSON) | `LeaderboardEntry` minus rank (display fields, delta, relGrowth, current, sparkline, flags) | 6 h | scoring → api |
| `item:{itemId}` | STRING (JSON) | Item detail DTO | 300 s | api read-through |
| `hist:{itemId}:{metric}:{granularity}:{rangeKey}` | STRING (JSON) | History points | 900 s | api read-through |
| `q:{sha1(normalizedQuery)}` | STRING (JSON) | Results of filtered queries not served by ZSETs (topic, kind, minCurrent, search) | 60 s (search 120 s) | api read-through |
| `rl:{bucket}` / `rl:{bucket}:pause` | HASH / STRING | Upstream token buckets (7.4) | 1 h / until reset | workers |
| `apirl:{keyId|ip}` | managed by `@fastify/rate-limit` | Inbound API limits | window | api |
| `etag:github:{itemId}` | STRING | Last REST ETag | 7 d | worker |
| `lock:score:{source}` | STRING | Scoring lock (holder jobId) | 120 s | worker |
| `lock:arxiv:conn` | STRING | arXiv single-connection mutex | 30 s | worker |
| `mcp:registry:cursor_ts` | STRING | Last `updatedAt` seen | none | worker |
| `events:leaderboard` | PUB/SUB channel | Leaderboard diff events | — | scoring → api SSE |
| `bull:{queue}:*` | BullMQ internals | Do not touch | — | — |

`scope ∈ {all, github, npm, pypi, huggingface, arxiv, mcp}`, `window ∈ {24h, 7d, 30d}`, `lang` = `_all` or a lowercase language slug (`typescript`, `python`, `rust`, `c%2B%2B` URL-encoded). Language boards are built only for the top 30 languages by item count, and only for `github`, `npm` (javascript/typescript) and `all`. Each board holds at most `LB_MAX_SIZE=1000` members.

### 9.2 Atomic leaderboard rebuild

```ts
// apps/worker/src/scoring/publish-leaderboards.ts
export async function publishBoard(redis: Redis, scope: LeaderboardScope, w: Window, lang: string,
                                   rows: Array<{ itemId: bigint; score: number }>, runId: bigint): Promise<void> {
  const live = redisKeys.leaderboard(scope, w, lang);
  const tmp = `${live}:tmp:${runId}`;
  const top = rows.slice(0, LB_MAX_SIZE);
  const p = redis.pipeline();
  p.del(tmp);
  for (let i = 0; i < top.length; i += 500) {
    p.zadd(tmp, ...top.slice(i, i + 500).flatMap((r) => [r.score, r.itemId.toString()]));
  }
  p.expire(tmp, 600);
  await p.exec();
  await redis.multi()
    .rename(tmp, live)                  // atomic swap: readers see old or new board, never partial
    .expire(live, 6 * 3600)
    .hset(redisKeys.leaderboardMeta(scope, w), { runId: runId.toString(), computedAt: new Date().toISOString(), count: top.length })
    .hincrby(redisKeys.leaderboardMeta(scope, w), 'version', 1)
    .exec();
}
```

If `top` is empty, `DEL live` instead (`RENAME` of a missing key errors). Cards (`card:{itemId}:{window}`) are written with `MSET` plus per-key `EXPIRE` in the pipeline before the swap.

After all boards are swapped, the worker publishes:

```json
// PUBLISH events:leaderboard
{ "type": "leaderboard.updated", "scope": "github", "window": "24h", "runId": "81234",
  "computedAt": "2026-10-17T14:40:12Z",
  "movers": [ { "itemId": "123", "rank": 1, "prevRank": 7, "delta": 412 } ],
  "entered": ["456"], "exited": ["789"] }
```

`movers` lists the top 20 by |rank change| within the top 100; `prevRank` comes from the previous ZSET before the swap (read with `ZREVRANK` in the same pass).

### 9.3 Read paths

- **`GET /v1/trending` (no topic/kind/minCurrent filters):** `HGET lbmeta` (for the ETag) → if `If-None-Match` matches, return 304 → else `ZRANGE lb:... +inf -inf BYSCORE REV LIMIT 0 {limit+1}` (or from the cursor) → `MGET card:*` → respond. **No Postgres hit.** Missing cards (rare) are hydrated from Postgres in one `WHERE id = ANY($1)` query.
- **With topic/kind/minCurrent filters:** a SQL query on `scores` joined with `score_runs_current`, `items` and `item_topics`, using keyset pagination. The result is cached under `q:{hash}` for 60 s. `scores` holds only eligible rows (8.4), which is exactly the population of the Redis boards, so both paths return the same items.
- **Redis down:** degrade to the same SQL path (circuit breaker: after 5 consecutive Redis errors, skip Redis for 30 s). `/readyz` reports `redis: degraded` but stays 200, because the API can still serve.
- **Item detail:** read-through `item:{id}` (300 s). Invalidate with `DEL item:{id}` on `refresh-item`, admin item patch, and alias changes. Score changes are acceptable at up to 5 minutes stale; the leaderboard is the source of truth for ranks.

### 9.4 HTTP caching, ETag and Cloudflare

| Route | Cache-Control | ETag |
|---|---|---|
| `GET /v1/trending` | `public, max-age=60, s-maxage=300, stale-while-revalidate=600` | `W/"lb-{scope}-{window}-{version}-{sha1(query).slice(0,8)}"` |
| `GET /v1/items/:id`, `/history`, `/scores`, `/aliases` | `public, max-age=60, s-maxage=300, stale-while-revalidate=600` | `W/"{sha1(body)}"` (computed by the etag plugin) |
| `GET /v1/search`, `/v1/topics`, `/v1/languages`, `/v1/new`, `/v1/compare` | `public, max-age=60, s-maxage=120` | body hash |
| `/v1/me/*`, `/v1/auth/*`, `/v1/admin/*` | `private, no-store` | none |
| `GET /v1/stream/leaderboard` | `no-cache, no-transform` + `X-Accel-Buffering: no` | none |
| `/metrics`, `/healthz`, `/readyz` | `no-store` | none |

Cloudflare configuration:
- Cache rule "Cache Everything" for `api.trendr.<domain>/v1/(trending|items|search|topics|languages|new|compare)*`, respecting origin headers, with the query string in the cache key.
- Bypass for `/v1/me*`, `/v1/auth*`, `/v1/admin*` and `/v1/stream*`, plus any request carrying an `Authorization` or `X-API-Key` header.
- SSE: disable buffering through response headers. Cloudflare closes idle connections after ~100 s (verify for your plan), so the server sends a heartbeat comment every 25 s.
- Optional stretch: after a scoring run, purge `/v1/trending*` by prefix via the Cloudflare API (`CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_TOKEN`).

---

## 10. REST API

Base URL: `https://api.trendr.<domain>` (local: `http://localhost:4000`). Everything is versioned under `/v1`. JSON bodies use camelCase. **Ids (`bigint`) are serialized as strings.** Timestamps are ISO-8601 UTC.

### 10.1 Endpoint list

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/healthz` | none | Liveness: process up |
| GET | `/readyz` | none | Readiness: DB ping, Redis ping, migrations at head |
| GET | `/metrics` | `Authorization: Bearer ${METRICS_TOKEN}` or internal network | Prometheus metrics |
| GET | `/docs`, `/openapi.json` | none | Swagger UI, OpenAPI 3.1 |
| GET | `/v1/trending` | optional key | Leaderboard (10.3) |
| GET | `/v1/new` | optional key | Newly discovered items (`source`, `kind`, `days≤30`, cursor) sorted by `upstream_created_at desc` |
| GET | `/v1/items/:id` | optional key | Item detail (id = numeric id) |
| GET | `/v1/items/lookup?source=&externalId=` | optional key | Resolve a natural key to an item (302 to `/v1/items/:id`) |
| GET | `/v1/items/:id/history` | optional key | Metric series from `snapshots`/`daily_metrics` (not `scores`): `metric`, `from`, `to`, `granularity=hour|day` (hour allowed for ranges ≤ 14 d) |
| GET | `/v1/items/:id/scores` | optional key | Score history (`ScoresQuery`, 10.4): `window`, `granularity=hour|day`, `days`. **hour**: every run, only within the last `SCORES_HOURLY_RETENTION_HOURS` (48 h; `days ≤ 2`); **day** (default): one point per UTC day (the last run of that day), `days ≤ SCORES_DAILY_RETENTION_DAYS` (365). Runs in which the item was ineligible have no point (gap) |
| GET | `/v1/items/:id/score-explain` | optional key | `ScoreComponents` + params + inputs for the current run; `null` components with `reason: 'not_eligible'` when the item has no row in the current run |
| GET | `/v1/items/:id/aliases` | optional key | Linked items across sources |
| GET | `/v1/search` | optional key | `q` (2–100 chars), `source`, `kind`, `limit`, `cursor` |
| GET | `/v1/topics` | optional key | `source`, `limit≤200`, sorted by item_count |
| GET | `/v1/languages` | optional key | Languages that have leaderboards |
| GET | `/v1/compare` | optional key | `ids` (2–5, comma-separated), `metric`, `window`, `granularity` |
| GET | `/v1/stats` | none | Public status: item counts per source, last successful run per source and job type |
| GET | `/v1/stream/leaderboard` | optional key | **SSE** live updates (10.6) |
| POST | `/v1/auth/magic-link` | none | `{ email }` → 202 (always, to avoid account enumeration) |
| POST | `/v1/auth/verify` | none | `{ token }` → `{ accessToken, expiresIn, user }` and sets the `dt_refresh` cookie |
| POST | `/v1/auth/refresh` | cookie | Rotates the refresh token → new access token |
| POST | `/v1/auth/logout` | cookie | Revokes the refresh family and clears the cookie |
| GET / PATCH / DELETE | `/v1/me` | JWT | Profile; DELETE erases the account (GDPR) |
| GET / POST | `/v1/me/watchlists` | JWT | List / create |
| PATCH / DELETE | `/v1/me/watchlists/:watchlistId` | JWT | Rename / delete |
| GET | `/v1/me/watchlists/:watchlistId/items` | JWT | Items with current 24h/7d scores |
| PUT / DELETE | `/v1/me/watchlists/:watchlistId/items/:itemId` | JWT | Add (idempotent PUT) / remove |
| GET / POST | `/v1/me/alerts` | JWT | List / create alert rule |
| PATCH / DELETE | `/v1/me/alerts/:alertId` | JWT | Update / delete |
| GET | `/v1/me/alert-events` | JWT | Fired alerts (cursor) |
| GET / PUT | `/v1/me/digest` | JWT | Digest subscription (upsert) |
| GET / POST | `/v1/me/api-keys` | JWT | List (prefix only) / create (the full key is shown once) |
| DELETE | `/v1/me/api-keys/:keyId` | JWT | Revoke |
| GET | `/v1/unsubscribe?token=` | signed token | Shows confirmation (JSON; the web renders it) |
| POST | `/v1/unsubscribe?token=` | signed token | One-click unsubscribe (RFC 8058 `List-Unsubscribe-Post`) |
| POST | `/v1/admin/ingest` | admin | `{ source, type: discover|snapshot|daily|backfill|refresh-item, strategy?, tier?, itemId?, days? }` → 202 `{ jobId, queue }` |
| POST | `/v1/admin/score` | admin | `{ source | 'all' }` → 202 |
| GET | `/v1/admin/runs` | admin | `source`, `jobType`, `status`, `from`, `cursor` |
| GET | `/v1/admin/runs/:runId` | admin | Run detail |
| GET | `/v1/admin/queues` | admin | Per-queue counts (waiting, active, delayed, failed, completed) |
| GET | `/v1/admin/dlq` | admin | Dead-letter jobs (cursor) |
| POST | `/v1/admin/dlq/:jobId/retry` | admin | Re-enqueue to the original queue |
| DELETE | `/v1/admin/dlq/:jobId` | admin | Discard |
| GET | `/v1/admin/rate-limits` | admin | Bucket states plus last upstream headers |
| PATCH | `/v1/admin/items/:id` | admin | `{ tier?, addFlags?, removeFlags? }` (e.g. `manual_hidden`) |

### 10.2 Common schemas (`apps/api/src/schemas/common.ts`)

```ts
import { z } from 'zod';
import { LeaderboardScopeSchema, SourceSchema, ItemKindSchema, WindowSchema, MetricSchema } from '@trendr/core';

export const IdParam = z.object({ id: z.string().regex(/^\d{1,19}$/) });

/** Opaque cursor = base64url(JSON). Encodes the run id so pages stay consistent across scoring runs. */
export const LeaderboardCursor = z.object({ r: z.string(), s: z.number(), i: z.string() }); // runId, score, itemId
export const KeysetCursor = z.object({ k: z.union([z.string(), z.number()]), i: z.string() });
export const encodeCursor = (c: unknown) => Buffer.from(JSON.stringify(c)).toString('base64url');
export const decodeCursor = <T>(raw: string, schema: z.ZodType<T>): T =>
  schema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));

export const PageMeta = z.object({ nextCursor: z.string().nullable(), limit: z.number().int() });

/** RFC 7807 problem details. */
export const Problem = z.object({
  type: z.string().url(),                    // https://trendr.dev/problems/{type}
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string(),                      // request path
  requestId: z.string(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
```

### 10.3 `GET /v1/trending`

```ts
// apps/api/src/schemas/trending.ts
export const TrendingQuery = z.object({
  scope: LeaderboardScopeSchema.default('all'),
  window: WindowSchema.default('24h'),
  lang: z.string().trim().toLowerCase().max(40).optional(),
  topic: z.string().regex(/^[a-z0-9][a-z0-9-]{0,49}$/).optional(),
  kind: ItemKindSchema.optional(),
  newOnly: z.enum(['true', 'false', '1', '0']).optional()
    .transform((v) => v === 'true' || v === '1'),     // default false; upstream_created_at within 30 d
                                                       // (coercing with Boolean() would turn 'false' into true)
  minCurrent: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

export const LeaderboardEntryDto = z.object({
  rank: z.number().int().positive(),
  item: z.object({
    id: z.string(), source: SourceSchema, kind: ItemKindSchema, externalId: z.string(),
    displayName: z.string(), description: z.string().nullable(), url: z.string().url(),
    language: z.string().nullable(), topics: z.array(z.string()), primaryMetric: MetricSchema,
  }),
  window: WindowSchema,
  delta: z.number(), relGrowth: z.number(), score: z.number(), percentile: z.number(),
  current: z.number(), sparkline: z.array(z.number()).max(30),
  flags: z.array(z.enum(['below_threshold', 'insufficient_data', 'burst_suspected', 'new_item', 'negative_growth'])),
});

export const TrendingResponse = z.object({
  scope: LeaderboardScopeSchema, window: WindowSchema,
  runId: z.string(), computedAt: z.string().datetime(),
  data: z.array(LeaderboardEntryDto),
  page: PageMeta,
});
```

Example: `GET /v1/trending?scope=github&window=7d&lang=typescript&limit=2`

```json
{
  "scope": "github", "window": "7d", "runId": "81234", "computedAt": "2026-10-17T14:40:12Z",
  "data": [
    { "rank": 1, "item": { "id": "1042", "source": "github", "kind": "repo", "externalId": "acme/brand-new",
      "displayName": "acme/brand-new", "description": "Agent toolkit", "url": "https://github.com/acme/brand-new",
      "language": "TypeScript", "topics": ["ai-agents","mcp"], "primaryMetric": "stars" },
      "window": "7d", "delta": 900, "relGrowth": 9, "score": 7.49, "percentile": 99.7, "current": 900,
      "sparkline": [0, 40, 180, 420, 610, 800, 900], "flags": ["new_item"] }
  ],
  "page": { "nextCursor": "eyJyIjoiODEyMzQiLCJzIjo1LjQwOSwiaSI6IjEwMzMifQ", "limit": 2 }
}
```

### 10.4 Item detail schema

```ts
export const ItemDetailResponse = z.object({
  id: z.string(), source: SourceSchema, kind: ItemKindSchema, externalId: z.string(),
  name: z.string(), displayName: z.string(), description: z.string().nullable(),
  url: z.string().url(), homepage: z.string().nullable(), language: z.string().nullable(),
  license: z.string().nullable(), owner: z.string().nullable(), topics: z.array(z.string()),
  primaryMetric: MetricSchema, latestMetrics: z.record(MetricSchema, z.number()),
  tier: z.enum(['hot', 'warm', 'cold', 'archived']), flags: z.array(z.string()),
  upstreamCreatedAt: z.string().datetime().nullable(), firstSeenAt: z.string().datetime(),
  lastSnapshotAt: z.string().datetime().nullable(),
  scores: z.record(WindowSchema, z.object({
    rankSource: z.number().int().nullable(), rankAll: z.number().int().nullable(),
    delta: z.number(), relGrowth: z.number(), finalScore: z.number(), zScore: z.number(), percentile: z.number(),
    flags: z.array(z.string()),
  }).nullable()),
  aliases: z.array(z.object({ id: z.string(), source: SourceSchema, displayName: z.string(), relation: z.string(), confidence: z.number() })),
  metadata: z.record(z.string(), z.unknown()),
});

export const HistoryQuery = z.object({
  metric: MetricSchema.optional(),                       // default: item.primaryMetric
  from: z.string().datetime().optional(),                // default: now - 30d
  to: z.string().datetime().optional(),                  // default: now
  granularity: z.enum(['hour', 'day']).default('day'),
}).refine((q) => q.granularity === 'day' || !q.from || Date.now() - Date.parse(q.from) <= 14 * 864e5,
          { message: 'hour granularity limited to 14 days' });
export const HistoryResponse = z.object({
  itemId: z.string(), metric: MetricSchema, kind: z.enum(['cumulative', 'daily_count', 'gauge']),
  granularity: z.enum(['hour', 'day']),
  points: z.array(z.object({ t: z.string(), v: z.number() })),
});

/** Score history. Limits mirror scores retention (6.5); the route reads env for the actual bounds. */
export const ScoresQuery = z.object({
  window: WindowSchema.default('7d'),
  granularity: z.enum(['hour', 'day']).default('day'),
  days: z.coerce.number().int().min(1).max(365).default(30),        // capped at SCORES_DAILY_RETENTION_DAYS
}).refine((q) => q.granularity === 'day' || q.days <= 2,             // 2 d = SCORES_HOURLY_RETENTION_HOURS / 24
          { message: 'hour granularity limited to the last 48 hours' });
export const ScoresResponse = z.object({
  itemId: z.string(), window: WindowSchema, granularity: z.enum(['hour', 'day']),
  // hour: one point per run (last 48 h). day: the last run of each UTC day (from hourly rows for the newest days,
  // from the retained daily runs beyond). Missing points = item ineligible in that run.
  points: z.array(z.object({ t: z.string().datetime(), runId: z.string(), finalScore: z.number(), zScore: z.number(),
                             percentile: z.number(), rankSource: z.number().int().nullable(), delta: z.number() })),
});
```

The other request bodies:

```ts
export const CreateWatchlistBody = z.object({ name: z.string().trim().min(1).max(80) });
export const AlertParamsSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('velocity_spike'), minPercentile: z.number().min(50).max(100).default(95),
             minDeltaMultiple: z.number().min(1).max(100).default(3) }),       // delta ≥ 3× trailing avg
  z.object({ type: z.literal('rank_entered'), scope: LeaderboardScopeSchema, topN: z.number().int().min(1).max(100),
             lang: z.string().optional(), topic: z.string().optional() }),
  z.object({ type: z.literal('threshold_crossed'), metric: MetricSchema, value: z.number().int().positive() }),
  z.object({ type: z.literal('new_alias') }),
]);
export const CreateAlertBody = z.object({
  itemId: z.string().optional(), watchlistId: z.string().uuid().optional(),
  window: WindowSchema.default('24h'), cooldownHours: z.number().int().min(1).max(720).default(24),
  params: AlertParamsSchema,
});
export const DigestBody = z.object({
  enabled: z.boolean(), sources: z.array(SourceSchema).min(1), topics: z.array(z.string()).max(20).default([]),
  includeWatchlist: z.boolean().default(true), dayOfWeek: z.number().int().min(0).max(6).default(1),
});
export const CreateApiKeyBody = z.object({ name: z.string().min(1).max(60), expiresInDays: z.number().int().min(1).max(365).optional() });
export const AdminIngestBody = z.object({
  source: SourceSchema, type: z.enum(['discover', 'snapshot', 'daily', 'backfill', 'refresh-item']),
  strategy: z.string().optional(), tier: z.enum(['hot', 'warm', 'cold']).optional(),
  itemId: z.string().optional(), days: z.number().int().min(1).max(365).optional(),
});
```

Route registration pattern (Fastify + Zod type provider):

```ts
// apps/api/src/routes/trending.ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
export const trendingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/v1/trending', {
    schema: {
      tags: ['trending'], summary: 'Leaderboard by growth velocity',
      querystring: TrendingQuery,
      response: { 200: TrendingResponse, 304: z.null(), 400: Problem, 429: Problem },
    },
    config: { rateLimit: app.rateLimitTier('public') },
  }, async (req, reply) => {
    const res = await app.services.leaderboard.get(req.query, req.headers['if-none-match']);
    if (res.notModified) return reply.code(304).header('ETag', res.etag).send(null);
    reply.header('ETag', res.etag).header('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    return res.body;
  });
};
```

### 10.5 Pagination, errors, rate limits, auth

**Pagination:** cursor-based everywhere (no offset).
- Leaderboards: the cursor `{r: runId, s: score, i: itemId}` pins the **scoring run**, so page 2 matches page 1 even if a new run lands in between. If `r` is still the current run, read from Redis; otherwise read from `scores WHERE run_id = r` with the keyset `(final_score, item_id) < (s, i)`. Every run is kept for `SCORES_HOURLY_RETENTION_HOURS` (48 h); after that only the last run per UTC day survives (6.5), so a cursor whose run has been thinned or aged out returns 410 `cursor-expired`.
- Other lists: keyset on `(sortKey, id)`.
- Responses include `page.nextCursor` (null at the end) and the header `Link: <...&cursor=...>; rel="next"`.

**Errors (RFC 7807):** `Content-Type: application/problem+json`.

```json
{ "type": "https://trendr.dev/problems/validation-error", "title": "Invalid request", "status": 400,
  "detail": "window must be one of 24h, 7d, 30d", "instance": "/v1/trending", "requestId": "req-7f3a",
  "errors": [{ "path": "query.window", "message": "Invalid enum value" }] }
```

Mapping: `ZodError`/Fastify validation → 400 `validation-error`; `AppError` → its own status and type; `@fastify/rate-limit` → 429 `rate-limited` with `Retry-After`; unknown errors → 500 `internal` (message hidden; logged with `requestId`). Problem type documentation lives at `apps/web/src/app/problems/[type]/page.tsx`.

**Rate limits** (`@fastify/rate-limit`, Redis store, key = API key id || user id || IP from `CF-Connecting-IP` when `TRUST_PROXY=true`):

| Tier | Limit | Applies to |
|---|---|---|
| `anonymous` | 60 req/min per IP | Public GETs without a key |
| `apiKey` | `api_keys.rate_limit_per_min` (default 120) | Requests with `X-API-Key` |
| `user` | 300 req/min | JWT-authenticated |
| `auth` | 5 req/min per IP; magic-link 3/hour per email | `/v1/auth/*` |
| `sse` | 5 concurrent streams per IP/key | `/v1/stream/*` (counted in Redis `apirl:sse:{id}` with INCR/DECR) |
| `admin` | 600 req/min | Admin |

Response headers: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After` on 429.

**Authentication:**
- **Users: passwordless magic link → JWT.** `POST /v1/auth/magic-link` stores `auth_tokens(kind='magic_link', token_hash=sha256(token), expires_at=now()+15m)` and emails `${WEB_PUBLIC_URL}/auth/verify?token=...`. `POST /v1/auth/verify` checks single use (`used_at IS NULL`) and expiry, upserts the user (`email_verified_at`), and issues:
  - **Access JWT** (HS256, `JWT_SECRET`, 15 min, claims `sub`, `role`, `iat`, `exp`, `iss=trendr`, `aud=trendr-api`), returned in the body and kept in memory by the web app.
  - **Refresh token**: 32 random bytes in the httpOnly, Secure, SameSite=Lax cookie `dt_refresh` (path `/v1/auth`, 30 days), stored hashed with a `family_id`. On rotation the old token gets `used_at`; **reusing a used refresh token revokes the whole family** (theft detection).
- Library: `@fastify/jwt`. Admins are users whose email is in `ADMIN_EMAILS` (role set on login) or `role='admin'`.
- **Public API keys:** header `X-API-Key: dt_live_<8-char prefix>_<32 random base62 chars>`. Lookup by `prefix`, then constant-time compare of `HMAC-SHA256(API_KEY_PEPPER, key)` with `key_hash`. Update `last_used_at` at most once per minute (debounced in Redis). Scopes: `read` (default) and `admin`. The MCP server uses a `read` key.

**OpenAPI:** `@fastify/swagger` (OpenAPI 3.1) with the Zod type provider's `jsonSchemaTransform`; UI at `/docs`. CI runs `pnpm --filter api openapi:export` and commits `apps/api/openapi.json`; a CI check fails if it is stale. The web client types are generated from it with `openapi-typescript` (or import the Zod schemas directly; both are allowed).

### 10.6 SSE: `GET /v1/stream/leaderboard`

Query: `scope` (default `all`), `window` (default `24h`). Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`.

Events:

```
retry: 5000

id: 81234
event: leaderboard.snapshot
data: {"scope":"github","window":"24h","runId":"81234","top":[{"rank":1,"itemId":"1042","score":7.49,"delta":900}]}

id: 81240
event: leaderboard.update
data: {"scope":"github","window":"24h","runId":"81240","movers":[{"itemId":"123","rank":1,"prevRank":7,"delta":412}],"entered":["456"],"exited":["789"]}

: ping
```

- On connect, send `leaderboard.snapshot` (top 25 from Redis). If the client sends `Last-Event-ID` equal to the current `runId`, skip it.
- `apps/api/src/sse/broadcaster.ts` keeps **one** Redis subscriber per API process (`SUBSCRIBE events:leaderboard`) and fans out to an in-memory `Map<"scope:window", Set<Client>>`.
- Heartbeat `: ping` every 25 s. Backpressure: if `reply.raw.write()` returns false and the socket has not drained within 10 s, drop the client.
- On `close`, remove the client and decrement the SSE counter. On shutdown, end every stream with `event: shutdown`.
- Metric: `trendr_sse_clients{scope,window}` gauge.

nginx: `proxy_buffering off; proxy_read_timeout 1h; proxy_http_version 1.1; proxy_set_header Connection "";`.

---

## 11. MCP Server

`apps/mcp` uses `@modelcontextprotocol/sdk` (^1.32). It supports two transports:
- `MCP_TRANSPORT=stdio`, for Claude Desktop, Cursor and Claude Code (`npx @trendr/mcp` or `node dist/main.js`).
- `MCP_TRANSPORT=http`: **Streamable HTTP** at `POST/GET/DELETE /mcp` on `MCP_PORT=4100`, in stateless mode (`sessionIdGenerator: undefined`). Optional bearer auth (`MCP_HTTP_AUTH_TOKENS`).

All tools call the REST API (`API_INTERNAL_URL`, header `X-API-Key: ${MCP_API_KEY}`). The MCP server has no DB access, so rate limits and caching apply uniformly. Every tool returns both `structuredContent` (JSON matching `outputSchema`) and a compact Markdown `text` block for models that do not read structured output.

> Zod compatibility: SDK 1.x historically targeted Zod v3. Check whether ^1.32 accepts Zod v4 schemas (verify). If it does not, import `zod/v3` inside `apps/mcp` only (Zod 4 ships a v3-compat subpath) and record this in an ADR.

### 11.1 Tools

| Tool | Description (shown to the model) | Input schema | Output |
|---|---|---|---|
| `get_trending` | "Get the fastest-growing developer/AI projects by velocity. Use for 'what's trending in X'." | `{ source?: 'all'|'github'|'npm'|'pypi'|'huggingface'|'arxiv'|'mcp' = 'all', window?: '24h'|'7d'|'30d' = '7d', language?: string, topic?: string, limit?: 1..50 = 10 }` | `{ window, computedAt, items: [{ rank, id, source, name, url, description, delta, relGrowth, percentile, current, flags }] }` |
| `search_items` | "Search tracked repos, packages, models, papers and MCP servers by name or description." | `{ query: string(2..100), source?: Source, kind?: ItemKind, limit?: 1..25 = 10 }` | `{ items: [{ id, source, kind, name, url, description, current, score7d }] }` |
| `get_item_history` | "Get the time series of a metric (stars, downloads, likes, upvotes) for one item." | `{ id?: string, source?: Source, externalId?: string, metric?: Metric, days?: 1..365 = 30, granularity?: 'hour'|'day' = 'day' }` (requires `id` or `source+externalId`) | `{ item: {...}, metric, kind, points: [{ t, v }], summary: { first, last, delta, maxDailyGain } }` |
| `compare_items` | "Compare 2–5 items' growth side by side over a window." | `{ ids: string[2..5], window?: Window = '30d', metric?: Metric }` | `{ window, items: [{ id, name, source, delta, relGrowth, percentile, rankSource }], series: { [id]: [{ t, v }] } }` |
| `whats_new_in_mcp` | "List newly published or fast-rising MCP servers / agent tools." | `{ days?: 1..30 = 7, sort?: 'new'|'rising' = 'rising', limit?: 1..50 = 15 }` | `{ items: [{ id, name, description, url, registryName?, repoUrl?, packages: [{ registryType, identifier }], publishedAt?, delta7d?, current? }] }` |

```ts
// apps/mcp/src/tools/get-trending.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiClient } from '../api-client.js';

export function registerGetTrending(server: McpServer, api: ApiClient): void {
  server.registerTool(
    'get_trending',
    {
      title: 'Get trending items',
      description: "Fastest-growing developer/AI projects ranked by growth velocity. Use for questions like \"what's trending on npm this week\".",
      inputSchema: {
        source: z.enum(['all', 'github', 'npm', 'pypi', 'huggingface', 'arxiv', 'mcp']).default('all'),
        window: z.enum(['24h', '7d', '30d']).default('7d'),
        language: z.string().max(40).optional(),
        topic: z.string().max(50).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ source, window, language, topic, limit }) => {
      const res = await api.trending({ scope: source, window, lang: language, topic, limit });
      const items = res.data.map((e) => ({
        rank: e.rank, id: e.item.id, source: e.item.source, name: e.item.displayName, url: e.item.url,
        description: e.item.description, delta: e.delta, relGrowth: e.relGrowth, percentile: e.percentile,
        current: e.current, flags: e.flags,
      }));
      const text = items.map((i) => `${i.rank}. **${i.name}** (${i.source}) +${i.delta} — ${i.url}`).join('\n');
      return { content: [{ type: 'text', text }], structuredContent: { window, computedAt: res.computedAt, items } };
    },
  );
}
```

Resources (optional): `trendr://leaderboard/{scope}/{window}` (ResourceTemplate) returning the top 25 as JSON. Prompt (optional): `weekly_briefing`, which asks the model to call `get_trending` for each source and summarize.

`whats_new_in_mcp` maps to `GET /v1/new?source=mcp&days=N` (for `new`) and `GET /v1/trending?scope=mcp&window=7d` (for `rising`), merged with `GET /v1/items/:id/aliases` for repo and package links (one call per item, at most 15).

Client config example (`claude_desktop_config.json`):

```json
{ "mcpServers": { "trendr": { "command": "npx", "args": ["-y", "@trendr/mcp"],
  "env": { "MCP_TRANSPORT": "stdio", "API_INTERNAL_URL": "https://api.trendr.example", "MCP_API_KEY": "dt_live_..." } } } }
```

Tests: use the SDK's `Client` with `InMemoryTransport.createLinkedPair()` against a mocked `ApiClient`, and assert each tool's `structuredContent` against its output schema.

---

## 12. Frontend (`apps/web`, Next.js 15 App Router)

### 12.1 Routes

| Route | Rendering | Content |
|---|---|---|
| `/` | Server Component, ISR `revalidate: 60` | Combined "All" leaderboard (24h), source tabs, window switcher, live badge (SSE) |
| `/trending/[scope]` (`?window=&lang=&topic=&kind=&new=`) | Server Component plus a client island for live updates | Full leaderboard with filters; URL search params are the state |
| `/trending/[scope]/[window]` | Same, static params for 7 scopes × 3 windows (prebuilt) | SEO-friendly canonical URLs |
| `/item/[id]/[slug]` | Server Component, ISR 300 | Header (name, source badge, links), metric cards, **history chart**, score chart, score explanation, aliases ("Also on npm / PyPI / MCP registry"), watch button |
| `/compare?ids=1,2,3` | Client (SWR) | Overlay chart, comparison table |
| `/search?q=` | Server Component | Results grouped by source |
| `/new` | Server Component, ISR 300 | New items per source; "New in MCP" section |
| `/topics/[slug]` | Server Component, ISR 300 | Topic leaderboard |
| `/login`, `/auth/verify` | Client | Magic-link flow |
| `/dashboard` | Client (auth) | Watchlists, alert rules, alert events |
| `/settings` | Client (auth) | Digest preferences, API keys, delete account |
| `/unsubscribe` | Server Component | Calls `GET/POST /v1/unsubscribe` |
| `/admin` | Client (admin) | Runs table, queue counts, DLQ (retry/delete), rate-limit buckets, trigger ingestion |
| `/api-docs` | Static | Links to `/docs`, examples, MCP setup |
| `/problems/[type]` | Static | RFC 7807 problem type docs |
| `opengraph-image.tsx` (root, `/item/[id]/[slug]`, `/trending/[scope]`) | Edge, `next/og` `ImageResponse` | Dynamic OG images: name, source icon, delta badge, mini sparkline (SVG path) |
| `sitemap.ts`, `robots.ts` | Dynamic | Top 5,000 items plus all trending routes |

### 12.2 Components (`apps/web/src/components`)

- `leaderboard/LeaderboardTable.tsx` (server): rows with rank, rank-change arrow, name, source badge, language dot, delta (`+1.2k ★ / 7d`), rel-growth %, percentile bar, `Sparkline`, ⚠ burst badge with tooltip.
- `leaderboard/LiveLeaderboard.tsx` (client): wraps the table. Opens an `EventSource` to `${NEXT_PUBLIC_API_URL}/v1/stream/leaderboard?scope&window`. On `leaderboard.update` it calls SWR `mutate()` for the current key and animates rank changes (CSS transform with `prefers-reduced-motion` respected). It reconnects with backoff and shows a "Live" or "Reconnecting" pill.
- `filters/FilterBar.tsx` (client): shadcn `Tabs` (scope), `ToggleGroup` (window), `Combobox` (language/topic from `/v1/languages`, `/v1/topics`), a `Switch` for "new only". Updates search params with `router.replace` (shallow).
- `charts/MetricHistoryChart.tsx`: Recharts `AreaChart` for cumulative metrics and `BarChart` (daily bars) plus a 7-day moving-average `Line` for daily-count metrics. Range buttons for 7d/30d/90d/1y and a log-scale toggle.
- `charts/ScoreHistoryChart.tsx`: a `LineChart` of percentile over time per window.
- `charts/Sparkline.tsx`: tiny inline SVG (no Recharts) for table rows; server-renderable.
- `item/ScoreExplain.tsx`: renders `ScoreComponents` as a formula breakdown (Δ, B, r, raw, factors).
- `item/AliasList.tsx`, `item/WatchButton.tsx` (optimistic SWR mutation), `alerts/AlertRuleForm.tsx` (react-hook-form + the same Zod schema imported from `@trendr/api/schemas`).
- `layout/SourceIcon.tsx`, `ThemeToggle.tsx` (dark mode via `next-themes`).

### 12.3 Data fetching

- `src/lib/api.ts` provides a typed `apiFetch<T>(path, schema, init)`. On the server it uses `API_INTERNAL_URL` (Docker network); on the client, `NEXT_PUBLIC_API_URL`. Responses are validated with Zod in development only (to keep bundles small, gated by `process.env.NODE_ENV`).
- Server Components use `fetch(url, { next: { revalidate: 60, tags: ['trending:github:7d'] } })`.
- Client data: SWR with `refreshInterval: 0` (SSE drives updates) and `keepPreviousData: true`. User data uses the auth context: the access token lives in memory, and a 401 triggers `/v1/auth/refresh` once and retries.
- No direct DB access from web. The web app is a pure API client, which keeps one source of truth.

### 12.4 SEO

- `generateMetadata` per page: title `"{name}: +{delta} stars this week · Trendr"`, description, canonical URL, `openGraph.images` from `opengraph-image.tsx`.
- JSON-LD: `SoftwareSourceCode` for repos and packages, `ScholarlyArticle` for papers, `ItemList` for leaderboards.
- Item URLs carry a slug (`/item/1042/acme-brand-new`); a wrong slug redirects to the canonical one with a 308.
- Performance budget: LCP < 2.0 s on 4G, JS < 150 kB gz on leaderboard pages (charts loaded with `next/dynamic` on the item page only).

---

## 13. Notifications

### 13.1 Alert rules

| Type | Fires when (evaluated after each scoring run, for the rule's window) | Target |
|---|---|---|
| `velocity_spike` | `percentile ≥ minPercentile` **and** `delta ≥ minDeltaMultiple × trailingAvgDelta`, where `trailingAvgDelta` is the mean window delta over the previous 4 equivalent windows (from `scores` daily points; a missing point means the item was ineligible then and counts as delta 0) | item or watchlist (each item) |
| `rank_entered` | Item newly appears in the top `topN` of `lb:{scope}:{window}:{lang}` (in `entered` or rank ≤ topN with prevRank > topN or null), optionally filtered by topic | global filter (no item) |
| `threshold_crossed` | `latest_metrics[metric]` crosses `value` upward since the previous run | item or watchlist |
| `new_alias` | A new `item_aliases` row involves the item (e.g. a repo gets an npm package or an MCP registry entry) | item or watchlist |

`apps/worker/src/notify/evaluate-alerts.ts`:
1. Load enabled alerts relevant to the `source` of the run: `type='rank_entered'`, or `item_id`/watchlist items whose source matches.
2. For each candidate (alert, item), evaluate the rule against the current and previous run's `scores` (both within the 48 h hourly tier). An item with no row in a run was ineligible in that run (not ranked, no score).
3. Respect the cooldown: skip if `last_triggered_at > now() - cooldown_hours`.
4. Insert `alert_events` with `dedupe_key = {alertId}:{itemId}:{window}:{floor(epochHours / cooldown_hours)}` using `ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, so retries never double-fire.
5. For each new event, enqueue `notify:send-alert-email` (`jobId=alert.{eventId}`) and update `alerts.last_triggered_at`.
6. Batching: if one user has more than 5 events in one run, send a single combined email (group by `user_id`).

### 13.2 Weekly digest

- `digest:build-weekly-digest` runs daily at 08:00 UTC. It selects `digest_subscriptions WHERE enabled AND unsubscribed_at IS NULL AND day_of_week = extract(dow from now())`, then enqueues one `send-digest` per subscription (`jobId=digest.{subId}.{weekStart}`).
- Content is computed once per day and cached in Redis as `digest:content:{date}` (24 h):
  - Top 10 per subscribed source (7d window, from `lb:{source}:7d:_all`).
  - Top 5 "All" board.
  - Top 5 new MCP servers.
  - Top 5 papers by upvotes.
- `send-digest` personalizes the email: subscribed sources and topics, plus "Your watchlist this week" (each watched item's 7d delta and rank change). It inserts `digest_sends (status='pending')` with `ON CONFLICT (subscription_id, week_start) DO NOTHING`; if no row was inserted, a send already happened, so it skips. It then sends and updates the row to `sent` with `provider_message_id`.
- Empty digests (no subscribed sources with data) get status `skipped`.

### 13.3 Email

```ts
// apps/worker/src/notify/email.ts
export interface EmailMessage {
  to: string; subject: string; html: string; text: string;
  headers?: Record<string, string>; tags?: Record<string, string>; idempotencyKey?: string;
}
export interface EmailSender { send(msg: EmailMessage): Promise<{ id: string }> }
// ResendEmailSender (EMAIL_PROVIDER=resend): uses `resend.emails.send` with an idempotency key if supported (verify)
// SmtpEmailSender  (EMAIL_PROVIDER=smtp): nodemailer → Mailpit in dev (http://localhost:8025 UI)
```

- Templates use `@react-email/components` and render to HTML plus plain text: `templates/alert.tsx` (item name, rule, delta, sparkline image via the OG endpoint, CTA to the item page) and `templates/digest.tsx` (sections per source, compact tables, "Manage preferences" and "Unsubscribe" footer links).
- Snapshot tests render each template with fixed fixtures (`vitest` `toMatchFileSnapshot`).
- Sender `EMAIL_FROM="Trendr <digest@mail.trendr.example>"`. The domain must have SPF, DKIM (from Resend) and DMARC records.
- Throughput: BullMQ `limiter: { max: 2, duration: 1000 }` on the `digest` and `notify` workers (check Resend plan limits; verify).

### 13.4 Unsubscribe

- Token: `base64url(userId.purpose.exp) + "." + HMAC-SHA256(UNSUBSCRIBE_SECRET, payload)`, where `purpose ∈ {digest, alerts, all}` and `exp` is 90 days out. No DB lookup is needed to validate it.
- Headers on every email: `List-Unsubscribe: <https://api.../v1/unsubscribe?token=...>, <mailto:unsubscribe@...?subject=...>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058; Gmail and Yahoo bulk-sender requirement).
- `POST /v1/unsubscribe` sets `digest_subscriptions.unsubscribed_at`, disables alerts (for purpose `alerts` or `all`), and returns 200 even if the user is already unsubscribed (idempotent).

---

## 14. Observability

### 14.1 Metrics (prom-client; prefix `trendr_`; default Node metrics on via `collectDefaultMetrics({ prefix: 'trendr_' })`)

| Metric | Type | Labels | Where |
|---|---|---|---|
| `trendr_http_requests_total` | counter | `method, route, status` | api |
| `trendr_http_request_duration_seconds` | histogram (0.005…5) | `method, route` | api |
| `trendr_ingestion_duration_seconds` | histogram (1…1800) | `source, job_type, status` | worker |
| `trendr_ingestion_items_total` | counter | `source, job_type, result=upserted|failed|not_modified` | worker |
| `trendr_source_api_requests_total` | counter | `source, endpoint, status` | worker |
| `trendr_source_api_errors_total` | counter | `source, endpoint, kind=rate_limited|server|client|network|schema` | worker |
| `trendr_source_api_duration_seconds` | histogram | `source, endpoint` | worker |
| `trendr_rate_limit_remaining` | gauge | `source, resource` | worker (from upstream headers) |
| `trendr_rate_limit_wait_seconds` | histogram | `bucket` | worker (time blocked in `take`) |
| `trendr_queue_depth` | gauge | `queue, state=waiting|active|delayed|failed` | worker (polled every 15 s via `getJobCounts`) |
| `trendr_job_duration_seconds` | histogram | `queue, name, status` | worker |
| `trendr_dlq_jobs_total` | counter | `queue` | worker |
| `trendr_scoring_duration_seconds` | histogram | `source, window` | worker |
| `trendr_scoring_items` | gauge | `source, window, eligibility=eligible|ineligible` | worker (ineligible items are counted here but get no `scores` row) |
| `trendr_scoring_anomalies_total` | counter | `source, type=burst|spike|reset` | worker |
| `trendr_data_freshness_seconds` | gauge | `source, tier` (now − max(last_snapshot_at)) | worker (every 60 s) |
| `trendr_cache_requests_total` | counter | `cache=leaderboard|item|history|query, result=hit|miss` | api |
| `trendr_sse_clients` | gauge | `scope, window` | api |
| `trendr_alerts_fired_total` | counter | `type` | worker |
| `trendr_emails_sent_total` | counter | `template, status` | worker |
| `trendr_db_pool_connections` | gauge | `state=total|idle|waiting` | api, worker |
| `trendr_snapshots_default_rows` | gauge | none | worker (set by `maintenance:create-partitions` from `SELECT count(*) FROM snapshots_default`; must be 0) |

Rules: label cardinality must stay bounded, so never use item ids as labels. `route` is the Fastify route pattern (`/v1/items/:id`), not the raw URL.

### 14.2 Prometheus alert rules (`infra/prometheus/alerts.yml`)

```yaml
groups:
  - name: trendr
    rules:
      - alert: IngestionStale
        expr: trendr_data_freshness_seconds{tier="hot"} > 3 * 3600
        for: 15m
        labels: { severity: warning }
        annotations: { summary: "Hot tier for {{ $labels.source }} is stale" }
      - alert: UpstreamRateLimited
        expr: increase(trendr_source_api_errors_total{kind="rate_limited"}[15m]) > 5
        labels: { severity: warning }
      - alert: DeadLetterGrowing
        expr: trendr_queue_depth{queue="dead-letter",state="waiting"} > 20
        labels: { severity: critical }
      - alert: ApiHighErrorRate
        expr: sum(rate(trendr_http_requests_total{status=~"5.."}[5m])) / sum(rate(trendr_http_requests_total[5m])) > 0.02
        for: 10m
        labels: { severity: critical }
      - alert: ApiSlowLeaderboard
        expr: histogram_quantile(0.95, sum by (le) (rate(trendr_http_request_duration_seconds_bucket{route="/v1/trending"}[5m]))) > 0.2
        for: 10m
        labels: { severity: warning }
      - alert: SnapshotsDefaultNotEmpty
        expr: trendr_snapshots_default_rows > 0
        labels: { severity: critical }
        annotations: { summary: "snapshots_default holds {{ $value }} rows; creating a partition for that range will fail (see 6.3)" }
```

### 14.3 Logging (pino)

- `packages/logger`: `createLogger({ service: 'api'|'worker'|'mcp'|'web' })` emits JSON with `level, time, service, env, version (git sha), msg`.
- Redaction paths: `req.headers.authorization`, `req.headers.cookie`, `req.headers["x-api-key"]`, `*.token`, `*.email` (hashed in production via a custom serializer), `*.GITHUB_TOKENS`.
- The API uses Fastify's request logger with `requestIdHeader: 'x-request-id'` (generated if absent and echoed in the response); the request id is included in RFC 7807 bodies.
- Workers use child loggers with `{ queue, jobId, jobName, source, runId, attempt }`. Each job logs exactly one `job.completed` or `job.failed` summary line with counters (the same numbers as `ingestion_runs`).
- In production, logs go to stdout and are collected by the platform (Render/Fly logs, or Loki/Promtail on a VPS as a stretch).

### 14.4 Health checks

- `GET /healthz` → `{ status: 'ok', uptimeSec }` (no dependencies; used for liveness).
- `GET /readyz` → checks `SELECT 1` (timeout 1 s), Redis `PING` (1 s), and migrations at head (compares `__drizzle_migrations` count with the bundled journal). Response: `{ status: 'ready'|'degraded'|'unready', checks: { db, redis, migrations } }`. Returns 503 only if the DB or migrations fail; a Redis failure gives `degraded` with 200 (the API degrades gracefully).
- The worker exposes `GET :9464/healthz`, which reports Redis connected, the last successful job per queue, and whether the scheduler is registered, plus `GET :9464/metrics`, which requires `Authorization: Bearer ${METRICS_TOKEN}` (401 otherwise), the same rule as the API's `/metrics`. Port 9464 is **never published on the host**: compose uses `expose` only, Prometheus scrapes `worker:9464` on the Docker network, and CI checks `/healthz` with `docker compose exec worker` (17.4).
- Docker `HEALTHCHECK` uses `node -e "fetch('http://localhost:4000/healthz').then(r=>process.exit(r.ok?0:1))"` (no curl in the distroless-like image).

### 14.5 Grafana dashboard ("Trendr Overview", provisioned JSON)

| Row | Panels |
|---|---|
| API | RPS by route; p50/p95/p99 latency; 4xx/5xx rate; cache hit ratio; SSE clients |
| Ingestion | Job throughput by source; job duration p95; items upserted/failed; data freshness per source and tier (stat panels, red when above 2× cadence) |
| Upstream | `rate_limit_remaining` per source (GitHub core, search, GraphQL; HF); API errors by kind; rate-limit wait time |
| Queues | Depth by queue and state; DLQ size; job failure rate |
| Scoring | Duration by source and window; eligible items; anomalies |
| Runtime | Event loop lag, heap, GC, DB pool usage |

### 14.6 OpenTelemetry (optional)

Enable with `OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT`. Use `@opentelemetry/sdk-node` with auto-instrumentations for http/undici, pg, ioredis and fastify, plus `bullmq-otel` for job spans (a BullMQ peer). Propagate trace context from the API to jobs via job data `_trace`. `docker-compose.yml` includes Jaeger under profile `obs`.

---

## 15. Security

| Area | Measures |
|---|---|
| Secrets | Env vars only, validated at boot by a Zod schema in `packages/config/src/env.ts`. The process exits with a readable error if a variable is missing or invalid. `.env` is git-ignored; CI runs `gitleaks` on every PR. In production, secrets live in the platform secret store (Render/Fly secrets, Docker secrets on a VPS). Never log env; pino redaction (14.3). |
| GitHub token | Fine-grained PAT, **public repositories read-only, no write permissions**, 90-day expiry with a calendar reminder; documented rotation in the runbook. Used only by the worker container (the API never receives it). Its expiry date comes from the `github-authentication-token-expiration` response header (verify) and is exported as a metric. |
| HF token | Read-only token, worker only. |
| Input validation | Every route has Zod schemas for params, query, body and headers. Fastify rejects unknown body properties (`z.strictObject` for bodies). Length limits on all strings. `bodyLimit: 64 kB`. |
| SQL injection | Drizzle parameterized queries only. `sql.raw` is banned by an ESLint rule outside `packages/db/migrations`; dynamic ORDER BY uses whitelisted enums only. |
| SSRF | Workers call **only** an allowlist of upstream hosts (`api.github.com`, `registry.npmjs.org`, `api.npmjs.org`, `pypi.org`, `pypistats.org`, `huggingface.co`, `export.arxiv.org`, `registry.modelcontextprotocol.io`), enforced in `fetch-json.ts`: URL parse → `hostname ∈ ALLOWED_UPSTREAM_HOSTS` → https only. URLs from upstream payloads (homepage, repository, remotes) are **never fetched**; they are stored and rendered as links with `rel="noopener nofollow ugc"`. OG images use only DB data, with no remote image fetching. |
| XSS | React escapes output by default. Descriptions are plain text; README rendering is out of scope. If it is added later, use `rehype-sanitize`. CSP via Next middleware: `default-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com https://cdn-avatars.huggingface.co; connect-src 'self' ${API}; frame-ancestors 'none'`. |
| HTTP headers | `@fastify/helmet` (HSTS 1 year with includeSubDomains, `noSniff`, `frameguard: deny`, `referrerPolicy: strict-origin-when-cross-origin`). |
| CORS | `@fastify/cors` with `origin` = `CORS_ORIGINS` (comma list; the web origin) and `credentials: true` for `/v1/auth/*` and `/v1/me/*`. Public GET endpoints allow `*` without credentials (a route-level override) so third parties can call the public API from browsers. |
| CSRF | The refresh cookie is `SameSite=Lax`, path-scoped to `/v1/auth`, and refresh/logout require the header `X-Requested-With: trendr` (custom header ⇒ CORS preflight). Other state-changing endpoints use Bearer tokens, not cookies. |
| AuthN/Z | JWT verification with `iss`/`aud` checks, 15-minute access tokens, rotating refresh tokens with reuse detection; admin routes need `role=admin` or the API key scope `admin`. Ownership checks on every `/v1/me/*` resource (`WHERE user_id = $sub`), covered by tests for IDOR (one user cannot read or modify another user's watchlist or alert, which returns 404). |
| Rate limits and abuse | Section 10.5. Magic-link endpoint: 3/hour per email, 5/min per IP, a generic 202 response (no account enumeration), and an optional Cloudflare Turnstile check (`TURNSTILE_SECRET`). Per-user caps: at most 20 watchlists, 500 items per watchlist, 50 alerts, 5 API keys. SSE connection caps. Cloudflare WAF and bot fight mode in front. |
| Proxy trust | `trustProxy` is set to the nginx/Cloudflare hops only (`TRUST_PROXY=true` uses `CF-Connecting-IP`); the API is never exposed directly in production (Docker network plus firewall allowing only Cloudflare IP ranges, or Cloudflare Tunnel). |
| Dependencies | `pnpm audit --prod` in CI (fails on high severity), Renovate weekly, Docker base `node:22-alpine` pinned by digest, non-root `USER node`, read-only root filesystem where possible. |
| Data protection | Stored PII is the email only. `DELETE /v1/me` hard-deletes the user (cascades). Hashes for all tokens and keys. Postgres TLS (`sslmode=require`) in production. |
| Upstream ToS | Respect documented limits (Section 7). Send a User-Agent with contact info. Do not store or serve arXiv PDFs. Attribute sources in the UI footer ("Data from GitHub, npm, PyPI/pypistats, Hugging Face, arXiv, MCP Registry"). |

`packages/config/src/env.ts`:

```ts
import { z } from 'zod';
const csv = z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: z.string().url(),
  API_PORT: z.coerce.number().int().default(4000),
  API_PUBLIC_URL: z.string().url(),
  API_INTERNAL_URL: z.string().url().default('http://api:4000'),
  WEB_PUBLIC_URL: z.string().url(),
  CORS_ORIGINS: csv,
  TRUST_PROXY: bool.default('false'),
  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SEC: z.coerce.number().int().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().default(30),
  API_KEY_PEPPER: z.string().min(32),
  UNSUBSCRIBE_SECRET: z.string().min(32),
  METRICS_TOKEN: z.string().min(16),
  ADMIN_EMAILS: csv.default(''),
  GITHUB_TOKENS: csv.optional(),                       // required when WORKER_ROLES includes ingest
  GITHUB_RESERVE: z.coerce.number().int().default(200),
  HF_TOKEN: z.string().optional(),
  HF_RATE_PER_5MIN: z.coerce.number().int().default(1000),
  HF_INCLUDE_DATASETS: bool.default('false'),
  HF_INCLUDE_SPACES: bool.default('false'),
  HTTP_USER_AGENT: z.string().default('Trendr/1.0 (+https://github.com/nayankunwar/trendr)'),
  WORKER_ROLES: csv.default('scheduler,ingest,scoring,notify'),
  WORKER_CONCURRENCY_INGEST: z.coerce.number().int().default(4),
  WORKER_METRICS_PORT: z.coerce.number().int().default(9464),
  SCHEDULER_ENABLED: bool.default('true'),
  TRACKED_MAX_GITHUB: z.coerce.number().int().default(50000),
  TRACKED_MAX_NPM: z.coerce.number().int().default(10000),
  TRACKED_MAX_PYPI: z.coerce.number().int().default(2000),
  TRACKED_MAX_HUGGINGFACE: z.coerce.number().int().default(13000),
  TRACKED_HOT_MAX_GITHUB: z.coerce.number().int().default(2000),
  TRACKED_HOT_MAX_HUGGINGFACE: z.coerce.number().int().default(1000),
  NPM_MIN_WEEKLY_DOWNLOADS: z.coerce.number().int().default(200),
  PYPI_MIN_WEEKLY_DOWNLOADS: z.coerce.number().int().default(500),
  BACKFILL_GITHUB_MAX_PAGES: z.coerce.number().int().default(50),
  BACKFILL_GITHUB_PER_HOUR: z.coerce.number().int().default(200),
  FANOUT_BATCH_ITEMS: z.coerce.number().int().default(500),
  LB_MAX_SIZE: z.coerce.number().int().default(1000),
  ALL_BOARD_MAX_SHARE: z.coerce.number().min(0.1).max(1).default(0.4),
  SNAPSHOT_RETENTION_MONTHS: z.coerce.number().int().min(1).default(3),
  SCORES_HOURLY_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).default(48),  // every scoring run kept this long
  SCORES_DAILY_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(365),  // then last run per UTC day
  TIMESCALE_ENABLED: bool.default('false'),
  EMAIL_PROVIDER: z.enum(['resend', 'smtp', 'log']).default('smtp'),
  RESEND_API_KEY: z.string().optional(),
  SMTP_URL: z.string().default('smtp://mailpit:1025'),
  EMAIL_FROM: z.string().default('Trendr <digest@localhost>'),
  TURNSTILE_SECRET: z.string().optional(),
  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('http'),
  MCP_PORT: z.coerce.number().int().default(4100),
  MCP_API_KEY: z.string().optional(),
  MCP_HTTP_AUTH_TOKENS: csv.optional(),
  OTEL_ENABLED: bool.default('false'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  CLOUDFLARE_ZONE_ID: z.string().optional(),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
}).superRefine((e, ctx) => {
  if (e.EMAIL_PROVIDER === 'resend' && !e.RESEND_API_KEY) ctx.addIssue({ code: 'custom', path: ['RESEND_API_KEY'], message: 'required for resend' });
  if (e.WORKER_ROLES.includes('ingest') && !e.GITHUB_TOKENS?.length && e.NODE_ENV === 'production')
    ctx.addIssue({ code: 'custom', path: ['GITHUB_TOKENS'], message: 'required for ingest in production' });
});
export type Env = z.infer<typeof EnvSchema>;
export const env: Env = EnvSchema.parse(process.env);   // each app imports only the subset it needs via pick()
```

(Apps call `EnvSchema.pick({...})` variants (`apiEnv`, `workerEnv`, `mcpEnv`), so the web container does not need worker secrets.)

---

## 16. Testing Strategy

| Layer | Tooling | Scope | Location |
|---|---|---|---|
| Unit | Vitest | Scoring (`velocity`, `normalize`, `anomaly`, `series` interpolation, `toVelocityInput` tier staleness 3 h/12 h/36 h, `paramsFor('arxiv','stars',w)` throws), token-bucket math (Lua tested via a Redis container in integration; the pure TS helpers here), backoff, cursor encode/decode, id normalizers, alert rule evaluation, unsubscribe token sign/verify, env schema (incl. `SCORES_*` defaults 48/365), query schemas (`TrendingQuery.newOnly`: absent → `false`, `?newOnly=false` → `false`, `?newOnly=0` → `false`, `?newOnly=true`/`1` → `true`, `?newOnly=yes` → 400; `ScoresQuery` rejects `granularity=hour&days=3`) | `packages/*/test/*.test.ts`, `apps/*/test/unit` |
| Property-based | `fast-check` | `computeRawScore` is monotonic in Δ for fixed B; non-increasing in B for fixed Δ; `percentileRanks` stays in (0,100); `robustZ` is invariant to permutations | `packages/core/test/scoring.prop.test.ts` |
| Golden | Vitest snapshot | Fixed input set (≈ 50 items) → exact ranking; changing params requires updating the golden file | `packages/core/test/scoring.golden.test.ts` |
| Adapter unit (recorded fixtures) | Vitest + undici `MockAgent` (or `nock` ≥ 14, which supports native fetch) | `normalize()` for each fixture (happy path, missing fields, renamed repo, scoped npm, PyPI name normalization, HF gated model, arXiv multi-version, MCP deleted entry); `fetchMetrics()` request shape (URLs, headers, ETag, batching ≤ 128/50), handling of 304/404/429/secondary limits and pagination (`Link` header, `cursor`) | `packages/sources/src/*/**.test.ts`, `__fixtures__/*.json|xml` |
| Contract | Vitest, `CONTRACT=1` (nightly CI only, real network, tokens from CI secrets) | Hit each real upstream endpoint once and validate the response against the adapter's Zod schema, catching upstream schema drift early. On failure, open a GitHub issue automatically (workflow step). | `packages/sources/test/contract/*.contract.test.ts` |
| Integration | Vitest + Testcontainers (`postgres:16-alpine`, `redis:7-alpine`) | Migrations apply cleanly; `SHOW TimeZone` = UTC; partition functions (bounds are UTC midnights even with session `TimeZone = 'Asia/Kolkata'`); `create-partitions` sets `trendr_snapshots_default_rows` (0, then > 0 after a row is forced into `snapshots_default`); idempotent upserts (run twice → same rows); retention drops partitions; **scores persistence**: a run writes rows only for eligible items (row count = `trendr_scoring_items{eligibility="eligible"}`, no row carries `below_threshold`/`insufficient_data`/`negative_growth`); **scores retention**: seed 72 h of hourly runs + 400 days of daily runs → after `pruneScores(48, 365)` every run inside 48 h survives, older days keep exactly one run per (source, window, UTC day) (the last one), nothing older than 365 days remains, the `score_runs_current` run survives even if older than 48 h, and a second call deletes 0 rows; `loadSeries` SQL with seeded snapshots (an item with a 5 h old hot snapshot is returned and marked `stale`, one older than 36 h is not returned); scoring end to end (DB → scores → Redis ZSET atomic swap); BullMQ processors with real Redis (retry → DLQ path; jobId dedupe); rate limiter under concurrency (20 parallel takers never exceed capacity) | `apps/worker/test/integration`, `packages/db/test` |
| E2E API | Fastify `app.inject()` (fast) + Supertest for the SSE stream; Testcontainers DB/Redis seeded via `seed.ts` | Every endpoint: happy path, validation errors (RFC 7807 shape), auth (401/403), IDOR, pagination stability across a scoring run, ETag 304, rate limit 429, SSE receives `leaderboard.update` after `PUBLISH`; `GET /v1/trending?newOnly=false` returns old and new items (same as omitting it); `/v1/items/:id/scores` hour vs day granularity and gaps for ineligible runs; a cursor pinned to a thinned run returns 410 `cursor-expired` | `apps/api/test/e2e` |
| MCP | SDK `Client` + `InMemoryTransport` | Tool listing, input validation errors, outputs match schemas | `apps/mcp/test` |
| Web | Vitest + Testing Library (components), Playwright smoke (stretch): home renders, filters update the URL, item page chart renders | | `apps/web/test` |
| Load (stretch) | k6 | `/v1/trending` at 500 RPS for p95 < 50 ms (Redis path) | `infra/k6/trending.js` |

Testcontainers setup is shared through Vitest `globalSetup`:

```ts
// test/global-setup.ts (used by integration + e2e projects)
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { migrate } from '@trendr/db/migrate';
export default async function setup() {
  const pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  const redis = await new RedisContainer('redis:7-alpine').start();
  process.env.DATABASE_URL = pg.getConnectionUri();
  process.env.REDIS_URL = redis.getConnectionUrl();
  await migrate(process.env.DATABASE_URL);
  return async () => { await redis.stop(); await pg.stop(); };
}
```

Each test file gets isolation from `TRUNCATE ... RESTART IDENTITY CASCADE` in `beforeEach` (fast) and a unique Redis key prefix (`ioredis` `keyPrefix: t{workerId}:`, and BullMQ `prefix`).

Fixture recording: `pnpm fixtures:record --source github` runs the adapter against the real API with `RECORD=1`, writes JSON/XML responses into `__fixtures__/`, and **strips `authorization`, `set-cookie` and tokens**. A test asserts that no fixture contains `ghp_`, `github_pat_` or `hf_` strings.

**Coverage targets** (Vitest v8 coverage, enforced in CI):

| Package | Lines | Branches |
|---|---|---|
| `packages/core` | 95% | 90% |
| `packages/sources` | 90% | 85% |
| `packages/db` (repositories) | 80% | 70% |
| `apps/api` | 85% | 75% |
| `apps/worker` | 80% | 70% |
| `apps/mcp` | 80% | 70% |
| `apps/web` | 50% (components only) | — |

---

## 17. DevOps

### 17.1 `docker-compose.yml`

```yaml
name: trendr

x-node-env: &node-env
  NODE_ENV: ${NODE_ENV:-development}
  LOG_LEVEL: ${LOG_LEVEL:-info}
  DATABASE_URL: postgres://trendr:trendr@postgres:5432/trendr
  REDIS_URL: redis://redis:6379
  API_PUBLIC_URL: ${API_PUBLIC_URL:-http://localhost:4000}
  API_INTERNAL_URL: http://api:4000
  WEB_PUBLIC_URL: ${WEB_PUBLIC_URL:-http://localhost:3000}

services:
  postgres:
    image: postgres:16-alpine          # set TIMESCALE_ENABLED=true and image timescale/timescaledb:latest-pg16 for the Timescale variant
    command: ["postgres", "-c", "timezone=UTC"]   # partition + rollup math assumes UTC sessions (6.3); prod override adds -c shared_buffers=256MB
    environment:
      POSTGRES_USER: trendr
      POSTGRES_PASSWORD: trendr
      POSTGRES_DB: trendr
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U trendr -d trendr"]
      interval: 5s
      timeout: 3s
      retries: 20

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes", "--maxmemory-policy", "noeviction"]  # BullMQ requires noeviction
    ports: ["6379:6379"]
    volumes: [redisdata:/data]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 20

  migrate:
    build: { context: ., dockerfile: infra/docker/node.Dockerfile, args: { APP: api } }
    command: ["node", "packages/db/dist/migrate.js"]
    environment: { <<: *node-env }
    env_file: [.env]
    depends_on:
      postgres: { condition: service_healthy }
    restart: "no"

  api:
    build: { context: ., dockerfile: infra/docker/node.Dockerfile, args: { APP: api } }
    environment: { <<: *node-env, API_PORT: "4000" }
    env_file: [.env]
    ports: ["4000:4000"]
    depends_on:
      migrate: { condition: service_completed_successfully }
      redis: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:4000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 3s
      retries: 10
    restart: unless-stopped

  worker:
    build: { context: ., dockerfile: infra/docker/node.Dockerfile, args: { APP: worker } }
    environment:
      <<: *node-env
      WORKER_ROLES: scheduler,ingest,scoring,notify
      WORKER_METRICS_PORT: "9464"
      SMTP_URL: smtp://mailpit:1025
    env_file: [.env]
    expose: ["9464"]                   # internal only: Prometheus scrapes worker:9464; /metrics needs Bearer METRICS_TOKEN
    depends_on:
      migrate: { condition: service_completed_successfully }
      redis: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:9464/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 3s
      retries: 10
    restart: unless-stopped

  web:
    build: { context: ., dockerfile: infra/docker/web.Dockerfile }
    environment:
      API_INTERNAL_URL: http://api:4000
      NEXT_PUBLIC_API_URL: ${API_PUBLIC_URL:-http://localhost:4000}
      PORT: "3000"
    ports: ["3000:3000"]
    depends_on:
      api: { condition: service_healthy }
    restart: unless-stopped

  mcp:
    build: { context: ., dockerfile: infra/docker/node.Dockerfile, args: { APP: mcp } }
    environment:
      <<: *node-env
      MCP_TRANSPORT: http
      MCP_PORT: "4100"
    env_file: [.env]
    ports: ["4100:4100"]
    depends_on:
      api: { condition: service_healthy }
    restart: unless-stopped

  mailpit:
    image: axllent/mailpit:latest
    ports: ["8025:8025", "1025:1025"]

  prometheus:
    image: prom/prometheus:latest
    profiles: ["obs"]
    volumes:
      - ./infra/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./infra/prometheus/alerts.yml:/etc/prometheus/alerts.yml:ro
    ports: ["9090:9090"]

  grafana:
    image: grafana/grafana:latest
    profiles: ["obs"]
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin
      GF_AUTH_ANONYMOUS_ENABLED: "true"
    volumes:
      - ./infra/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./infra/grafana/dashboards:/var/lib/grafana/dashboards:ro
    ports: ["3001:3000"]
    depends_on: [prometheus]

  jaeger:
    image: jaegertracing/all-in-one:latest
    profiles: ["obs"]
    ports: ["16686:16686", "4318:4318"]

volumes:
  pgdata:
  redisdata:
```

`infra/prometheus/prometheus.yml`:

```yaml
global: { scrape_interval: 15s }
rule_files: [/etc/prometheus/alerts.yml]
scrape_configs:
  - job_name: api
    metrics_path: /metrics
    authorization: { credentials: change-me-metrics-token }   # = METRICS_TOKEN
    static_configs: [{ targets: ["api:4000"] }]
  - job_name: worker
    metrics_path: /metrics
    authorization: { credentials: change-me-metrics-token }   # = METRICS_TOKEN (worker /metrics requires it too)
    static_configs: [{ targets: ["worker:9464"] }]
```

### 17.2 Dockerfiles

```dockerfile
# infra/docker/node.Dockerfile — builds api | worker | mcp
# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS pruner
ARG APP
RUN pnpm add -g turbo@^2
COPY . .
RUN turbo prune @trendr/${APP} --docker

FROM base AS builder
ARG APP
COPY --from=pruner /repo/out/json/ .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
RUN pnpm turbo run build --filter=@trendr/${APP}...
RUN pnpm --filter=@trendr/${APP} deploy --prod --legacy /out   # pnpm deploy: self-contained node_modules
# keep migrations + migrate script for the 'migrate' service
RUN mkdir -p /out/packages/db && cp -r packages/db/migrations packages/db/dist /out/packages/db/ || true

FROM ${NODE_IMAGE} AS runner
ARG APP
ENV NODE_ENV=production APP=${APP}
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=builder --chown=node:node /out/ ./
USER node
EXPOSE 4000 4100 9464
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
```

(The exact `pnpm deploy` flags depend on the pnpm major version: `--legacy` is needed on pnpm ≥ 10 unless `inject-workspace-packages=true`, so verify against the pinned version and record it in an ADR.)

```dockerfile
# infra/docker/web.Dockerfile — Next.js standalone
# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS pruner
RUN pnpm add -g turbo@^2
COPY . .
RUN turbo prune @trendr/web --docker

FROM base AS builder
COPY --from=pruner /repo/out/json/ .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} NEXT_TELEMETRY_DISABLED=1
RUN pnpm turbo run build --filter=@trendr/web...

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /repo/apps/web/public ./apps/web/public   # apps/web/public/.gitkeep must be committed
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
```

### 17.3 `.env.example`

```dotenv
# ── Core ─────────────────────────────────────────────
NODE_ENV=development
LOG_LEVEL=info
DATABASE_URL=postgres://trendr:trendr@localhost:5432/trendr
DATABASE_POOL_MAX=10
REDIS_URL=redis://localhost:6379

# ── API ──────────────────────────────────────────────
API_PORT=4000
API_PUBLIC_URL=http://localhost:4000
API_INTERNAL_URL=http://api:4000
WEB_PUBLIC_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:3000
TRUST_PROXY=false
# generate with: openssl rand -base64 48
JWT_SECRET=change-me-change-me-change-me-change-me-123456
JWT_ACCESS_TTL_SEC=900
REFRESH_TTL_DAYS=30
API_KEY_PEPPER=change-me-change-me-change-me-change-me-654321
UNSUBSCRIBE_SECRET=change-me-change-me-change-me-change-me-abcdef
METRICS_TOKEN=change-me-metrics-token
ADMIN_EMAILS=nayan@example.com
TURNSTILE_SECRET=

# ── Upstream credentials (worker only) ───────────────
# Fine-grained PAT, public repositories read-only. Comma-separate for >1 (max 2 recommended).
GITHUB_TOKENS=
GITHUB_RESERVE=200
HF_TOKEN=
HF_RATE_PER_5MIN=1000
HF_INCLUDE_DATASETS=false
HF_INCLUDE_SPACES=false
HTTP_USER_AGENT=Trendr/1.0 (+https://github.com/nayankunwar/trendr)

# ── Worker ───────────────────────────────────────────
WORKER_ROLES=scheduler,ingest,scoring,notify
WORKER_CONCURRENCY_INGEST=4
WORKER_METRICS_PORT=9464
SCHEDULER_ENABLED=true
TRACKED_MAX_GITHUB=50000
TRACKED_MAX_NPM=10000
TRACKED_MAX_PYPI=2000
TRACKED_MAX_HUGGINGFACE=13000
TRACKED_HOT_MAX_GITHUB=2000
TRACKED_HOT_MAX_HUGGINGFACE=1000
NPM_MIN_WEEKLY_DOWNLOADS=200
PYPI_MIN_WEEKLY_DOWNLOADS=500
BACKFILL_GITHUB_MAX_PAGES=50
BACKFILL_GITHUB_PER_HOUR=200
FANOUT_BATCH_ITEMS=500
LB_MAX_SIZE=1000
ALL_BOARD_MAX_SHARE=0.4
SNAPSHOT_RETENTION_MONTHS=3
SCORES_HOURLY_RETENTION_HOURS=48   # Neon free: 24
SCORES_DAILY_RETENTION_DAYS=365    # Neon free: 30
TIMESCALE_ENABLED=false

# ── Email ────────────────────────────────────────────
EMAIL_PROVIDER=smtp            # smtp | resend | log
SMTP_URL=smtp://localhost:1025
RESEND_API_KEY=
EMAIL_FROM=Trendr <digest@localhost>

# ── MCP server ───────────────────────────────────────
MCP_TRANSPORT=http             # http | stdio
MCP_PORT=4100
MCP_API_KEY=                   # create via POST /v1/me/api-keys (scope read), or seed script prints one
MCP_HTTP_AUTH_TOKENS=

# ── Web (Next.js; read by apps/web only, not by EnvSchema) ──
NEXT_PUBLIC_API_URL=http://localhost:4000

# ── Optional ─────────────────────────────────────────
OTEL_ENABLED=false
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
CLOUDFLARE_ZONE_ID=
CLOUDFLARE_API_TOKEN=
```

### 17.4 GitHub Actions CI (`.github/workflows/ci.yml`)

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: "0 3 * * *"     # nightly contract tests
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read

jobs:
  lint-typecheck-unit:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo run lint typecheck
      - run: pnpm turbo run test -- --coverage
      - name: OpenAPI up to date
        run: pnpm --filter @trendr/api openapi:export && git diff --exit-code apps/api/openapi.json
      - uses: actions/upload-artifact@v4
        with: { name: coverage, path: "**/coverage/coverage-summary.json" }

  integration:
    runs-on: ubuntu-latest     # Docker available → Testcontainers works out of the box
    timeout-minutes: 20
    needs: lint-typecheck-unit
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo run build --filter=./packages/*
      - run: pnpm turbo run test:int
        env: { TESTCONTAINERS_RYUK_DISABLED: "false" }

  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@v2
        env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm audit --prod --audit-level high

  compose-smoke:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    needs: integration
    steps:
      - uses: actions/checkout@v4
      - run: cp .env.example .env
      - run: docker compose up -d --build --wait --wait-timeout 300 postgres redis migrate api worker web mcp
      - run: curl -fsS http://localhost:4000/readyz && curl -fsS http://localhost:3000 >/dev/null
      - name: Worker health (port 9464 is not published; check inside the container)
        run: docker compose exec -T worker node -e "fetch('http://localhost:9464/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      - run: docker compose exec -T api node packages/db/dist/seed.js && curl -fsS "http://localhost:4000/v1/trending?scope=all&window=7d" | jq -e '.data | length > 0'
      - if: failure()
        run: docker compose logs --no-color > compose.log
      - if: failure()
        uses: actions/upload-artifact@v4
        with: { name: compose-logs, path: compose.log }

  contract:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @trendr/sources test:contract
        env:
          CONTRACT: "1"
          GITHUB_TOKENS: ${{ secrets.CONTRACT_GITHUB_TOKEN }}
          HF_TOKEN: ${{ secrets.CONTRACT_HF_TOKEN }}
```

> If your Compose version treats the exited one-shot `migrate` container as a failure under `--wait`, run `docker compose run --rm migrate` first and then `docker compose up -d --wait` for the long-running services (behaviour differs across Compose v2 releases; verify).

`docker-publish.yml`: on tag `v*`, build and push `ghcr.io/<owner>/trendr-{api,worker,mcp,web}` with `docker/build-push-action@v6` (multi-arch amd64/arm64, GHA cache), then trigger the deploy hook (Render deploy hook URL, or SSH to the VPS for `docker compose pull && docker compose up -d`).

### 17.5 nginx (VPS)

```nginx
# infra/nginx/nginx.conf (server blocks; TLS terminated by Cloudflare origin cert)
upstream api { server api:4000; keepalive 32; }
upstream web { server web:3000; keepalive 32; }
upstream mcp { server mcp:4100; }

server {
  listen 443 ssl http2;
  server_name api.trendr.example;
  ssl_certificate     /etc/nginx/certs/origin.pem;
  ssl_certificate_key /etc/nginx/certs/origin.key;
  real_ip_header CF-Connecting-IP;           # plus set_real_ip_from <Cloudflare ranges>
  location /v1/stream/ {
    proxy_pass http://api;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
  }
  location /metrics { deny all; }            # scraped on the internal network only
  location / {
    proxy_pass http://api;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Request-Id $request_id;
  }
}
server { listen 443 ssl http2; server_name trendr.example; location / { proxy_pass http://web; } }
server { listen 443 ssl http2; server_name mcp.trendr.example; location /mcp { proxy_pass http://mcp; proxy_buffering off; proxy_read_timeout 1h; } }
```

### 17.6 Deployment plan

**Option A, recommended: a single VPS** (Hetzner CX22-class 2 vCPU / 4 GB at about €4–5/month, or Oracle Cloud Always Free Ampere; verify current offers).
- Same `docker-compose.yml` with a `docker-compose.prod.yml` override: images from GHCR, no exposed DB/Redis ports, nginx service, resource limits (`api` 512 MB, `worker` 768 MB, `postgres` 1 GB with `shared_buffers=256MB`).
- Cloudflare DNS in proxied mode, origin certificate, firewall allowing only Cloudflare IPs on 443 (or use Cloudflare Tunnel and open no inbound ports).
- Backups: nightly `pg_dump -Fc` to Cloudflare R2 / Backblaze B2 (cron container), keeping 14 days; a restore drill is documented in `docs/runbook.md`.
- Strengths: lowest cost, no cold starts, BullMQ gets a real Redis with no command quotas, and it matches the Shortly deployment story.

**Option B: managed free and low tiers** (good for showing cloud-native skills; check every limit before relying on it):

| Piece | Service | Free-tier notes (verify; these change often) |
|---|---|---|
| web | Vercel Hobby or Render static/web | Vercel Hobby suits Next.js; non-commercial use only |
| api | Render Web Service | Free instances spin down after ~15 min idle, giving cold starts of tens of seconds; SSE connections drop on spin-down; use the Starter plan (~$7/month) for a demo that is always on |
| worker | Render Background Worker (paid only; there is no free worker tier) or Fly.io Machine | The worker must run continuously for schedulers. On Fly, run worker + Redis in one small machine |
| Postgres | Neon free | ~0.5 GB storage, so use the Neon settings from 6.5 (`SNAPSHOT_RETENTION_MONTHS=1`, `TRACKED_MAX_GITHUB=5000`, `TRACKED_MAX_NPM=2000`, `TRACKED_MAX_PYPI=500`, `TRACKED_MAX_HUGGINGFACE=2000`, `SCORES_HOURLY_RETENTION_HOURS=24`, `SCORES_DAILY_RETENTION_DAYS=30`, `daily_metrics` ≈ 90 days); auto-suspend adds wake latency; use the pooled connection string for the API and the direct one for migrations |
| Redis | Upstash | The free tier has monthly command quotas. **BullMQ polling and blocking commands burn quotas quickly, so Upstash free is not suitable for BullMQ.** Use Upstash only as a cache, or a pay-as-you-go plan, or run Redis on Fly/VPS |
| Email | Resend free | Daily and monthly send caps; one verified domain |
| Monitoring | Grafana Cloud free | Prometheus remote-write from the worker or API via Grafana Alloy |

**Zero-downtime deploys:** migrations run as a one-off job before new containers start (the `migrate` service; on Render, a pre-deploy command). Migrations must be backward compatible (expand → migrate → contract). Workers handle `SIGTERM` by calling `worker.close()`, which waits for active jobs (graceful timeout 30 s). BullMQ's stalled-job detection re-queues anything interrupted.

---

## 18. Phased Build Plan

Rules for every phase:
- Finish tasks in order. Each task is roughly one PR or commit series.
- **Exit gate for every phase:** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:int` green, `docker compose up --build --wait` healthy, README updated, and a phase tag `phase-N` on main.
- If something cannot be verified (marked "verify"), stub it behind an adapter, write an ADR, and continue.

### Phase 0: Scaffolding (repo, tooling, CI skeleton)

| # | Task | Acceptance criteria |
|---|---|---|
| 0.1 | Init the pnpm workspace + Turborepo; root `package.json` scripts (`dev, build, lint, typecheck, test, test:int, db:generate, db:migrate, db:seed, fixtures:record, ingest:bootstrap, worker:score`); `.nvmrc` 22; `tsconfig.base.json` (Section 4) | `pnpm install` works; `pnpm build` succeeds on empty packages |
| 0.2 | ESLint flat config (typescript-eslint `strictTypeChecked`, `no-explicit-any: error`, import boundaries), Prettier, lint-staged + husky pre-commit, commitlint (conventional) | `pnpm lint` passes; a commit with message "foo" is rejected |
| 0.3 | Create every package and app folder from Section 4 with `package.json`, `tsconfig.json`, an `src/index.ts` stub, and a Vitest config (workspace projects `unit`, `int`); commit `apps/web/public/.gitkeep` (the web Dockerfile copies `apps/web/public`) | `pnpm test` runs (0 tests OK); dependency direction lint rule active; `git ls-files apps/web/public/.gitkeep` is non-empty |
| 0.4 | `packages/config` (env schema 15) + `packages/logger` (pino factory, redaction) with unit tests | Invalid env → process exits with a readable message (test); redaction test passes |
| 0.5 | `apps/api` minimal Fastify: `/healthz`, `/readyz` (stubbed checks), errors plugin (RFC 7807), metrics plugin, helmet, CORS | `app.inject('/healthz')` returns 200; unknown route returns a problem+json 404 |
| 0.6 | `apps/worker` minimal: connects to Redis, `:9464/healthz` and `/metrics` (Bearer `METRICS_TOKEN`), graceful shutdown | `docker compose exec worker` health check returns 200; `/metrics` without the bearer returns 401; port 9464 is not published on the host |
| 0.7 | Dockerfiles (17.2), `docker-compose.yml` (17.1) with postgres, redis, api, worker, web (Next hello page), mcp (stub), mailpit | `docker compose up --build --wait` all healthy |
| 0.8 | CI workflow (17.4): lint/typecheck/unit + compose-smoke (without the seed step yet) + gitleaks | CI green on the PR |
| 0.9 | `CLAUDE.md` (= Section 0), README skeleton, `docs/adr/0001..0004` | Files present |

### Phase 1: Database and core domain

| # | Task | Acceptance criteria |
|---|---|---|
| 1.1 | Drizzle schema for all tables (6.2/6.4); `drizzle.config.ts` with `tablesFilter: ['!snapshots*']`; generate `0000_init.sql` and hand-check it against 6.2 | Migration applies on a fresh PG16 (integration test); schema diff is empty |
| 1.2 | Hand-written `0001_partitions.sql` (6.3, incl. `ALTER DATABASE ... SET timezone`), `ensurePartitions()` and `dropOldPartitions()` wrappers in `packages/db/src/partitions.ts` | Integration test: partitions exist for −2..+3 months; bounds are UTC midnights even with session `TimeZone = 'Asia/Kolkata'`; `SHOW TimeZone` = UTC; inserting a snapshot routes to the right partition; drop removes an old partition |
| 1.3 | `migrate.ts` (programmatic migrator) and the compose `migrate` service | `docker compose up` runs migrations once; re-run is a no-op |
| 1.4 | `packages/core`: types (Section 5), errors, ids normalizers, redis-keys, queue names and payload schemas | Unit tests for id normalization (PEP 503, scoped npm, GitHub lowercase, arXiv version strip) |
| 1.5 | Repositories: `items.repo` (bulk upsert by `(source, external_id)`), `snapshots.repo` (unnest upsert), `daily_metrics` upsert, `runs.repo`, `scores.repo` | Integration: running upserts twice yields identical row counts; `observed_at` last-writer-wins verified |
| 1.6 | `seed.ts`: ≈ 200 fixture items across all 6 sources with 60 days of realistic series (generated deterministically with a seeded PRNG), 1 admin user, 1 API key printed to stdout | `pnpm db:seed` is idempotent; counts asserted in a test |

### Phase 2: Scoring engine (TDD)

| # | Task | Acceptance criteria |
|---|---|---|
| 2.1 | Write tests first: the 8.7 worked example as a unit test (exact values to 3 decimals), property tests (16), and the golden ranking file | Tests fail (red) before the implementation |
| 2.2 | Implement `params.ts`, `velocity.ts`, `normalize.ts`, `anomaly.ts`, `series.ts` (interpolation, coverage) | All scoring tests green; coverage of `packages/core/scoring` ≥ 95% |
| 2.3 | `loadSeries` SQL for cumulative (8.6) and daily-count metrics; integration tests with seeded snapshots, including tracked-late, new-item, stale and gap cases | Each case yields the expected Δ, B and c |
| 2.4 | `runScoring` (8.4): writes `scores` for **eligible items only**, sets `trendr_scoring_items`, swaps `score_runs_current`, builds the combined board with the max-share cap | Integration: running on seed data produces scores for all sources × windows in < 5 s; per (source, window) the `scores` row count equals the eligible gauge and no row has `final_score = 0` or an ineligibility flag |
| 2.5 | `publishLeaderboards` (9.2): tmp ZSET + RENAME, cards, meta, `PUBLISH events:leaderboard` with movers | Integration: concurrent reader never sees a partial board (reader loop during rebuild); event payload validated by a Zod schema |
| 2.6 | BullMQ `scoring` queue + processor + `score-safety` scheduler + Redis lock | Admin-less trigger via a script `pnpm worker:score --source github` works in compose |

### Phase 3: Read API (public)

| # | Task | Acceptance criteria |
|---|---|---|
| 3.1 | Plugins: db, redis, cache (read-through + circuit breaker), etag, rate-limit (Redis store), openapi | `/docs` renders; `openapi.json` exported and committed |
| 3.2 | `GET /v1/trending` (Redis path + SQL filtered path), leaderboard cursor pinned to the run | E2E: pages are stable across a mid-pagination scoring run; ETag 304; filters by topic/kind work; `?newOnly=false` → `false` (not coerced to `true`) |
| 3.3 | Items: detail, lookup, history (hour/day), scores (`ScoresQuery`: hour ≤ 48 h, day ≤ 365 d), score-explain, aliases | E2E for each, including 404 problem+json and hour-granularity limit validation for both history (14 d) and scores (48 h) |
| 3.4 | Search (FTS + trigram fallback when FTS returns < 5 hits), topics, languages, compare, new, stats | E2E; search for "nxt" finds "next.js" via trigram |
| 3.5 | Rate limiting tiers and `X-API-Key` auth (api_keys lookup, HMAC, debounced `last_used_at`) | E2E: the 61st anonymous request in a minute returns 429 with `Retry-After`; a valid key raises the limit |
| 3.6 | SSE `/v1/stream/leaderboard` + broadcaster + heartbeat + connection caps | E2E: a client receives `leaderboard.snapshot` and then `leaderboard.update` after a PUBLISH; the 6th connection from the same IP is rejected with 429 |
| 3.7 | Compose-smoke CI step with seed + trending assertion enabled | CI green |

### Phase 4: Ingestion framework + GitHub adapter

| # | Task | Acceptance criteria |
|---|---|---|
| 4.1 | `RedisTokenBucket` (Lua) + `pauseUntil`; `fetch-json` with timeouts, retries, backoff with jitter, host allowlist, header hooks, metrics | Integration: 20 concurrent takers on capacity 10 + refill 1/s → ≤ 10 + elapsed s grants; unit tests for every status branch; SSRF test (a disallowed host throws) |
| 4.2 | Ingest processor (7.1), run recorder, DLQ (7.7), BullMQ custom backoff, `UnrecoverableError` mapping | Integration: a job failing 5× lands in `dead-letter` with its reason; a schema error goes straight to the DLQ |
| 4.3 | GitHub adapter: search discovery with date slicing, GraphQL batch snapshot (50 aliases, `rateLimit` cost tracking), REST conditional refresh (ETag in Redis), rename handling, stargazer backfill | Fixture tests: normalize (repo, archived, fork, renamed, not found); request-shape tests (batch size, `If-None-Match`, `Accept: application/vnd.github.star+json`); 304 increments `not_modified` |
| 4.4 | Schedulers (7.2) for GitHub + `snapshot-fanout` | In compose with a real `GITHUB_TOKENS`: `ingestion_runs` shows succeeded runs and snapshots grow hourly; without a token the jobs are `skipped` with a clear log |
| 4.5 | Tiering job (7.8) and instant promotion hook | Integration: a watched item becomes `hot`; an item with no growth for 60 d becomes `archived` |
| 4.6 | Admin endpoints: ingest trigger, score trigger, runs, queues, DLQ retry/delete, rate-limits, item patch | E2E with an admin JWT and an admin-scope key; a non-admin gets 403 |

### Phase 5: Remaining adapters

| # | Task | Acceptance criteria |
|---|---|---|
| 5.1 | npm adapter: keyword discovery, bulk (≤ 128, unscoped) + scoped single range fetch, 3-day upsert window, 60-day backfill, repository → GitHub alias | Fixture tests: bulk response mapping, scoped encoding `@scope%2Fname`, missing day leads to a `partial` run |
| 5.2 | PyPI adapter: RSS discovery (fast-xml-parser), JSON metadata with ETag, pypistats `overall?mirrors=false`, PEP 503 names, project_urls → GitHub alias | Fixture tests; the pypistats bucket enforces ≥ 2 s spacing (fake timers) |
| 5.3 | Hugging Face adapter: list pages with `expand[]` + `Link` cursor, list-as-snapshot, detail fallback, `RateLimit` header parsing → pause, `arxiv:` tag aliases, optional datasets/spaces | Fixture tests incl. a 429 with `t=` → `pauseUntil` called with the right time |
| 5.4 | arXiv adapter: Atom parsing (multi-category, versions, error feed), politeness (bucket + `lock:arxiv:conn`), HF upvotes enrichment, `githubRepo` → `paper_code` alias | Fake-timer test: 3 sequential requests take ≥ 6 s; the error feed throws a non-retryable error |
| 5.5 | MCP adapter: registry incremental sync (`updated_since`, cursor, v0.1 → v0 fallback), deleted handling, GitHub topic + npm keyword discovery, alias creation, derived snapshots | Fixture tests; derived snapshot copies alias stars; `primary_metric` chosen correctly |
| 5.6 | Alias resolver (shared) + `item_aliases` API surfacing; contract tests (nightly) for all 6 sources | `CONTRACT=1 pnpm --filter sources test:contract` passes locally with tokens |

### Phase 6: Web frontend

| # | Task | Acceptance criteria |
|---|---|---|
| 6.1 | Next.js 15 app, Tailwind, shadcn/ui init, layout, theme, typed API client | Home renders the seed leaderboard via the Docker network |
| 6.2 | Leaderboard pages + FilterBar + Sparkline + LiveLeaderboard (SSE + SWR) | Changing filters updates the URL; publishing a fake event animates a row (component test) |
| 6.3 | Item page: metric history (area or bars + 7-day MA by metric kind), score chart, score explain, aliases | Item page Lighthouse SEO ≥ 95 locally |
| 6.4 | Search, new, topics, compare pages | Smoke tests |
| 6.5 | OG images, sitemap, robots, JSON-LD | `/item/.../opengraph-image` returns a PNG |

### Phase 7: Accounts, watchlists, alerts, digest

| # | Task | Acceptance criteria |
|---|---|---|
| 7.1 | Magic-link auth (tokens table, JWT, refresh rotation + reuse detection), `EmailSender` (smtp → Mailpit) | E2E: full login flow through the Mailpit API; refresh-token reuse revokes the family |
| 7.2 | `/v1/me` + watchlists CRUD + per-user caps + IDOR tests; web dashboard | E2E: user B gets a 404 on user A's watchlist |
| 7.3 | Alert rules CRUD + `evaluate-alerts` processor (13.1) + `send-alert-email` + templates | Integration: a seeded spike fires exactly one `alert_events` row even when the job is retried twice; the email arrives in Mailpit |
| 7.4 | Digest: subscription API + build/send jobs + template + unsubscribe tokens + RFC 8058 headers | Integration: sending twice in the same week creates one `digest_sends` row; one-click POST unsubscribes |
| 7.5 | API keys UI and endpoints (create shows the key once) | E2E |

### Phase 8: MCP server

| # | Task | Acceptance criteria |
|---|---|---|
| 8.1 | `apps/mcp` with `McpServer`, stdio + Streamable HTTP transports, `ApiClient` | `npx @modelcontextprotocol/inspector` can list the tools against the compose stack |
| 8.2 | The five tools from 11.1, each with input/output schemas + Markdown text | In-memory client tests for every tool, including validation errors |
| 8.3 | README section with a Claude Desktop / Cursor config snippet | Manual check documented |

### Phase 9: Observability, security hardening, operations

| # | Task | Acceptance criteria |
|---|---|---|
| 9.1 | Complete the metrics list (14.1), the freshness poller, the queue-depth poller | `curl /metrics` shows every metric name from 14.1 |
| 9.2 | Prometheus + Grafana provisioning (profile `obs`), alert rules | `docker compose --profile obs up` gives a dashboard with live panels |
| 9.3 | Security checklist (15): CSP, cookie flags, CSRF header, Turnstile (optional), `pnpm audit`, gitleaks, fixture token scan | All checks automated in CI where possible |
| 9.4 | Retention (incl. `pruneScores` with `SCORES_HOURLY_RETENTION_HOURS` / `SCORES_DAILY_RETENTION_DAYS`, 6.5) + rollup + cleanup jobs, partition creation job (sets `trendr_snapshots_default_rows`) | Integration tests: scores retention keeps every run < 48 h, exactly one run per (source, window, UTC day) up to 365 d, never the current run, and is idempotent; `SnapshotsDefaultNotEmpty` rule loads in Prometheus (`promtool check rules`); the runbook documents manual commands |
| 9.5 | Optional OpenTelemetry wiring | Traces visible in Jaeger with job spans linked to API spans |

### Phase 10: Deployment and polish

| # | Task | Acceptance criteria |
|---|---|---|
| 10.1 | `docker-compose.prod.yml`, nginx config, GHCR publish workflow, VPS bootstrap script (`infra/scripts/bootstrap-vps.sh`), backups | Deployed at a public URL behind Cloudflare; the SSE stream works through Cloudflare |
| 10.2 | Option B notes / `render.yaml` (Blueprint) as an alternative | `render.yaml` validates |
| 10.3 | README: architecture diagram, screenshots, API examples, MCP usage, "Design decisions" linking ADRs, interview talking points (19) | Reviewed |
| 10.4 | k6 load test of `/v1/trending`; record results in README | p95 < 50 ms at 200 RPS on the VPS |
| 10.5 | Scoring parameter tuning (GAP-12): review 2–4 weeks of real data per source (eligible fraction, board churn, false burst flags), adjust `params.ts`, update the golden file, record an ADR | ADR merged; golden test updated; eligible fraction per (source, window) reported, and the 6.5 `scores` estimate re-checked against it |

### Open decisions (ADRs to record)

Each gap is resolved (verified against the live API or decided) in the phase shown and recorded as `docs/adr/NNNN-<slug>.md`. Until then, implement the conservative default the spec already describes.

| ID | Open decision | Resolved in |
|---|---|---|
| GAP-1 | GitHub GraphQL point cost of a 50-alias `repository` query (expected ≈ 1; measure via `rateLimit { cost }`) | Phase 4 (4.3) |
| GAP-2 | npm registry and downloads API rate limits (undocumented; conservative buckets until measured) | Phase 5 (5.1) |
| GAP-3 | pypistats numeric rate limit and daily refresh time (drives the `pypi-daily` cron) | Phase 5 (5.2) |
| GAP-4 | MCP Registry: v0 vs v0.1 as the stable contract, and its rate limits | Phase 5 (5.5) |
| GAP-5 | Hugging Face: `downloads` rolling-window semantics, sort fields for `/api/spaces` and `/api/datasets`, `arxiv:{id}` tag format on models | Phase 5 (5.3) |
| GAP-6 | `@modelcontextprotocol/sdk` ^1.32 vs Zod 4 (else `zod/v3` inside `apps/mcp`) | Phase 8 (8.1) |
| GAP-7 | GitHub stargazers pagination depth cap for large repos (backfill limit) | Phase 4 (4.3) |
| GAP-8 | GitHub PAT expiry header `github-authentication-token-expiration` (expiry metric) | Phase 4 (4.3) |
| GAP-9 | Free-tier limits (Render, Neon, Upstash, Resend, Vercel, Fly, Oracle), incl. whether the Neon 0.5 GB budget in 6.5 holds | Phase 10 (10.2) |
| GAP-10 | `docker compose up --wait` with the one-shot `migrate` container (fallback: `docker compose run --rm migrate` first) | Phase 0 (0.7–0.8) |
| GAP-11 | `pnpm deploy` flags for the pinned pnpm major (`--legacy` vs `inject-workspace-packages=true`) | Phase 0 (0.7) |
| GAP-12 | Scoring parameter tuning (`k`, `minDelta`, `β`, `burstMinAbs`, eligible fraction) on real data | Phase 10 (10.5) |

---

## 19. Stretch Goals and Interview Talking Points

### 19.1 Stretch goals

1. **Transactional outbox → RabbitMQ:** write `outbox_events` (`leaderboard.updated`, `alert.triggered`) in the same transaction as `scores`/`alert_events`. A relay (`apps/worker` role `outbox`) polls with `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 100`, publishes to the topic exchange `trendr.events` with publisher confirms, and sets `published_at`. Consumers: a webhook dispatcher (user webhooks with HMAC signatures) and a Discord/Slack notifier. This shows exactly-once *effects* via at-least-once delivery plus idempotent consumers, reusing the Shortly pattern.
2. **Webhooks** for alerts (signed with `X-Trendr-Signature: sha256=...`, retries with backoff, delivery log).
3. **BigQuery PyPI ingestion** (`bigquery-public-data.pypi.file_downloads`) to track 50k+ Python packages without stressing pypistats.
4. **More sources:** crates.io, Docker Hub pulls, VS Code Marketplace, Hacker News mentions (Algolia API), Reddit, Product Hunt.
5. **Fake-star detection** via stargazer account sampling (8.5); a public "suspicious" report.
6. **Embeddings-based "similar items"** (pgvector) and topic clustering across sources.
7. **GitHub App auth** instead of a PAT (installation tokens; documented 5,000–12,500 req/h scaling).
8. **Kafka variant** of the event stream (only if replay or analytics become a requirement), with a written comparison.
9. **Cloudflare cache purge** after each scoring run; edge-cached SSE alternative (polling JSON with short s-maxage) for scale.
10. **Read replica** for the API with replica-lag-aware reads.
11. **Multi-region read API** (Fly.io) with Redis replicas.

### 19.2 Interview talking points (design trade-offs)

| Topic | Talking point |
|---|---|
| Velocity vs popularity | Why `log10(1+Δ) · (Δ/(B+k))^β`: the absolute term is log-damped, the relative term is sub-linear, and the smoothing prior `k` is a Bayesian-style shrinkage that stops tiny-base explosions. Walk through the worked example (8.7). |
| Counters vs daily aggregates | GitHub stars are cumulative counters, so diff the snapshots. npm/PyPI downloads are daily aggregates, so compare period sums. Mixing these up is a classic bug. Also covers late-arriving data (3-day upsert window) and weekday seasonality. |
| Cross-source comparability | Robust z-score on `ln(1+score)` (median and MAD) vs percentiles; why not the mean and standard deviation (heavy tails); the max-share cap on the combined board. |
| BullMQ vs Kafka vs RabbitMQ | Task scheduling vs event streaming. BullMQ gives cron, delays, retries and rate limiting on Redis, which already exists. Kafka earns its place only for replay or high fan-out. RabbitMQ plus outbox serves domain events (stretch). |
| Rate limiting as a distributed problem | A global token bucket in Redis (atomic Lua) shared by every worker, plus header feedback (`x-ratelimit-reset`, HF `RateLimit t=`); ETag conditional requests that cost no primary quota on 304; GraphQL batching (50 repos ≈ 1 point vs 50 REST calls). |
| Idempotency everywhere | Deterministic job ids, natural-key upserts, bucketed `captured_at`, dedupe keys for alerts and digests. "What happens if the worker crashes mid-batch?" Nothing is duplicated, and a retry completes the work. |
| Time-series in Postgres | Monthly range partitions (pruning, O(1) retention via DROP PARTITION, BRIN indexes) vs TimescaleDB (compression, continuous aggregates) vs a separate TSDB. Why plain PG is the default (managed-host compatibility). |
| Consistent pagination | A cursor pinned to the scoring `run_id` gives snapshot-consistent pages while rankings change underneath, compared with offset pagination's skipped and duplicated rows. |
| Cache design | Atomic ZSET swap with `RENAME`; ETag from the leaderboard version, giving cheap 304s; a CDN layer with `s-maxage` + `stale-while-revalidate`; a circuit breaker to Postgres when Redis is down. |
| Real time | SSE vs WebSockets (one-way, HTTP-friendly, auto-reconnect with `Last-Event-ID`); Redis pub/sub fan-out across API replicas; heartbeats through Cloudflare and nginx buffering. |
| Data quality | Burst detection with robust statistics, penalize-don't-delete, transparency through `score-explain`, and handling of renames, deletions and counter resets. |
| Security | SSRF allowlist when ingesting URLs from third-party data; hashed API keys with a pepper; refresh-token reuse detection; RFC 8058 one-click unsubscribe. |
| Ops maturity | RED metrics, freshness SLOs, DLQ with admin replay, ingestion audit table, contract tests that catch upstream schema drift. |
| AI-native surface | An MCP server that reuses the public API (no second data path), with structured outputs and read-only annotations. |

---

## Appendix A: Verified External API Facts

These were checked on **2026-10-17** against official docs or live responses. "Observed" means seen in a live response but not stated in the docs.

| Source | Fact | Status / Reference |
|---|---|---|
| GitHub REST | 5,000 req/h per user (PAT); 60/h unauthenticated; 15,000/h for Enterprise Cloud-owned apps | Verified: docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api |
| GitHub REST | Secondary limits: ≤ 100 concurrent; ≤ 900 points/min per REST endpoint (GET = 1 point); ≤ 2,000 points/min GraphQL; ≤ 90 s CPU per 60 s | Verified: same page |
| GitHub REST | Headers `x-ratelimit-limit/remaining/used/reset/resource`; on exceed 403 or 429; honour `retry-after`, else wait for reset, else ≥ 60 s with exponential backoff | Verified: same page |
| GitHub Search | 30 req/min authenticated (search code: 10/min); 10/min unauthenticated; up to 1,000 results per search | Verified: docs.github.com/en/rest/search/search |
| GitHub GraphQL | 5,000 points/h per user; `first`/`last` 1–100; ≤ 500,000 nodes per call | Verified: docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api |
| GitHub GraphQL | Exact point cost of a 50-alias `repository` query (expected ≈ 1) | **Verify** via `rateLimit { cost }` |
| GitHub conditional requests | A 304 for an authorized conditional request does not count against the primary limit | Verified: docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api |
| GitHub stargazers | `Accept: application/vnd.github.star+json` adds `starred_at` | Verified: docs.github.com/en/rest/activity/starring |
| GitHub stargazers | Pagination depth cap for very large repos (~400 pages commonly reported) | **Verify** |
| GitHub PAT expiry header | `github-authentication-token-expiration` | **Verify** |
| npm downloads | `GET https://api.npmjs.org/downloads/point/{period}[/{pkg}]` and `/downloads/range/{period}[/{pkg}]`; periods `last-day|last-week|last-month|last-year|YYYY-MM-DD[:YYYY-MM-DD]` | Verified: github.com/npm/registry/blob/main/docs/download-counts.md |
| npm downloads | Computed daily soon after UTC midnight; bulk ≤ 128 packages and ≤ 365 days; scoped packages not supported in bulk; single queries ≤ 18 months; data from 2015-01-10 | Verified: same doc |
| npm search | `GET https://registry.npmjs.org/-/v1/search` params `text`, `size` (default 20, max 250), `from`, `quality`, `popularity`, `maintenance` | Verified: github.com/npm/registry/blob/main/docs/REGISTRY-API.md |
| npm search | `keywords:` qualifier in `text` works; response contains `downloads.weekly/monthly`; `Cache-Control: max-age=300` | Observed |
| npm | Request rate limits for registry and downloads API | **Not documented: verify** (conservative buckets used) |
| PyPI | JSON API `https://pypi.org/pypi/{project}/json`; ETag; CDN cached; "currently no rate limiting of PyPI APIs at the edge"; XML-RPC deprecated and may be rate limited | Verified: docs.pypi.org/api/ |
| PyPI | RSS: `https://pypi.org/rss/packages.xml`, `https://pypi.org/rss/updates.xml`, `/rss/project/{name}/releases.xml` | Verified: docs.pypi.org/api/feeds/ |
| pypistats | `/api/packages/{pkg}/recent?period=day|week|month`, `/overall?mirrors=true|false`, `/python_major`, `/python_minor`, `/system`; data updated once daily; series kept 180 days; IP-based rate limiting; etiquette: cache, at most once per day per endpoint, use BigQuery for bulk | Verified: pypistats.org/api/ |
| pypistats | Numeric rate limit, and the time of day data refreshes | **Verify** |
| Hugging Face | `GET /api/models` supports `sort` (e.g. `downloads, likes, lastModified, trendingScore`), `direction`, `limit`, `cursor` from the `Link` header, `expand`, `filter`, `search`, `author` | Verified: huggingface.co/.well-known/openapi.md (+ observed `Link rel="next"`) |
| Hugging Face | `expand[]=downloadsAllTime` returns an all-time download counter; `downloads` is rolling (≈ 30 days) | Field observed; **rolling-window semantics: verify** |
| Hugging Face | `GET /api/trending?type=&limit=`; `GET /api/daily_papers?p&limit&date&week&month&submitter&sort`; `GET /api/papers/{id}` (`upvotes`, `linkedModels`, ...); daily-paper entries include `githubRepo`/`githubStars` when present | OpenAPI-listed + observed |
| Hugging Face | Rate limits over 5-minute fixed windows: API bucket anonymous 500, free user 1,000, PRO 2,500 (Sep 2025 values); headers `RateLimit` / `RateLimit-Policy` (IETF draft v9); 429 on exceed | Verified: huggingface.co/docs/hub/rate-limits (+ observed `"api";r=499;t=235`, `q=500;w=300`) |
| Hugging Face | Sort fields for `/api/spaces` and `/api/datasets`; `arxiv:{id}` tag format on models | **Verify** |
| arXiv | `http(s)://export.arxiv.org/api/query` with `search_query`, `id_list`, `start`, `max_results`, `sortBy=relevance|lastUpdatedDate|submittedDate`, `sortOrder`; Atom 1.0 output; `cat:` prefix; `submittedDate:[YYYYMMDDTTTT TO YYYYMMDDTTTT]` | Verified: info.arxiv.org/help/api/user-manual.html |
| arXiv | ToS: no more than 1 request every 3 s, a single connection at a time, across all machines; `max_results` ≤ 2,000 per slice, ≤ 30,000 total; results update once daily, so cache | Verified: info.arxiv.org/help/api/tou.html + user manual |
| MCP Registry | `GET https://registry.modelcontextprotocol.io/v0.1/servers` (and `/v0/servers`) with `cursor`, `limit`, `updated_since`, `search`, `version`, `include_deleted`; response `servers[].server` + `_meta["io.modelcontextprotocol.registry/official"]` + `metadata.nextCursor` | Verified: registry.modelcontextprotocol.io/openapi.yaml + live response |
| MCP Registry | Rate limits; which of v0 / v0.1 is the stable contract | **Verify** |
| GitHub topics / npm keyword for MCP | `topic:mcp-server` search; npm `keywords:mcp` | Query syntax verified (search docs); result volumes not measured |
| Package versions | fastify 5.x, drizzle-orm 0.45.x, drizzle-kit 0.31.x, bullmq 6.x (peer ioredis ≥ 5), zod 4.x, @modelcontextprotocol/sdk 1.32.x, next 15.5.x (16.x is latest), prom-client 15.x, pino 10.x, vitest 5.x, turbo 2.x, typescript 5.9 (6.0 and 7.0 published) | Verified: npm registry on 2026-10-17 |
| Free tiers (Render, Neon, Upstash, Resend, Vercel, Fly, Oracle) | Limits quoted in 17.6 | **Verify** (these change often) |

---

## Appendix B: Glossary and Naming Registry

Single source of truth for names. If code needs a new name, add it here in the same commit.

**Sources:** `github`, `npm`, `pypi`, `huggingface`, `arxiv`, `mcp`. **Scopes:** sources + `all`. **Windows:** `24h`, `7d`, `30d`. **Tiers:** `hot`, `warm`, `cold`, `archived`.
**Item kinds:** `repo`, `package`, `model`, `dataset`, `space`, `paper`, `mcp_server`.
**Metrics:** `stars`, `forks`, `watchers`, `open_issues`, `downloads`, `downloads_total`, `likes`, `upvotes`, `trending_score`, `comments`.

**Tables:** `items`, `item_aliases`, `topics`, `item_topics`, `snapshots` (partitioned: `snapshots_YYYY_MM`, `snapshots_default`), `daily_metrics`, `scores`, `score_runs_current`, `ingestion_runs`, `users`, `auth_tokens`, `api_keys`, `watchlists`, `watchlist_items`, `alerts`, `alert_events`, `digest_subscriptions`, `digest_sends`, `outbox_events` (stretch).
**SQL functions:** `ensure_snapshot_partitions(months_back, months_ahead)`, `drop_old_snapshot_partitions(keep_months)`. **Repository functions:** `pruneScores(hourlyHours, dailyDays)` (`scores.repo.ts`, 6.5).
**Env vars:** as in `EnvSchema` (15) and `.env.example` (17.3), incl. `SCORES_HOURLY_RETENTION_HOURS`, `SCORES_DAILY_RETENTION_DAYS`.
**Metrics:** as listed in 14.1, incl. `trendr_snapshots_default_rows`. **Prometheus alerts:** `IngestionStale`, `UpstreamRateLimited`, `DeadLetterGrowing`, `ApiHighErrorRate`, `ApiSlowLeaderboard`, `SnapshotsDefaultNotEmpty`.
**Scoring:** eligible = `final_score > 0` (no `insufficient_data` / `negative_growth` / `below_threshold`); only eligible items get `scores` rows. Params keys (8.3): `github:stars`, `npm:downloads`, `pypi:downloads`, `huggingface:likes`, `arxiv:upvotes`, `mcp:stars`, `mcp:downloads`. `STALENESS_LIMIT`: hot 3 h, warm 12 h, cold 36 h.

**BullMQ queues:** `ingest-github`, `ingest-npm`, `ingest-pypi`, `ingest-huggingface`, `ingest-arxiv`, `ingest-mcp`, `scoring`, `notify`, `digest`, `maintenance`, `dead-letter`.
**Job names:** ingest: `discover`, `snapshot-fanout`, `snapshot`, `daily`, `backfill`, `refresh-item`; scoring: `compute-scores`; notify: `evaluate-alerts`, `send-alert-email`; digest: `build-weekly-digest`, `send-digest`; maintenance: `create-partitions`, `retention`, `retier-items`, `rollup-daily`, `cleanup-tokens`; DLQ: `dead`.
**Scheduler ids:** as listed in 7.2.

**Redis keys:** `lb:{scope}:{window}:{lang}`, `lb:{scope}:{window}:{lang}:tmp:{runId}`, `lbmeta:{scope}:{window}`, `card:{itemId}:{window}`, `item:{itemId}`, `hist:{itemId}:{metric}:{granularity}:{rangeKey}`, `q:{sha1}`, `rl:{bucket}`, `rl:{bucket}:pause`, `apirl:*`, `apirl:sse:{id}`, `etag:github:{itemId}`, `lock:score:{source}`, `lock:arxiv:conn`, `mcp:registry:cursor_ts`, `digest:content:{date}`. **Pub/sub:** `events:leaderboard`.
**Token buckets:** `github:core`, `github:search`, `github:graphql`, `npm:registry`, `npm:downloads`, `pypi:json`, `pypi:stats`, `huggingface:api`, `arxiv:api`, `mcp:registry`.

**SSE events:** `leaderboard.snapshot`, `leaderboard.update`, `shutdown`.
**Problem types:** `validation-error`, `not-found`, `unauthorized`, `forbidden`, `conflict`, `rate-limited`, `cursor-expired`, `internal`.
**Ports:** web 3000, grafana 3001, api 4000, mcp 4100, postgres 5432, redis 6379, mailpit 8025/1025, prometheus 9090, worker health/metrics 9464 (Docker network only, not published), jaeger 16686/4318.
**Cookies / headers:** `dt_refresh`, `X-API-Key`, `X-Request-Id`, `X-Requested-With: trendr`.
**API key format:** `dt_live_<8-char prefix>_<32 base62>`.
