import { defineConfig } from 'vitest/config';

// Two workspace projects (spec task 0.3):
//  - `unit`: fast, no IO — colocated `*.test.ts(x)` next to sources.
//  - `int` : integration tests (Postgres/Redis via Testcontainers later) under `test/int/`.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/src/**/*.test.{ts,tsx}'],
        },
      },
      {
        test: {
          name: 'int',
          include: ['{apps,packages}/*/test/int/**/*.int.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
