import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

import { jobTypeEnum, runStatusEnum, sourceEnum } from './enums.js';

/** Spec §6.2 ops/audit tables. */
export const ingestionRuns = pgTable(
  'ingestion_runs',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    source: sourceEnum('source'), // null for cross-source jobs (digest, maintenance)
    jobType: jobTypeEnum('job_type').notNull(),
    jobId: text('job_id').notNull(), // BullMQ job id (idempotency key)
    attempt: integer('attempt').notNull().default(1),
    status: runStatusEnum('status').notNull().default('running'),
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    itemsSeen: integer('items_seen').notNull().default(0),
    itemsUpserted: integer('items_upserted').notNull().default(0),
    itemsFailed: integer('items_failed').notNull().default(0),
    apiCalls: integer('api_calls').notNull().default(0),
    notModified: integer('not_modified').notNull().default(0), // 304 responses (GitHub ETag)
    rateLimitRemaining: integer('rate_limit_remaining'),
    error: text('error'),
  },
  (t) => [
    unique('ingestion_runs_job_attempt_uq').on(t.jobId, t.attempt),
    index('ingestion_runs_source_started_idx').on(t.source, t.startedAt.desc()),
    index('ingestion_runs_status_idx')
      .on(t.status)
      .where(sql`${t.status} IN ('running', 'failed')`),
  ],
);

/** Stretch: transactional outbox (spec §19). */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    aggregate: text('aggregate').notNull(), // 'leaderboard' | 'alert'
    eventType: text('event_type').notNull(), // 'leaderboard.updated' | 'alert.triggered'
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [
    index('outbox_unpublished_idx')
      .on(t.id)
      .where(sql`${t.publishedAt} IS NULL`),
  ],
);
