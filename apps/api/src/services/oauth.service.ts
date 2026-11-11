import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import {
  NotFoundError,
  UnavailableError,
  createOAuthState,
  createPkcePair,
  normalizeEmail,
  randomToken,
  sanitizeReturnTo,
  type OAuthProvider,
} from '@trendr/core';
import {
  findOAuthAccount,
  findOAuthAccountForUser,
  findUserByEmail,
  findUserById,
  linkOAuthAccount,
  revokeUnusedMagicLinks,
  touchOAuthAccount,
  users,
  type Db,
  type DbExecutor,
  type UserRecord,
} from '@trendr/db';

import { createSessionForUser, type AuthSession } from './auth.service.js';
import { OAuthFlowError } from './oauth/errors.js';
import type { OAuthIdentity, OAuthProviderMap } from './oauth/providers.js';
import { consumeOAuthState, storeOAuthState, type OAuthStatePayload } from './oauth/state.js';

/**
 * OAuth login service (ADR-0034). The route layer owns cookies and redirects;
 * this module owns state creation, provider identity normalization and the
 * account-linking decision matrix.
 */

export interface OAuthServiceOptions {
  db: Db;
  redis?: Redis;
  providers: OAuthProviderMap;
  adminEmails: readonly string[];
  refreshTtlDays?: number;
  now?: () => Date;
}

export interface OAuthAuthorization {
  state: string;
  authorizationUrl: string;
}

export async function beginOAuth(
  options: OAuthServiceOptions,
  provider: OAuthProvider,
  returnTo: unknown,
): Promise<OAuthAuthorization> {
  const client = options.providers[provider];
  if (client === undefined) {
    throw new NotFoundError('OAuth provider is not configured');
  }
  if (options.redis === undefined) {
    throw new UnavailableError('OAuth state store is unavailable');
  }

  const now = options.now?.() ?? new Date();
  const state = createOAuthState();
  const pkce = createPkcePair();
  const nonce = provider === 'google' ? randomToken(32) : null;

  await storeOAuthState(options.redis, state, {
    provider,
    codeVerifier: pkce.verifier,
    nonce,
    returnTo: sanitizeReturnTo(returnTo),
    createdAt: now.getTime(),
  });

  return {
    state,
    authorizationUrl: client.authorizationUrl({
      state,
      codeChallenge: pkce.challenge,
      nonce,
    }),
  };
}

/** Single-use: `GETDEL` in Redis, then verify the payload belongs to the path provider. */
export async function consumeOAuthAuthorization(
  options: OAuthServiceOptions,
  provider: OAuthProvider,
  state: string,
): Promise<OAuthStatePayload | null> {
  if (options.redis === undefined) {
    throw new UnavailableError('OAuth state store is unavailable');
  }
  const payload = await consumeOAuthState(options.redis, state);
  return payload !== null && payload.provider === provider ? payload : null;
}

export interface CompleteOAuthInput {
  code: string;
  codeVerifier: string;
  nonce: string | null;
}

export async function completeOAuthLogin(
  options: OAuthServiceOptions,
  provider: OAuthProvider,
  input: CompleteOAuthInput,
): Promise<AuthSession> {
  const client = options.providers[provider];
  if (client === undefined) {
    throw new OAuthFlowError('oauth_failed', 'OAuth provider is not configured');
  }

  const identity = await client.fetchIdentity({
    code: input.code,
    codeVerifier: input.codeVerifier,
    nonce: input.nonce,
  });
  if (!identity.emailVerified) {
    throw new OAuthFlowError('email_unverified', 'OAuth provider did not prove email ownership');
  }

  const now = options.now?.() ?? new Date();
  const user = await options.db.transaction((tx) =>
    resolveOAuthUser(tx, {
      provider,
      identity,
      adminEmails: options.adminEmails,
      now,
    }),
  );
  return createSessionForUser(options.db, user, now, options.refreshTtlDays);
}

interface ResolveInput {
  provider: OAuthProvider;
  identity: OAuthIdentity;
  adminEmails: readonly string[];
  now: Date;
}

async function resolveOAuthUser(tx: DbExecutor, input: ResolveInput): Promise<UserRecord> {
  const { provider, identity, now } = input;

  // 1. The provider account is the stable key. A changed provider email must
  //    not move the login to another Trendr account.
  const existingAccount = await findOAuthAccount(tx, provider, identity.providerAccountId);
  if (existingAccount !== null) {
    const user = await findUserById(tx, existingAccount.userId);
    if (user === null) {
      throw new OAuthFlowError('oauth_failed', 'OAuth account points at a missing user');
    }
    await touchOAuthAccount(tx, existingAccount.id, {
      providerEmail: identity.email,
      lastLoginAt: now,
    });
    return finalizeUser(tx, user, input);
  }

  // 2. No provider link yet: match the verified provider email to an existing
  //    Trendr account. Auto-linking is safe because the provider proved it.
  let user = await findUserByEmail(tx, identity.email);
  if (user !== null) {
    await rejectOtherAccountForProvider(tx, user.id, provider);
  } else {
    const [created] = await tx
      .insert(users)
      .values({
        email: identity.email,
        displayName: identity.displayName,
        role: input.adminEmails.includes(normalizeEmail(identity.email)) ? 'admin' : 'user',
        emailVerifiedAt: now,
        lastLoginAt: now,
      })
      .onConflictDoNothing({ target: users.email })
      .returning();

    if (created !== undefined) {
      user = created;
    } else {
      // A concurrent request created the row between our SELECT and INSERT.
      user = await findUserByEmail(tx, identity.email);
      if (user === null) {
        throw new OAuthFlowError('oauth_failed', 'user disappeared after an insert conflict');
      }
      await rejectOtherAccountForProvider(tx, user.id, provider);
    }
  }

  // `created` is a verified account; an existing row may be a placeholder
  // created by a magic-link request that was never completed.
  const claimedPlaceholder = user.emailVerifiedAt === null;

  const link = await linkOAuthAccount(tx, {
    userId: user.id,
    provider,
    providerAccountId: identity.providerAccountId,
    providerEmail: identity.email,
    lastLoginAt: now,
  });
  if (link === null) {
    // A concurrent callback won the unique (provider, account id) race.
    const raced = await findOAuthAccount(tx, provider, identity.providerAccountId);
    if (raced?.userId !== user.id) {
      throw new OAuthFlowError('account_conflict', 'OAuth account is already linked');
    }
  }

  if (claimedPlaceholder) {
    // The magic link may have been requested by someone who does not own the
    // inbox. Provider proof supersedes it; stale links must stop working.
    await revokeUnusedMagicLinks(tx, user.id, now);
  }

  return finalizeUser(tx, user, input);
}

async function rejectOtherAccountForProvider(
  tx: DbExecutor,
  userId: string,
  provider: OAuthProvider,
): Promise<void> {
  const sameProvider = await findOAuthAccountForUser(tx, userId, provider);
  if (sameProvider !== null) {
    throw new OAuthFlowError(
      'account_conflict',
      'This provider is already linked to a different account',
    );
  }
}

async function finalizeUser(
  tx: DbExecutor,
  user: UserRecord,
  input: ResolveInput,
): Promise<UserRecord> {
  const isAdmin = input.adminEmails.includes(normalizeEmail(user.email));
  const [updated] = await tx
    .update(users)
    .set({
      emailVerifiedAt: user.emailVerifiedAt ?? input.now,
      lastLoginAt: input.now,
      role: isAdmin ? 'admin' : 'user',
      ...(user.displayName === null && input.identity.displayName !== null
        ? { displayName: input.identity.displayName }
        : {}),
    })
    .where(eq(users.id, user.id))
    .returning();
  if (updated === undefined) {
    throw new OAuthFlowError('oauth_failed', 'user update returned no row');
  }
  return updated;
}
