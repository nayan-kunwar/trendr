import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

// Unit tests import workspace packages by name; resolve them straight to
// sources so `pnpm test` never needs a prior build.
const workspaceAliases: Record<string, string> = {
  '@trendr/config': resolve(import.meta.dirname, 'packages/config/src/index.ts'),
  '@trendr/core': resolve(import.meta.dirname, 'packages/core/src/index.ts'),
  '@trendr/db': resolve(import.meta.dirname, 'packages/db/src/index.ts'),
  '@trendr/logger': resolve(import.meta.dirname, 'packages/logger/src/index.ts'),
  '@trendr/sources': resolve(import.meta.dirname, 'packages/sources/src/index.ts'),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/src/**/*.test.{ts,tsx}'],
        },
      },
      {
        resolve: { alias: workspaceAliases },
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
