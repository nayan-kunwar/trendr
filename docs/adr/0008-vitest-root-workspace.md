# 0008 — Vitest 3, root test workspace, v8 coverage

- Status: Accepted (revisit at Phase 2)
- Date: 2026-10-18
- Phase: 0 (0.3, 0.8)
- Source: TRENDR_SPEC.md §2 (stack table), §16, §17.4

## Context

Three frictions with the spec's CI test invocation:

1. The stack table lists **Vitest 5.x**; the stable line at implementation time is 3.x (which
   already provides the `projects` API this repo relies on).
2. `pnpm turbo run test -- --coverage` assumes per-package test scripts. This repo runs **one**
   Vitest workspace from the root (projects `unit` and `int`); invoking it per package would re-run
   the entire suite once per package.
3. pnpm 11 forwards `pnpm test -- --coverage` literally (including `--`), so the flag never reaches
   Vitest.

## Decision

- Stay on **Vitest 3.x** for Phase 0; checkpoint at Phase 2 (coverage gates on
  `packages/core/scoring` ≥ 95% are required there).
- Single root `vitest.config.ts` with `unit` and `int` projects; `@trendr/*` are aliased to their
  **sources** so tests need no prior build (see ADR-0010).
- Coverage via `@vitest/coverage-v8`: reporters `text` + `json-summary`, restricted to
  `{apps,packages}/*/src/**` (no dist/configs), written to `coverage/`; CI uploads
  `**/coverage/coverage-summary.json`.
- CI calls a dedicated script, `pnpm test:coverage`, instead of passing flags through pnpm.

## Consequences

- One test process; no N× duplicated runs. Turbo's `test` task caching stays unused until packages
  define their own scripts (acceptable while the suite is sub-second).
- The spec's `turbo run test` shape can be adopted later without changing the test layout.
