import { randomBytes, randomUUID } from 'node:crypto';

import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type Connection, type Db } from '../../src/client.js';
import {
  findOAuthAccount,
  findOAuthAccountForUser,
  linkOAuthAccount,
  touchOAuthAccount,
} from '../../src/repositories/oauth-accounts.repo.js';
import {
  insertAuthToken,
  revokeUnusedMagicLinks,
} from '../../src/repositories/auth-tokens.repo.js';
import { authTokens, oauthAccounts, users } from '../../src/schema/users.js';

/**
 * ADR-0034: OAuth identities are keyed by the provider's immutable account id,
 * a user can link one account per provider, and deleting the user cascades.
 * Claiming an unverified user also revokes outstanding magic links.
 */

const EMAIL_PREFIX = 'int-oauth-';

let connection: Connection;
let db: Db;

beforeAll(() => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is missing — run through `pnpm test:int`');
  connection = createDb(databaseUrl);
  db = connection.db;
});

afterAll(async () => {
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
  await connection.pool.end();
});

async function createUser(label: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: `${EMAIL_PREFIX}${label}-${randomUUID()}@example.test` })
    .returning({ id: users.id });
  if (row === undefined) throw new Error('user insert returned no row');
  return row.id;
}

describe('oauth_accounts repository', () => {
  it('links, reads and updates an identity by provider account id', async () => {
    const userId = await createUser('link');
    const accountId = `gh-${randomUUID()}`;
    const now = new Date('2026-11-11T10:00:00Z');

    const created = await linkOAuthAccount(db, {
      userId,
      provider: 'github',
      providerAccountId: accountId,
      providerEmail: `${EMAIL_PREFIX}link@example.test`,
      lastLoginAt: now,
    });
    expect(created).toMatchObject({ userId, provider: 'github', providerAccountId: accountId });

    await expect(findOAuthAccount(db, 'github', accountId)).resolves.toMatchObject({
      id: created?.id,
      providerEmail: `${EMAIL_PREFIX}link@example.test`,
    });
    await expect(findOAuthAccountForUser(db, userId, 'github')).resolves.toMatchObject({
      id: created?.id,
    });
    await expect(findOAuthAccountForUser(db, userId, 'google')).resolves.toBeNull();

    const later = new Date('2026-11-12T10:00:00Z');
    if (created === null) throw new Error('link missing');
    await touchOAuthAccount(db, created.id, {
      providerEmail: `${EMAIL_PREFIX}changed@example.test`,
      lastLoginAt: later,
    });
    const touched = await findOAuthAccount(db, 'github', accountId);
    expect(touched?.providerEmail).toBe(`${EMAIL_PREFIX}changed@example.test`);
    expect(touched?.lastLoginAt?.toISOString()).toBe(later.toISOString());
  });

  it('rejects a second user for the same provider account', async () => {
    const first = await createUser('first');
    const second = await createUser('second');
    const accountId = `gh-${randomUUID()}`;
    const now = new Date();

    const linked = await linkOAuthAccount(db, {
      userId: first,
      provider: 'github',
      providerAccountId: accountId,
      providerEmail: `${EMAIL_PREFIX}first@example.test`,
      lastLoginAt: now,
    });
    expect(linked).not.toBeNull();

    const duplicate = await linkOAuthAccount(db, {
      userId: second,
      provider: 'github',
      providerAccountId: accountId,
      providerEmail: `${EMAIL_PREFIX}second@example.test`,
      lastLoginAt: now,
    });
    expect(duplicate).toBeNull();
    await expect(findOAuthAccount(db, 'github', accountId)).resolves.toMatchObject({
      userId: first,
    });
  });

  it('allows both providers for one user but not two accounts per provider', async () => {
    const userId = await createUser('both');
    const now = new Date();

    expect(
      await linkOAuthAccount(db, {
        userId,
        provider: 'google',
        providerAccountId: `google-${randomUUID()}`,
        providerEmail: `${EMAIL_PREFIX}both@example.test`,
        lastLoginAt: now,
      }),
    ).not.toBeNull();
    expect(
      await linkOAuthAccount(db, {
        userId,
        provider: 'github',
        providerAccountId: `gh-${randomUUID()}`,
        providerEmail: `${EMAIL_PREFIX}both@example.test`,
        lastLoginAt: now,
      }),
    ).not.toBeNull();
    expect(
      await linkOAuthAccount(db, {
        userId,
        provider: 'google',
        providerAccountId: `google-${randomUUID()}`,
        providerEmail: `${EMAIL_PREFIX}both@example.test`,
        lastLoginAt: now,
      }),
    ).toBeNull();

    const links = await db
      .select({ provider: oauthAccounts.provider })
      .from(oauthAccounts)
      .where(eq(oauthAccounts.userId, userId));
    expect(links.map((link) => link.provider).sort()).toEqual(['github', 'google']);
  });

  it('cascades links when the user is deleted', async () => {
    const userId = await createUser('cascade');
    const accountId = `gh-${randomUUID()}`;
    await linkOAuthAccount(db, {
      userId,
      provider: 'github',
      providerAccountId: accountId,
      providerEmail: `${EMAIL_PREFIX}cascade@example.test`,
      lastLoginAt: new Date(),
    });

    await db.delete(users).where(eq(users.id, userId));
    await expect(findOAuthAccount(db, 'github', accountId)).resolves.toBeNull();
  });
});

describe('magic-link revocation on OAuth claim', () => {
  it('revokes only unused magic links for the claimed user', async () => {
    const userId = await createUser('claim');
    const otherId = await createUser('other');
    const now = new Date('2026-11-11T12:00:00Z');

    const unused = await insertAuthToken(db, {
      userId,
      kind: 'magic_link',
      tokenHash: randomBytes(32),
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const used = await insertAuthToken(db, {
      userId,
      kind: 'magic_link',
      tokenHash: randomBytes(32),
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const refresh = await insertAuthToken(db, {
      userId,
      kind: 'refresh',
      tokenHash: randomBytes(32),
      familyId: randomUUID(),
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const other = await insertAuthToken(db, {
      userId: otherId,
      kind: 'magic_link',
      tokenHash: randomBytes(32),
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await db.update(authTokens).set({ usedAt: now }).where(eq(authTokens.id, used.id));

    await revokeUnusedMagicLinks(db, userId, now);

    const rows = await db
      .select({ id: authTokens.id, revokedAt: authTokens.revokedAt })
      .from(authTokens)
      .where(eq(authTokens.userId, userId));
    const byId = new Map(rows.map((row) => [row.id, row.revokedAt]));
    expect(byId.get(unused.id)?.toISOString()).toBe(now.toISOString());
    expect(byId.get(used.id)).toBeNull();
    expect(byId.get(refresh.id)).toBeNull();

    const [otherRow] = await db
      .select({ revokedAt: authTokens.revokedAt })
      .from(authTokens)
      .where(eq(authTokens.id, other.id));
    expect(otherRow?.revokedAt).toBeNull();
  });
});
