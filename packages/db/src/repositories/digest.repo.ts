import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Source } from '@trendr/core';

import type { DbExecutor } from '../client.js';
import { alerts, digestSends, digestSubscriptions } from '../schema/engagement.js';
import { users } from '../schema/users.js';

/** Spec §13.2/§13.4 — subscriptions, per-week send claims and unsubscribe. */

export type DigestSubscriptionRow = typeof digestSubscriptions.$inferSelect;

export async function getDigestSubscriptionForUser(
  db: DbExecutor,
  userId: string,
): Promise<DigestSubscriptionRow | null> {
  const [row] = await db
    .select()
    .from(digestSubscriptions)
    .where(eq(digestSubscriptions.userId, userId));
  return row ?? null;
}

export interface DigestSubscriptionInput {
  sources: Source[];
  topics: string[];
  includeWatchlist: boolean;
  dayOfWeek: number;
  enabled: boolean;
}

export async function upsertDigestSubscription(
  db: DbExecutor,
  userId: string,
  input: DigestSubscriptionInput,
): Promise<DigestSubscriptionRow> {
  const [row] = await db
    .insert(digestSubscriptions)
    .values({
      userId,
      sources: input.sources,
      topics: input.topics,
      includeWatchlist: input.includeWatchlist,
      dayOfWeek: input.dayOfWeek,
      enabled: input.enabled,
      unsubscribedAt: null,
    })
    .onConflictDoUpdate({
      target: digestSubscriptions.userId,
      set: {
        sources: input.sources,
        topics: input.topics,
        includeWatchlist: input.includeWatchlist,
        dayOfWeek: input.dayOfWeek,
        enabled: input.enabled,
        unsubscribedAt: null,
      },
    })
    .returning();
  if (row === undefined) throw new Error('upsertDigestSubscription returned no row');
  return row;
}

export async function listDueDigestSubscriptions(
  db: DbExecutor,
  dayOfWeek: number,
): Promise<DigestSubscriptionRow[]> {
  return db
    .select()
    .from(digestSubscriptions)
    .where(
      and(
        eq(digestSubscriptions.enabled, true),
        isNull(digestSubscriptions.unsubscribedAt),
        eq(digestSubscriptions.dayOfWeek, dayOfWeek),
      ),
    );
}

export interface DigestRecipient {
  subscription: DigestSubscriptionRow;
  email: string;
}

export async function getDigestRecipient(
  db: DbExecutor,
  subscriptionId: string,
): Promise<DigestRecipient | null> {
  const [row] = await db
    .select({ subscription: digestSubscriptions, email: users.email })
    .from(digestSubscriptions)
    .innerJoin(users, eq(users.id, digestSubscriptions.userId))
    .where(eq(digestSubscriptions.id, subscriptionId));
  return row ?? null;
}

export async function unsubscribeDigest(
  db: DbExecutor,
  userId: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(digestSubscriptions)
    .set({ enabled: false, unsubscribedAt: now })
    .where(eq(digestSubscriptions.userId, userId))
    .returning({ id: digestSubscriptions.id });
  return rows.length > 0;
}

export async function disableUserAlerts(db: DbExecutor, userId: string): Promise<number> {
  const rows = await db
    .update(alerts)
    .set({ enabled: false })
    .where(and(eq(alerts.userId, userId), eq(alerts.enabled, true)))
    .returning({ id: alerts.id });
  return rows.length;
}

/** Claim `(subscription_id, week_start)`; null means a send already happened. */
export async function claimDigestSend(
  db: DbExecutor,
  subscriptionId: string,
  weekStart: string,
): Promise<bigint | null> {
  const [row] = await db
    .insert(digestSends)
    .values({ subscriptionId, weekStart, status: 'pending' })
    .onConflictDoNothing({ target: [digestSends.subscriptionId, digestSends.weekStart] })
    .returning({ id: digestSends.id });
  return row?.id ?? null;
}

export async function finishDigestSend(
  db: DbExecutor,
  sendId: bigint,
  status: 'sent' | 'failed' | 'skipped',
  providerMessageId?: string,
  now?: Date,
): Promise<void> {
  await db
    .update(digestSends)
    .set({
      status,
      providerMessageId: providerMessageId ?? null,
      sentAt: status === 'sent' ? (now ?? new Date()) : null,
    })
    .where(eq(digestSends.id, sendId));
}

/** Test/insight helper: rows for a subscription, newest week first. */
export async function listDigestSends(
  db: DbExecutor,
  subscriptionId: string,
): Promise<(typeof digestSends.$inferSelect)[]> {
  return db
    .select()
    .from(digestSends)
    .where(eq(digestSends.subscriptionId, subscriptionId))
    .orderBy(sql`${digestSends.weekStart} DESC`);
}

/** Drop a pending claim so a failed send can be retried by BullMQ. */
export async function releaseDigestSend(db: DbExecutor, sendId: bigint): Promise<void> {
  await db.delete(digestSends).where(eq(digestSends.id, sendId));
}
