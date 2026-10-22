import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { alertTypeEnum, sourceEnum, windowEnum } from './enums.js';
import { items } from './items.js';
import { ingestionRuns } from './ops.js';
import { users } from './users.js';

/** Spec §6.2 engagement tables. */
export const watchlists = pgTable(
  'watchlists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('watchlists_name_ck', sql`length(${t.name}) BETWEEN 1 AND 80`),
    unique('watchlists_user_name_uq').on(t.userId, t.name),
    uniqueIndex('watchlists_one_default')
      .on(t.userId)
      .where(sql`${t.isDefault}`),
  ],
);

export const watchlistItems = pgTable(
  'watchlist_items',
  {
    watchlistId: uuid('watchlist_id')
      .notNull()
      .references(() => watchlists.id, { onDelete: 'cascade' }),
    itemId: bigint('item_id', { mode: 'bigint' })
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.watchlistId, t.itemId] }),
    index('watchlist_items_item_idx').on(t.itemId),
  ],
);

export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: alertTypeEnum('type').notNull(),
    itemId: bigint('item_id', { mode: 'bigint' }).references(() => items.id, {
      onDelete: 'cascade',
    }),
    watchlistId: uuid('watchlist_id').references(() => watchlists.id, { onDelete: 'cascade' }),
    window: windowEnum('window').notNull().default('24h'),
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    cooldownHours: integer('cooldown_hours').notNull().default(24),
    enabled: boolean('enabled').notNull().default(true),
    lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('alerts_cooldown_ck', sql`${t.cooldownHours} BETWEEN 1 AND 720`),
    check(
      'alerts_target_ck',
      sql`(${t.type} = 'rank_entered' AND ${t.itemId} IS NULL AND ${t.watchlistId} IS NULL) OR (${t.type} <> 'rank_entered' AND num_nonnulls(${t.itemId}, ${t.watchlistId}) = 1)`,
    ),
    index('alerts_user_idx').on(t.userId),
    index('alerts_item_idx')
      .on(t.itemId)
      .where(sql`${t.enabled}`),
    index('alerts_watchlist_idx')
      .on(t.watchlistId)
      .where(sql`${t.enabled}`),
    index('alerts_type_idx')
      .on(t.type)
      .where(sql`${t.enabled}`),
  ],
);

export const alertEvents = pgTable(
  'alert_events',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    alertId: uuid('alert_id')
      .notNull()
      .references(() => alerts.id, { onDelete: 'cascade' }),
    itemId: bigint('item_id', { mode: 'bigint' })
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    scoreRunId: bigint('score_run_id', { mode: 'bigint' })
      .notNull()
      .references(() => ingestionRuns.id),
    dedupeKey: text('dedupe_key').notNull().unique(), // alert_id:item_id:window:cooldown_bucket
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    triggeredAt: timestamp('triggered_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    deliveryStatus: text('delivery_status').notNull().default('pending'),
  },
  (t) => [
    check(
      'alert_events_delivery_status_ck',
      sql`${t.deliveryStatus} IN ('pending', 'sent', 'failed', 'suppressed')`,
    ),
    index('alert_events_pending_idx')
      .on(t.deliveryStatus)
      .where(sql`${t.deliveryStatus} = 'pending'`),
  ],
);

export const digestSubscriptions = pgTable(
  'digest_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    sources: sourceEnum('sources')
      .array()
      .notNull()
      .default(['github', 'npm', 'pypi', 'huggingface', 'arxiv', 'mcp']),
    topics: text('topics')
      .array()
      .notNull()
      .default(sql`'{}'`),
    includeWatchlist: boolean('include_watchlist').notNull().default(true),
    dayOfWeek: smallint('day_of_week').notNull().default(1), // 0=Sun
    enabled: boolean('enabled').notNull().default(true),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('digest_subscriptions_day_ck', sql`${t.dayOfWeek} BETWEEN 0 AND 6`)],
);

export const digestSends = pgTable(
  'digest_sends',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => digestSubscriptions.id, { onDelete: 'cascade' }),
    weekStart: date('week_start', { mode: 'string' }).notNull(), // Monday (UTC) of the digest week
    status: text('status').notNull(),
    providerMessageId: text('provider_message_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    unique('digest_sends_uq').on(t.subscriptionId, t.weekStart),
    check('digest_sends_status_ck', sql`${t.status} IN ('pending', 'sent', 'failed', 'skipped')`),
  ],
);
