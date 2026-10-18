# 0010 — Workspace packages resolve to sources (dev/test) and dist (runtime)

- Status: Accepted
- Date: 2026-10-18
- Phase: 0 (0.1–0.8)

## Context

`@trendr/*` packages are built by tsup to `dist/`. If lint, typecheck and tests resolved the built
output, every edit would require a rebuild first, CI would need a build step before unit tests, and
a stale `dist` could mask source-level errors. If images bundled workspace sources instead of
external packages, `pnpm deploy` would break (ADR-0006).

## Decision

Two worlds with an explicit boundary:

- **Static analysis and tests**: `tsconfig.base.json` `paths` map `@trendr/*` →
  `packages/*/src/index.ts`; the root `vitest.config.ts` carries the same aliases. Lint, typecheck
  and tests always run against sources — no prior build.
- **Runtime**: package `exports` point at `dist/`; tsup keeps `@trendr/*` external in app bundles;
  images build with turbo (`dependsOn: ["^build"]`) and deploy with pnpm.
- Consequence of `paths`: package tsconfigs dropped `rootDir: "src"` (TS6059 once cross-package
  sources join one program). `tsc` is only ever run with `--noEmit`; tsup emits the artifacts.

## Consequences

- `pnpm test` works on a fresh clone with zero builds; editors jump straight to sources.
- CI's integration job still runs `pnpm turbo run build --filter=./packages/*` so the build graph
  and dist artifacts stay verified.
- Anyone adding a new workspace package must add it to the `paths`/alias tables (three places:
  tsconfig.base, vitest.config, and the eslint layer matrix if it is a new layer).
