import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';

import { tsvector } from './columns.js';
import { aliasRelEnum, itemKindEnum, metricEnum, sourceEnum, tierEnum } from './enums.js';

/** Spec §6.2 `items`, including the stored generated `search_tsv`. */
export const items = pgTable(
  'items',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    source: sourceEnum('source').notNull(),
    kind: itemKindEnum('kind').notNull(),
    externalId: text('external_id').notNull(),
    upstreamId: text('upstream_id'),
    name: text('name').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description'),
    url: text('url').notNull(),
    homepage: text('homepage'),
    language: text('language'),
    license: text('license'),
    owner: text('owner'),
    primaryMetric: metricEnum('primary_metric').notNull(),
    latestMetrics: jsonb('latest_metrics')
      .$type<Partial<Record<string, number>>>()
      .notNull()
      .default({}),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    tier: tierEnum('tier').notNull().default('cold'),
    flags: text('flags')
      .array()
      .notNull()
      .default(sql`'{}'`),
    isArchived: boolean('is_archived').notNull().default(false),
    isDeleted: boolean('is_deleted').notNull().default(false),
    upstreamCreatedAt: timestamp('upstream_created_at', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSnapshotAt: timestamp('last_snapshot_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce(display_name,'')), 'A') || setweight(to_tsvector('english', coalesce(description,'')), 'B')`,
    ),
  },
  (t) => [
    unique('items_source_external_uq').on(t.source, t.externalId),
    uniqueIndex('items_source_upstream_uq')
      .on(t.source, t.upstreamId)
      .where(sql`${t.upstreamId} IS NOT NULL`),
    index('items_tier_idx')
      .on(t.source, t.tier)
      .where(sql`NOT ${t.isDeleted}`),
    index('items_language_idx')
      .on(t.language)
      .where(sql`${t.language} IS NOT NULL`),
    index('items_search_idx').using('gin', t.searchTsv),
    index('items_name_trgm_idx').using('gin', sql`${t.displayName} gin_trgm_ops`),
    index('items_created_idx').on(t.source, t.upstreamCreatedAt.desc()),
  ],
);

export const itemAliases = pgTable(
  'item_aliases',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    itemId: bigint('item_id', { mode: 'bigint' })
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    aliasItemId: bigint('alias_item_id', { mode: 'bigint' })
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    relation: aliasRelEnum('relation').notNull(),
    confidence: real('confidence').notNull(),
    evidence: text('evidence').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('item_aliases_uq').on(t.itemId, t.aliasItemId, t.relation),
    check('item_aliases_no_self', sql`${t.itemId} <> ${t.aliasItemId}`),
    check('item_aliases_confidence_ck', sql`${t.confidence} BETWEEN 0 AND 1`),
    index('item_aliases_alias_idx').on(t.aliasItemId),
  ],
);

export const topics = pgTable(
  'topics',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    itemCount: integer('item_count').notNull().default(0),
  },
  (t) => [check('topics_slug_ck', sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{0,49}$'`)],
);

export const itemTopics = pgTable(
  'item_topics',
  {
    itemId: bigint('item_id', { mode: 'bigint' })
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    topicId: integer('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.topicId] }),
    index('item_topics_topic_idx').on(t.topicId, t.itemId),
  ],
);
