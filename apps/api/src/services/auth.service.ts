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

export interface RefreshResult extends AuthSession {
  /** The presented token was already used; its whole family was revoked. */
  reused?: boolean;
}

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
 * Rotate a refresh token. Reuse of an already-used token is treated as theft:
 * every token in its family is revoked, including the newest one.
 */
export async function rotateRefreshToken(
  options: AuthServiceOptions,
  rawToken: string | undefined,
): Promise<RefreshResult | null> {
  if (rawToken === undefined || rawToken.length === 0) return null;
  const now = options.now?.() ?? new Date();
  const tokenHash = hashToken(rawToken);

  return options.db.transaction(async (tx) => {
    const token = await findAuthTokenByHash(tx, tokenHash, { forUpdate: true });
    if (token?.kind !== 'refresh') return null;

    if (token.usedAt !== null) {
      if (token.familyId !== null) {
        await revokeAuthTokenFamily(tx, token.familyId, now);
      }
      return null;
    }
    if (token.revokedAt !== null || token.expiresAt.getTime() <= now.getTime()) {
      return null;
    }
    if (token.familyId === null) return null;

    const user = await findUserById(tx, token.userId);
    if (user === null) return null;

    await markAuthTokenUsed(tx, token.id, now);
    return createRefreshSession(tx, user, now, token.familyId, options.refreshTtlDays);
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
