import { bigint, pgTable, primaryKey, timestamp } from 'drizzle-orm/pg-core';

import { metricEnum } from './enums.js';

/**
 * Spec §6.2/§6.3 `snapshots` — declared for typing only.
 *
 * The real table is created by the hand-written `migrations/0001_partitions.sql`
 * (`PARTITION BY RANGE (captured_at)`), never by drizzle-kit. This module is
 * deliberately **not** re-exported from `schema/index.ts` (the entry `drizzle.config.ts`
 * points at), so kit can neither create, diff nor drop it; `tablesFilter` in
 * `drizzle.config.ts` keeps the same guarantee for DB-side operations (task 1.1).
 */
export const snapshots = pgTable(
  'snapshots',
  {
    itemId: bigint('item_id', { mode: 'bigint' }).notNull(),
    metric: metricEnum('metric').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(), // bucket start (hour or day)
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
    value: bigint('value', { mode: 'number' }).notNull(),
    runId: bigint('run_id', { mode: 'bigint' }),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.metric, t.capturedAt] })],
);
