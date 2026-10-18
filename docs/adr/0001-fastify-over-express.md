# 0001 — Fastify over Express

- Status: Accepted
- Date: 2026-10-18
- Phase: 0
- Source: TRENDR_SPEC.md §2.1

## Context

The API needs schema-validated HTTP input/output, OpenAPI generated from one source of truth, fast
JSON serialization for leaderboard pages (~100 rows), clean plugin-based dependency injection, and
HTTP tests that do not open a port. With Express those concerns need several separate libraries
(validation, serialization, docs).

## Decision

Use **Fastify 5** with the Zod type provider.

- Route schemas validate input, serialize output and generate `openapi.json` (Phase 3.1).
- `fastify-plugin` + decorators (`app.db`, `app.redis`, `app.cache`) provide encapsulated DI.
- Built-in pino logging with request ids; `app.inject()` powers fast tests (see
  `apps/api/src/app.test.ts`).
- Typed errors from `@trendr/core` map to RFC 7807 through one error plugin.

## Consequences

- Smaller ecosystem than Express and some learning curve — a deliberate trade-off (interview
  narrative in §2.1).
- Plugin ordering matters (`@fastify/helmet`, CORS, metrics registered before routes).
