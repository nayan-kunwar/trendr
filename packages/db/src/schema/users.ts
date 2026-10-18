import { index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { bytea, citext, inet } from './columns.js';
import { tokenKindEnum, userRoleEnum } from './enums.js';

/** Spec §6.2 users & auth. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  displayName: text('display_name'),
  role: userRoleEnum('role').notNull().default('user'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: tokenKindEnum('kind').notNull(),
    tokenHash: bytea('token_hash').notNull().unique(), // sha256(token); raw token never stored
    familyId: uuid('family_id'), // refresh-token rotation family (reuse detection)
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdIp: inet('created_ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('auth_tokens_user_idx').on(t.userId, t.kind),
    index('auth_tokens_expiry_idx').on(t.expiresAt),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull().unique(), // 'dt_live_' + 8 chars, shown in UI
    keyHash: bytea('key_hash').notNull().unique(), // HMAC-SHA256(API_KEY_PEPPER, full key)
    // read | admin
    scopes: text('scopes').array().notNull().default(['read']),
    rateLimitPerMin: integer('rate_limit_per_min').notNull().default(120),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('api_keys_user_name_uq').on(t.userId, t.name)],
);
