import { and, eq, isNull, sql } from 'drizzle-orm';

import type { DbExecutor } from '../client.js';
import { apiKeys } from '../schema/users.js';

/** Row shape the API needs to authenticate an `X-API-Key` (spec §10.5, §15). */
export interface ApiKeyRecord {
  id: string;
  userId: string;
  prefix: string;
  scopes: string[];
  rateLimitPerMin: number;
  /** HMAC-SHA256(API_KEY_PEPPER, full key) — compared in constant time. */
  keyHash: Buffer;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

/** Unique-prefix lookup — the only access path for request authentication. */
export async function findApiKeyByPrefix(
  db: DbExecutor,
  prefix: string,
): Promise<ApiKeyRecord | null> {
  const rows = await db
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      prefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      rateLimitPerMin: apiKeys.rateLimitPerMin,
      keyHash: apiKeys.keyHash,
      revokedAt: apiKeys.revokedAt,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.prefix, prefix))
    .limit(1);
  return rows[0] ?? null;
}

/** Spec §10.5: `last_used_at` writes are debounced to at most once per minute. */
export async function touchApiKeyLastUsed(db: DbExecutor, id: string, at: Date): Promise<void> {
  await db.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, id));
}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  rateLimitPerMin: number;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const summaryColumns = {
  id: apiKeys.id,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  scopes: apiKeys.scopes,
  rateLimitPerMin: apiKeys.rateLimitPerMin,
  lastUsedAt: apiKeys.lastUsedAt,
  expiresAt: apiKeys.expiresAt,
  revokedAt: apiKeys.revokedAt,
  createdAt: apiKeys.createdAt,
};

export async function listApiKeysForUser(db: DbExecutor, userId: string): Promise<ApiKeySummary[]> {
  return db
    .select(summaryColumns)
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(apiKeys.createdAt);
}

export async function countActiveApiKeysForUser(db: DbExecutor, userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));
  return row?.count ?? 0;
}

export interface ApiKeyInsert {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  keyHash: Buffer;
  scopes: string[];
  rateLimitPerMin: number;
  expiresAt: Date | null;
}

export async function insertApiKey(db: DbExecutor, input: ApiKeyInsert): Promise<ApiKeySummary> {
  const [row] = await db.insert(apiKeys).values(input).returning(summaryColumns);
  if (row === undefined) throw new Error('insertApiKey returned no row');
  return row;
}

export async function revokeApiKey(
  db: DbExecutor,
  userId: string,
  keyId: string,
  at: Date,
): Promise<ApiKeySummary | null> {
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: at })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .returning(summaryColumns);
  return row ?? null;
}
