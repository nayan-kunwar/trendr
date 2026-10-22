import { ValidationError, verifyUnsubscribeToken } from '@trendr/core';
import {
  disableUserAlerts,
  getDigestSubscriptionForUser,
  unsubscribeDigest,
  upsertDigestSubscription,
  type Db,
  type DigestSubscriptionRow,
} from '@trendr/db';

import type { DigestBody, DigestSubscriptionBody, UnsubscribeBody } from '../schemas/digest.js';

/** Spec §13.2/§13.4 — digest preferences and one-click unsubscribe. */

export interface DigestServiceDeps {
  db: Db;
  now?: () => Date;
}

export interface UnsubscribeDeps {
  db: Db;
  secret: string;
  now?: () => Date;
}

function toDto(row: DigestSubscriptionRow): DigestSubscriptionBody {
  return {
    sources: row.sources,
    topics: row.topics,
    includeWatchlist: row.includeWatchlist,
    dayOfWeek: row.dayOfWeek,
    enabled: row.enabled,
    unsubscribedAt: row.unsubscribedAt?.toISOString() ?? null,
  };
}

export async function getDigestForCurrentUser(
  deps: DigestServiceDeps,
  userId: string,
): Promise<DigestSubscriptionBody | null> {
  const row = await getDigestSubscriptionForUser(deps.db, userId);
  return row === null ? null : toDto(row);
}

export async function putDigestForCurrentUser(
  deps: DigestServiceDeps,
  userId: string,
  input: DigestBody,
): Promise<DigestSubscriptionBody> {
  const topics = [...new Set(input.topics.map((topic) => topic.trim().toLowerCase()))].filter(
    (topic) => topic.length > 0,
  );
  if (topics.length > 20) throw new ValidationError('at most 20 topics are allowed');
  const sources = [...new Set(input.sources)];
  if (sources.length === 0) throw new ValidationError('at least one source is required');
  const row = await upsertDigestSubscription(deps.db, userId, {
    sources,
    topics,
    includeWatchlist: input.includeWatchlist,
    dayOfWeek: input.dayOfWeek,
    enabled: input.enabled,
  });
  return toDto(row);
}

export function previewUnsubscribe(deps: UnsubscribeDeps, token: string): UnsubscribeBody {
  const verified = verifyUnsubscribeToken(
    token,
    deps.secret,
    (deps.now?.() ?? new Date()).getTime(),
  );
  if (verified === null) {
    throw new ValidationError('invalid or expired unsubscribe token');
  }
  return { ok: true, purpose: verified.purpose };
}

export async function unsubscribe(deps: UnsubscribeDeps, token: string): Promise<UnsubscribeBody> {
  const verified = verifyUnsubscribeToken(
    token,
    deps.secret,
    (deps.now?.() ?? new Date()).getTime(),
  );
  if (verified === null) {
    throw new ValidationError('invalid or expired unsubscribe token');
  }
  const now = deps.now?.() ?? new Date();
  if (verified.purpose === 'digest' || verified.purpose === 'all') {
    await unsubscribeDigest(deps.db, verified.userId, now);
  }
  if (verified.purpose === 'alerts' || verified.purpose === 'all') {
    await disableUserAlerts(deps.db, verified.userId);
  }
  return { ok: true, purpose: verified.purpose };
}
