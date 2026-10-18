# 0007 — Dependency-direction linting with `no-restricted-imports`

- Status: Accepted
- Date: 2026-10-18
- Phase: 0 (0.2)
- Source: TRENDR_SPEC.md §0 (import boundaries), §4 (package layout)

## Context

The spec requires an enforced dependency direction: apps may import packages; packages must not
import apps; `core` stays free of infra dependencies. `eslint-plugin-boundaries` — the usual tool —
was not compatible with ESLint 9 flat config in the versions available at implementation time.

## Decision

Encode the layer matrix directly in the root `eslint.config.js`:

- `LAYER_RESTRICTIONS` maps each workspace layer (`core`, `config`, `logger`, `db`, `sources`,
  `apps`) to the import globs it may **not** use.
- The core `no-restricted-imports` rule enforces it per package with a message naming the allowed
  direction. A `no-explicit-any: error` rule runs alongside.

## Consequences

- Zero extra plugins; the matrix is readable in one place and runs in `pnpm lint` (turbo) and CI.
- Adding a package means adding a row to `LAYER_RESTRICTIONS` — visible in review.
- Only import *paths* are checked; runtime coupling is still caught by typecheck and tests.
