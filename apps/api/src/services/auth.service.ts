import { randomUUID } from 'node:crypto';

import type { EmailSender } from '@trendr/email';
import {
  MAGIC_LINK_TTL_MS,
  REFRESH_TOKEN_BYTES,
  hashToken,
  normalizeEmail,
  randomToken,
} from '@trendr/core';
import {
  ensureUserForLogin,
  findAuthTokenByHash,
  findUserById,
  insertAuthToken,
  markAuthTokenUsed,
  markUserVerified,
  revokeAuthTokenFamily,
  setUserRole,
  type Db,
  type UserRecord,
} from '@trendr/db';

import { MAGIC_LINK_EMAIL_SUBJECT, renderMagicLinkEmail } from './magic-link-email.js';

export interface AuthServiceOptions {
  db: Db;
  emailSender: EmailSender;
  webPublicUrl: string;
  adminEmails: readonly string[];
  /** Spec §10.5: 30-day refresh sessions by default. */
  refreshTtlDays?: number;
  now?: () => Date;
}

export interface AuthSession {
  user: UserRecord;
  refreshToken: string;
  refreshExpiresAt: Date;
  familyId: string;
}

/** H-2: how long a just-rotated token is treated as a benign race, not theft. */
export const REFRESH_REUSE_GRACE_MS = 15_000;

/**
 * H-2 typed rotation outcome. `grace` carries no token material: the caller
 * answers a typed 401 and leaves the current cookie alone. Only `reused`
 * (outside the grace window) has revoked the family.
 */
export type RefreshResult =
  | { status: 'rotated'; session: AuthSession }
  | { status: 'grace' }
  | {
      status: 'invalid';
      reason: 'missing' | 'unknown' | 'expired' | 'revoked' | 'reused';
    };

export async function issueMagicLink(
  options: AuthServiceOptions,
  input: { email: string; ip?: string | null; userAgent?: string | null },
): Promise<{ user: UserRecord; url: string }> {
  const now = options.now?.() ?? new Date();
  const email = normalizeEmail(input.email);
  const isAdmin = options.adminEmails.includes(email);
  const user = await ensureUserForLogin(options.db, email, isAdmin);
  const rawToken = randomToken(32);

  await insertAuthToken(options.db, {
    userId: user.id,
    kind: 'magic_link',
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_MS),
    createdIp: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  const url = `${options.webPublicUrl.replace(/\/$/, '')}/auth/verify?token=${encodeURIComponent(rawToken)}`;
  const message = renderMagicLinkEmail(url);
  await options.emailSender.send({
    to: email,
    subject: MAGIC_LINK_EMAIL_SUBJECT,
    html: message.html,
    text: message.text,
  });

  return { user, url };
}

/** Consume a single-use magic link inside one row-locking transaction. */
export async function verifyMagicLink(
  options: AuthServiceOptions,
  rawToken: string,
): Promise<AuthSession | null> {
  const now = options.now?.() ?? new Date();
  const tokenHash = hashToken(rawToken);

  return options.db.transaction(async (tx) => {
    const token = await findAuthTokenByHash(tx, tokenHash, { forUpdate: true });
    if (
      token?.kind !== 'magic_link' ||
      token.usedAt !== null ||
      token.revokedAt !== null ||
      token.expiresAt.getTime() <= now.getTime()
    ) {
      return null;
    }

    const user = await findUserById(tx, token.userId);
    if (user === null) return null;

    await markAuthTokenUsed(tx, token.id, now);
    const verified = await markUserVerified(
      tx,
      user.id,
      options.adminEmails.includes(normalizeEmail(user.email)),
      now,
    );
    return createRefreshSession(tx, verified, now, undefined, options.refreshTtlDays);
  });
}

/**
 * Rotate a refresh token. Reuse outside the 15 s grace window is treated as
 * theft and revokes every token in the family, including the newest one. A
 * replay inside the window is a routine multi-tab race: it returns `grace`
 * without revoking anything (H-2, ADR-0022).
 */
export async function rotateRefreshToken(
  options: AuthServiceOptions,
  rawToken: string | undefined,
): Promise<RefreshResult> {
  if (rawToken === undefined || rawToken.length === 0) {
    return { status: 'invalid', reason: 'missing' };
  }
  const now = options.now?.() ?? new Date();
  const tokenHash = hashToken(rawToken);

  return options.db.transaction(async (tx) => {
    const token = await findAuthTokenByHash(tx, tokenHash, { forUpdate: true });
    if (token?.kind !== 'refresh') return { status: 'invalid', reason: 'unknown' };

    // A family already revoked by logout or an earlier theft must stay dead.
    if (token.revokedAt !== null) return { status: 'invalid', reason: 'revoked' };

    if (token.usedAt !== null) {
      if (now.getTime() - token.usedAt.getTime() <= REFRESH_REUSE_GRACE_MS) {
        return { status: 'grace' };
      }
      if (token.familyId !== null) {
        await revokeAuthTokenFamily(tx, token.familyId, now);
        return { status: 'invalid', reason: 'reused' };
      }
      return { status: 'invalid', reason: 'unknown' };
    }
    if (token.expiresAt.getTime() <= now.getTime()) {
      return { status: 'invalid', reason: 'expired' };
    }
    if (token.familyId === null) return { status: 'invalid', reason: 'unknown' };

    const user = await findUserById(tx, token.userId);
    if (user === null) return { status: 'invalid', reason: 'unknown' };

    const role = options.adminEmails.includes(normalizeEmail(user.email)) ? 'admin' : 'user';
    const refreshedUser = user.role === role ? user : await setUserRole(tx, user.id, role);

    await markAuthTokenUsed(tx, token.id, now);
    const session = await createRefreshSession(
      tx,
      refreshedUser,
      now,
      token.familyId,
      options.refreshTtlDays,
    );
    return { status: 'rotated', session };
  });
}

export async function revokeRefreshSession(
  db: Db,
  rawToken: string | undefined,
  now = new Date(),
): Promise<void> {
  if (rawToken === undefined || rawToken.length === 0) return;
  const token = await findAuthTokenByHash(db, hashToken(rawToken));
  if (token?.familyId !== null && token?.familyId !== undefined) {
    await revokeAuthTokenFamily(db, token.familyId, now);
  }
}

/**
 * Start a new refresh-token family for an already-authenticated identity
 * (OAuth callback, ADR-0034). Magic-link verification uses the private
 * transaction-aware variant below.
 */
export async function createSessionForUser(
  db: Db,
  user: UserRecord,
  now: Date,
  ttlDays = 30,
): Promise<AuthSession> {
  return createRefreshSession(db, user, now, undefined, ttlDays);
}

async function createRefreshSession(
  db: Parameters<typeof insertAuthToken>[0],
  user: UserRecord,
  now: Date,
  familyId: string = randomUUID(),
  ttlDays = 30,
): Promise<AuthSession> {
  const refreshToken = randomToken(REFRESH_TOKEN_BYTES);
  const refreshExpiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  await insertAuthToken(db, {
    userId: user.id,
    kind: 'refresh',
    tokenHash: hashToken(refreshToken),
    familyId,
    expiresAt: refreshExpiresAt,
  });
  return { user, refreshToken, refreshExpiresAt, familyId };
}
