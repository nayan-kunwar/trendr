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
  uuid,
} from 'drizzle-orm/pg-core';

import { jobTypeEnum, runStatusEnum, sourceEnum } from './enums.js';
import { users } from './users.js';

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

/**
 * M-6: durable operator audit trail. Every admin mutation writes one row —
 * inside the mutation's transaction where the mutation is a database write,
 * immediately after a successful enqueue otherwise. `ON DELETE SET NULL` keeps
 * the trail when an operator account is removed.
 */
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(), // 'item.patch' | 'ingest.trigger' | ...
    target: text('target'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('admin_audit_log_created_idx').on(t.createdAt.desc()),
    index('admin_audit_log_actor_idx').on(t.actorUserId, t.createdAt.desc()),
  ],
);
