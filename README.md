# Trendr

Developer-artifact trending tracker. Trendr watches what developers are paying attention to across
**GitHub, npm, PyPI, Hugging Face, arXiv and the MCP registry**, scores _velocity_ (not raw
popularity), and serves the result through a public API, an SSE live leaderboard, a Next.js UI and
an MCP server for agents.

> Built from [`TRENDR_SPEC.md`](./TRENDR_SPEC.md) (v1.1, frozen). Spec deviations and verified gaps
> are tracked in [`docs/SPEC_REVIEW.md`](./docs/SPEC_REVIEW.md); decisions live in
> [`docs/adr/`](./docs/adr).

## Status

| Phase | Scope                                            | State   |
| ----- | ------------------------------------------------ | ------- |
| 0     | Scaffolding, tooling, CI skeleton, Compose stack | ✅ done |
| 1     | Database + core domain                           | ✅ done |
| 2     | Scoring engine (TDD)                             | ✅ done |
| 3     | Read API (public)                                | ✅ done |
| 4     | Ingestion framework + GitHub adapter             | ✅ done |
| 5     | npm, PyPI, Hugging Face, arXiv, MCP adapters     | ✅ done |
| 6     | Web frontend                                     | ⏳ next |
| 7     | Accounts, watchlists, alerts, digest             | ⏳      |
| 8     | MCP server                                       | ⏳      |
| 9     | Observability, security, operations              | ⏳      |
| 10    | Deployment and polish                            | ⏳      |

## Stack

- **API** — Fastify 5 + Zod (schema-first, RFC 7807 errors, OpenAPI from the same schemas)
- **Worker** — BullMQ on Redis 7 (schedulers, retries, rate-limited source adapters)
- **Data** — PostgreSQL 16 + Drizzle ORM (monthly-partitioned `snapshots`, raw-SQL migrations)
- **Web** — Next.js 15 App Router (Tailwind + shadcn/ui arrive in Phase 6)
- **MCP** — Model Context Protocol server (stdio + Streamable HTTP)
- **Tooling** — TypeScript 5 strict, pnpm 11 workspaces + Turborepo, Vitest, ESLint 9, Prettier,
  Docker Compose, GitHub Actions

## Repository layout

```text
apps/api        Fastify API              packages/config   zod env schema (fail-fast)
apps/worker     BullMQ worker            packages/core     domain types, errors, scoring
apps/web        Next.js frontend         packages/db       Drizzle schema, repos, migrations
apps/mcp        MCP server               packages/logger   pino factory + redaction
                                         packages/sources  source adapters (Phase 4+)
infra/          Dockerfiles, prometheus + grafana provisioning
docs/           ADRs, spec review, UI mockups
```

## Quickstart

Prerequisites: **Node 22**, **pnpm 11** (`corepack enable`), **Docker** (Compose v2).

```bash
pnpm install
cp .env.example .env            # safe local defaults; add tokens when you have them

# Option A — dev processes (turbo)
pnpm dev                        # api :4000, web :3000, worker, mcp

# Option B — full stack in Docker (blocks until healthy)
docker compose up --build --wait postgres redis migrate api worker web mcp
```

| Service                    | Where                                                                    |
| -------------------------- | ------------------------------------------------------------------------ |
| API                        | http://localhost:4000 (`/healthz`, `/readyz`)                            |
| Web                        | http://localhost:3000                                                    |
| MCP (HTTP transport)       | http://localhost:4100                                                    |
| Mailpit (email UI)         | http://localhost:8025                                                    |
| Worker metrics             | `worker:9464` inside the network only; `/metrics` needs the bearer token |
| Prometheus (profile `obs`) | http://localhost:9090                                                    |
| Grafana (profile `obs`)    | http://localhost:3001                                                    |
| Jaeger (profile `obs`)     | http://localhost:16686                                                   |

## Commands

| Command                                                 | What it does                                   |
| ------------------------------------------------------- | ---------------------------------------------- |
| `pnpm dev` / `pnpm build`                               | Turbo: run / build every workspace             |
| `pnpm lint` / `pnpm typecheck`                          | ESLint (type-checked) / `tsc --noEmit`         |
| `pnpm test` / `pnpm test:coverage` / `pnpm test:int`    | Vitest unit / unit + coverage / integration    |
| `CONTRACT=1 pnpm test:contract`                         | Live upstream schema probes (nightly CI)       |
| `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:seed` | Drizzle migrations and seed data               |
| `pnpm fixtures:record`                                  | Record upstream API fixtures for adapter tests |
| `pnpm ingest:bootstrap` / `pnpm worker:score`           | Manual ingestion / scoring triggers            |

## Environment

Key variables — the full annotated list is in [`.env.example`](./.env.example).

| Variable                        | Default                           | Purpose                                      |
| ------------------------------- | --------------------------------- | -------------------------------------------- |
| `NODE_ENV` / `LOG_LEVEL`        | `development` / `info`            | Runtime mode and pino level                  |
| `DATABASE_URL`                  | `…localhost:5432/trendr`          | Postgres connection (compose overrides host) |
| `REDIS_URL`                     | `redis://localhost:6379`          | Cache, queue and rate-limit store            |
| `API_PORT`                      | `4000`                            | Fastify listen port                          |
| `CORS_ORIGINS`                  | `http://localhost:3000`           | Allowed browser origins                      |
| `JWT_SECRET` / `API_KEY_PEPPER` | `change-me…`                      | Auth signing / key hashing (replace in prod) |
| `METRICS_TOKEN`                 | `change-me-metrics-token`         | Bearer token for `/metrics`                  |
| `WORKER_ROLES`                  | `scheduler,ingest,scoring,notify` | Comma-separated worker roles                 |
| `WORKER_METRICS_PORT`           | `9464`                            | Worker health/metrics port (never published) |
| `SCHEDULER_ENABLED`             | `true`                            | Enables BullMQ job schedulers                |
| `GITHUB_TOKENS` / `HF_TOKEN`    | empty                             | Upstream credentials (worker only)           |
| `EMAIL_PROVIDER` / `SMTP_URL`   | `smtp` / `…localhost:1025`        | Email delivery (Mailpit locally)             |
| `MCP_TRANSPORT` / `MCP_PORT`    | `http` / `4100`                   | MCP server mode and port                     |
| `NEXT_PUBLIC_API_URL`           | `http://localhost:4000`           | Browser-facing API base (web image only)     |

## Architecture in one paragraph

Postgres is the source of truth; Redis carries the cache, rate-limit buckets, BullMQ queues and
pub/sub. The worker ingests upstream APIs into partitioned `snapshots`, runs the scoring engine per
(source, window), and publishes leaderboards to Redis ZSETs; the API reads Redis first and falls
back to SQL; SSE broadcasts leaderboard updates to the web app. See `TRENDR_SPEC.md` §3 for the
full component diagram and §8 for the scoring model.

## Testing and CI

Vitest runs as one workspace from the repo root with `unit`, `int` and `contract` projects;
workspace packages resolve to sources, so tests never need a prior build. The contract project is
gated by `CONTRACT=1`, makes real upstream requests, and runs only in the nightly CI job. CI
([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)) runs lint + typecheck, unit tests with a
coverage artifact, integration tests, `gitleaks` + `pnpm audit`, and a Compose smoke test that
builds the whole stack, waits for health, seeds the database, triggers a scoring run and asserts
`/v1/trending` returns entries.

## Troubleshooting

- **Docker builds fail with registry timeouts** — image builds throttle installs
  (`--network-concurrency 6`, IPv4-first DNS) and pin pnpm via corepack. Build images one at a time
  (`docker compose build api && docker compose build worker && …`) to share the pnpm store cache
  mount. Details: ADR-0009.
- **`migrate` exits 0 and the stack still comes up** — expected: it is a one-shot service and
  `--wait` accepts `Exited (0)` on Compose v5.4+. Details: ADR-0005.
- **`docker compose port worker 9464` prints `invalid IP:0`** — Compose CLI quirk; 9464 is
  `expose`d for Prometheus only, never published. Verify with `docker inspect … NetworkSettings.Ports`.

## Documentation

- [`TRENDR_SPEC.md`](./TRENDR_SPEC.md) — the frozen specification (v1.1)
- [`CLAUDE.md`](./CLAUDE.md) — agent/contributor operating rules (spec Section 0)
- [`docs/adr/`](./docs/adr) — architecture decision records
- [`docs/SPEC_REVIEW.md`](./docs/SPEC_REVIEW.md) — deviations, verified gaps, deferred steps
- [`docs/mockups/`](./docs/mockups) — UI mockups (reference for Phase 6)
