import { eq, sql } from 'drizzle-orm';

import type { DbExecutor } from '../client.js';
import { users } from '../schema/users.js';

export type UserRecord = typeof users.$inferSelect;

export async function findUserByEmail(db: DbExecutor, email: string): Promise<UserRecord | null> {
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return rows[0] ?? null;
}

export async function findUserById(db: DbExecutor, id: string): Promise<UserRecord | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Magic links need a `users.id` because `auth_tokens.user_id` is NOT NULL, and
 * the spec deliberately avoids account enumeration. Issuing a link therefore
 * creates/keeps an unverified user; verification marks it verified.
 */
export async function ensureUserForLogin(
  db: DbExecutor,
  email: string,
  isAdmin: boolean,
): Promise<UserRecord> {
  const existing = await findUserByEmail(db, email);
  if (existing !== null) {
    if (isAdmin && existing.role !== 'admin') {
      const [updated] = await db
        .update(users)
        .set({ role: 'admin' })
        .where(eq(users.id, existing.id))
        .returning();
      return updated ?? { ...existing, role: 'admin' };
    }
    return existing;
  }

  const [created] = await db
    .insert(users)
    .values({ email, role: isAdmin ? 'admin' : 'user' })
    .onConflictDoNothing({ target: users.email })
    .returning();
  if (created !== undefined) return created;

  const raced = await findUserByEmail(db, email);
  if (raced === null) throw new Error('ensureUserForLogin: user disappeared after conflict');
  return raced;
}

export async function markUserVerified(
  db: DbExecutor,
  id: string,
  isAdmin: boolean,
  now: Date,
): Promise<UserRecord> {
  const [updated] = await db
    .update(users)
    .set({
      emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, ${now})`,
      lastLoginAt: now,
      ...(isAdmin ? { role: 'admin' as const } : {}),
    })
    .where(eq(users.id, id))
    .returning();
  if (updated === undefined) throw new Error('markUserVerified: user not found');
  return updated;
}

export async function updateUserDisplayName(
  db: DbExecutor,
  id: string,
  displayName: string | null,
): Promise<UserRecord> {
  const [updated] = await db.update(users).set({ displayName }).where(eq(users.id, id)).returning();
  if (updated === undefined) throw new Error('updateUserDisplayName: user not found');
  return updated;
}

/** Hard delete; watchlists, tokens, alerts, digest subscriptions and keys cascade. */
export async function deleteUser(db: DbExecutor, id: string): Promise<void> {
  await db.delete(users).where(eq(users.id, id));
}
