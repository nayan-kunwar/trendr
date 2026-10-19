import { eq } from 'drizzle-orm';

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
