import { and, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';

import type { DbExecutor } from '../client.js';
import { authTokens } from '../schema/users.js';

export type AuthTokenRecord = typeof authTokens.$inferSelect;
export type AuthTokenKind = AuthTokenRecord['kind'];

export interface InsertAuthTokenInput {
  userId: string;
  kind: AuthTokenKind;
  tokenHash: Buffer;
  familyId?: string | null;
  expiresAt: Date;
  createdIp?: string | null;
  userAgent?: string | null;
}

export async function insertAuthToken(
  db: DbExecutor,
  input: InsertAuthTokenInput,
): Promise<AuthTokenRecord> {
  const [row] = await db
    .insert(authTokens)
    .values({
      userId: input.userId,
      kind: input.kind,
      tokenHash: input.tokenHash,
      familyId: input.familyId ?? null,
      expiresAt: input.expiresAt,
      createdIp: input.createdIp ?? null,
      userAgent: input.userAgent ?? null,
    })
    .returning();
  if (row === undefined) throw new Error('insertAuthToken: insert returned no row');
  return row;
}

export interface FindAuthTokenOptions {
  /** Lock the row for the consume/rotate transaction (spec §10.5). */
  forUpdate?: boolean;
}

export async function findAuthTokenByHash(
  db: DbExecutor,
  tokenHash: Buffer,
  options: FindAuthTokenOptions = {},
): Promise<AuthTokenRecord | null> {
  const query = db.select().from(authTokens).where(eq(authTokens.tokenHash, tokenHash)).limit(1);
  const rows = options.forUpdate === true ? await query.for('update') : await query;
  return rows[0] ?? null;
}

export async function markAuthTokenUsed(db: DbExecutor, id: string, usedAt: Date): Promise<void> {
  await db.update(authTokens).set({ usedAt }).where(eq(authTokens.id, id));
}

/** Revoke every token in a refresh family (rotation and theft detection). */
export async function revokeAuthTokenFamily(
  db: DbExecutor,
  familyId: string,
  revokedAt: Date,
): Promise<void> {
  await db
    .update(authTokens)
    .set({ revokedAt })
    .where(and(eq(authTokens.familyId, familyId), isNull(authTokens.revokedAt)));
}

export async function revokeAuthToken(db: DbExecutor, id: string, revokedAt: Date): Promise<void> {
  await db.update(authTokens).set({ revokedAt }).where(eq(authTokens.id, id));
}

/**
 * OAuth claim of an unverified placeholder: any magic link requested before
 * the provider proved ownership must stop working, otherwise whoever
 * requested it could still sign in to the claimed account.
 */
export async function revokeUnusedMagicLinks(
  db: DbExecutor,
  userId: string,
  revokedAt: Date,
): Promise<void> {
  await db
    .update(authTokens)
    .set({ revokedAt })
    .where(
      and(
        eq(authTokens.userId, userId),
        eq(authTokens.kind, 'magic_link'),
        isNull(authTokens.usedAt),
        isNull(authTokens.revokedAt),
      ),
    );
}

/** Maintenance: drop expired and long-revoked rows (spec §7.10 cleanup-tokens). */
export async function deleteExpiredAuthTokens(db: DbExecutor, before: Date): Promise<number> {
  const rows = await db
    .delete(authTokens)
    .where(
      or(
        lt(authTokens.expiresAt, before),
        and(isNotNull(authTokens.revokedAt), lt(authTokens.revokedAt, before)),
      ),
    )
    .returning({ id: authTokens.id });
  return rows.length;
}
