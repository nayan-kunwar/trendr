import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { metricEnum, sourceEnum, windowEnum } from './enums.js';
import { items } from './items.js';
import { ingestionRuns } from './ops.js';

export const dailyMetrics = pgTable(
  'daily_metrics',
  {
    itemId: bigint('item_id', { mode: 'bigint' })
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    metric: metricEnum('metric').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    value: bigint('value', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.metric, t.day] }),
    check('daily_metrics_value_ck', sql`${t.value} >= 0`),
    index('daily_metrics_day_idx').on(t.day),
  ],
);

/** Only eligible rows (final_score > 0) are inserted (spec §8.4); retention in §6.5. */
export const scores = pgTable(
  'scores',
  {
    itemId: bigint('item_id', { mode: 'bigint' })
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    window: windowEnum('window').notNull(),
    runId: bigint('run_id', { mode: 'bigint' })
      .notNull()
      .references(() => ingestionRuns.id),
    source: sourceEnum('source').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
    delta: doublePrecision('delta').notNull(),
    base: doublePrecision('base').notNull(),
    relGrowth: doublePrecision('rel_growth').notNull(),
    rawScore: doublePrecision('raw_score').notNull(),
    ageFactor: doublePrecision('age_factor').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    anomalyPenalty: doublePrecision('anomaly_penalty').notNull(),
    finalScore: doublePrecision('final_score').notNull(),
    zScore: doublePrecision('z_score').notNull(),
    percentile: doublePrecision('percentile').notNull(),
    rankSource: integer('rank_source'),
    rankAll: integer('rank_all'),
    flags: text('flags')
      .array()
      .notNull()
      .default(sql`'{}'`),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.window, t.runId] }),
    index('scores_board_idx').on(t.source, t.window, t.runId, t.finalScore.desc()),
    index('scores_item_time_idx').on(t.itemId, t.window, t.computedAt.desc()),
    // M-4: retention deletes runs and Postgres checks `scores.run_id` on every
    // `ingestion_runs` delete; without this the FK check scans the table.
    index('scores_run_idx').on(t.runId),
  ],
);

/** Pointer to the current scoring run per (source, window); swapped atomically after a run. */
export const scoreRunsCurrent = pgTable(
  'score_runs_current',
  {
    source: sourceEnum('source').notNull(),
    window: windowEnum('window').notNull(),
    runId: bigint('run_id', { mode: 'bigint' })
      .notNull()
      .references(() => ingestionRuns.id),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.window] })],
);
