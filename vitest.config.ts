import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

// Unit tests import workspace packages by name; resolve them straight to
// sources so `pnpm test` never needs a prior build. Subpath aliases must come
// before their parent prefix (`@trendr/db` also prefix-matches `/migrate`).
const workspaceAliases: Record<string, string> = {
  '@trendr/config': resolve(import.meta.dirname, 'packages/config/src/index.ts'),
  '@trendr/core': resolve(import.meta.dirname, 'packages/core/src/index.ts'),
  '@trendr/db/migrate': resolve(import.meta.dirname, 'packages/db/src/migrate.ts'),
  '@trendr/db/seed': resolve(import.meta.dirname, 'packages/db/src/seed.ts'),
  '@trendr/db': resolve(import.meta.dirname, 'packages/db/src/index.ts'),
  '@trendr/logger': resolve(import.meta.dirname, 'packages/logger/src/index.ts'),
  '@trendr/sources': resolve(import.meta.dirname, 'packages/sources/src/index.ts'),
};

export default defineConfig({
  test: {
    // Root-only option (vitest `NonProjectOptions`): all files run sequentially.
    // The int project shares one Testcontainers database, and partition DDL
    // (`CREATE/DROP ... PARTITION OF` locks the parent) deadlocked against the
    // seed's multi-second insert transaction when files ran in parallel
    // (observed `40P01` in `partitions.int.test.ts`). The unit suite is small
    // enough that serializing it costs ~1s.
    fileParallelism: false,
    projects: [
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: 'unit',
          include: [
            '{apps,packages}/*/src/**/*.test.{ts,tsx}',
            // Package-level test roots (spec §16): top level and an optional
            // `unit/` subtree — both non-recursive past that, so `test/int/**`
            // int tests never leak into the unit project.
            '{apps,packages}/*/test/*.test.{ts,tsx}',
            '{apps,packages}/*/test/unit/**/*.test.{ts,tsx}',
          ],
        },
      },
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: 'int',
          include: ['{apps,packages}/*/test/int/**/*.int.test.ts'],
          // Spec §16: Testcontainers Postgres 16 + Redis 7, migrations applied once.
          globalSetup: ['./test/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        // Spec §16: real-network schema probes, nightly only. `pnpm test` and
        // `pnpm test:int` never select this project; the package script gates it
        // behind CONTRACT=1 and the tests skip without it.
        resolve: { alias: workspaceAliases },
        test: {
          name: 'contract',
          include: ['packages/sources/test/contract/**/*.contract.test.ts'],
          testTimeout: 90_000,
          hookTimeout: 30_000,
        },
      },
    ],
    // CI uploads coverage/coverage-summary.json as an artifact (spec §17.4).
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
      // Measure sources only: no build output, no configs, no type-only files.
      include: ['{apps,packages}/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.d.ts', '**/*.test.{ts,tsx}'],
      // Spec §16: the scoring math is the riskiest pure logic in the codebase
      // (task 2.1/2.2 acceptance). Lines/statements/functions at 95% mirror the
      // `packages/core` row of the spec's coverage table; branches use its 90%
      // (a few defensive `?? fallback` branches are unreachable at runtime).
      thresholds: {
        'packages/core/src/scoring/**': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
      },
    },
  },
});
