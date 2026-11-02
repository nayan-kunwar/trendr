# Trendr — Agent Operating Rules

> Verbatim copy of **Section 0** of [`TRENDR_SPEC.md`](./TRENDR_SPEC.md). The spec itself is frozen —
> do not edit it. Records of deviations live in [`docs/SPEC_REVIEW.md`](./docs/SPEC_REVIEW.md) and
> decisions in [`docs/adr/`](./docs/adr).

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

---

Repo specifics that complement the rules above: the Vitest workspace runs from the repo root
(`pnpm test`, `pnpm test:coverage`, `pnpm test:int` — workspace packages resolve to sources), CI is
[`.github/workflows/ci.yml`](./.github/workflows/ci.yml), and the local stack is
`docker compose up --build --wait postgres redis migrate api worker web mcp`. See
[`README.md`](./README.md) for commands and environment variables.
