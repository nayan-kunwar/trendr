import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config (spec task 1.1). `snapshots` is created by the hand-written
 * `0001_partitions.sql` (PARTITION BY RANGE) and is deliberately absent from the
 * kit schema entry (`src/schema/index.ts` omits it; see `src/schema/snapshots.ts`),
 * while `tablesFilter` keeps DB-side diffing away from it too (spec §6.4).
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  tablesFilter: ['!snapshots*'],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://trendr:trendr@localhost:5432/trendr',
  },
});
