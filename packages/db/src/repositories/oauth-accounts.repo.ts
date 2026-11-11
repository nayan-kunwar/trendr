import { and, eq } from 'drizzle-orm';

import type { DbExecutor } from '../client.js';
import { oauthAccounts } from '../schema/users.js';

export type OAuthAccountRecord = typeof oauthAccounts.$inferSelect;
export type OAuthProvider = OAuthAccountRecord['provider'];

export async function findOAuthAccount(
  db: DbExecutor,
  provider: OAuthProvider,
  providerAccountId: string,
): Promise<OAuthAccountRecord | null> {
  const rows = await db
    .select()
    .from(oauthAccounts)
    .where(
      and(
        eq(oauthAccounts.provider, provider),
        eq(oauthAccounts.providerAccountId, providerAccountId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findOAuthAccountForUser(
  db: DbExecutor,
  userId: string,
  provider: OAuthProvider,
): Promise<OAuthAccountRecord | null> {
  const rows = await db
    .select()
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider)))
    .limit(1);
  return rows[0] ?? null;
}

export interface LinkOAuthAccountInput {
  userId: string;
  provider: OAuthProvider;
  providerAccountId: string;
  providerEmail: string;
  lastLoginAt: Date;
}

/**
 * Insert the link if it is still free. A concurrent callback may win the
 * unique `(provider, provider_account_id)` race; the caller re-reads the
 * account and decides whether it belongs to the same user.
 */
export async function linkOAuthAccount(
  db: DbExecutor,
  input: LinkOAuthAccountInput,
): Promise<OAuthAccountRecord | null> {
  const [row] = await db
    .insert(oauthAccounts)
    .values({
      userId: input.userId,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
      providerEmail: input.providerEmail,
      lastLoginAt: input.lastLoginAt,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export async function touchOAuthAccount(
  db: DbExecutor,
  id: string,
  input: { providerEmail: string; lastLoginAt: Date },
): Promise<void> {
  await db
    .update(oauthAccounts)
    .set({ providerEmail: input.providerEmail, lastLoginAt: input.lastLoginAt })
    .where(eq(oauthAccounts.id, id));
}
