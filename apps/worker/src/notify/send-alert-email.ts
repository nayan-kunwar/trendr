import { eq, inArray } from 'drizzle-orm';

import { UNSUBSCRIBE_TTL_MS, signUnsubscribeToken, type AlertType } from '@trendr/core';
import { alertEvents, alerts, items, users, type Db } from '@trendr/db';
import type { EmailSender } from '@trendr/email';
import type { Logger } from '@trendr/logger';

import { renderAlertEmail, type AlertEmailEvent } from './templates/alert.js';

/**
 * Spec §13.1 step 5/§13.3 — deliver one alert event, or a single combined
 * email for a user whose run produced more than five events. `alert_events`
 * rows only move from pending to sent after the provider accepts the message,
 * so a retry still sees a pending event (provider idempotency keys are passed
 * where available).
 */

export interface AlertEmailDeps {
  db: Db;
  sender: EmailSender;
  webPublicUrl: string;
  apiPublicUrl: string;
  unsubscribeSecret: string;
  unsubscribeMailto?: string;
  now?: () => Date;
  logger?: Logger;
}

export interface AlertEmailResult {
  sent: number;
  skipped: number;
}

const METRIC_LABEL: Record<string, string> = {
  stars: 'stars',
  forks: 'forks',
  watchers: 'watchers',
  open_issues: 'open issues',
  downloads: 'downloads',
  downloads_total: 'downloads',
  likes: 'likes',
  upvotes: 'upvotes',
  trending_score: 'trending score',
  comments: 'comments',
};

function itemName(payload: Record<string, unknown>): { name: string; url: string } {
  const item = payload.item;
  if (typeof item === 'object' && item !== null) {
    const record = item as Record<string, unknown>;
    const name = typeof record.displayName === 'string' ? record.displayName : 'Tracked item';
    const url = typeof record.url === 'string' ? record.url : '';
    return { name, url };
  }
  return { name: 'Tracked item', url: '' };
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function describeEvent(
  type: AlertType,
  payload: Record<string, unknown>,
): {
  summary: string;
  detail: string;
} {
  const item = payload.item as Record<string, unknown> | undefined;
  const metric = typeof item?.primaryMetric === 'string' ? item.primaryMetric : 'stars';
  const window = typeof payload.window === 'string' ? payload.window : '24h';

  switch (type) {
    case 'velocity_spike': {
      const delta = numberValue(payload.delta);
      const percentile = numberValue(payload.percentile);
      const average = numberValue(payload.trailingAvgDelta);
      return {
        summary: `+${formatNumber(delta)} ${METRIC_LABEL[metric] ?? metric} in ${window}`,
        detail: `${percentile.toFixed(1)}th percentile · ${formatNumber(delta)} vs a ${formatNumber(
          Math.round(average),
        )} four-day average`,
      };
    }
    case 'rank_entered': {
      const rank = numberValue(payload.rank);
      const previous = payload.previousRank;
      const scope = typeof payload.scope === 'string' ? payload.scope : 'all';
      const language = typeof payload.lang === 'string' ? ` · ${payload.lang}` : '';
      return {
        summary: `Entered the ${scope} top ${formatNumber(rank)} (${window}${language})`,
        detail:
          typeof previous === 'number'
            ? `Previous rank: ${formatNumber(previous)}`
            : 'Previously unranked on this board',
      };
    }
    case 'threshold_crossed': {
      const crossedMetric = typeof payload.metric === 'string' ? payload.metric : metric;
      const value = numberValue(payload.value);
      const previous = numberValue(payload.previousValue);
      const current = numberValue(payload.currentValue);
      return {
        summary: `${METRIC_LABEL[crossedMetric] ?? crossedMetric} crossed ${formatNumber(value)}`,
        detail: `${formatNumber(previous)} → ${formatNumber(current)} (${window})`,
      };
    }
    case 'new_alias': {
      const aliases = Array.isArray(payload.aliases) ? payload.aliases : [];
      const names = aliases.slice(0, 3).map((alias) => {
        if (typeof alias !== 'object' || alias === null) return 'alias';
        const name = (alias as Record<string, unknown>).name;
        return typeof name === 'string' ? name : 'alias';
      });
      return {
        summary:
          names.length === 0
            ? 'A new alias was linked'
            : `New alias${names.length > 1 ? 'es' : ''}: ${names.join(', ')}`,
        detail: `${aliases.length} new alias${aliases.length === 1 ? '' : 'es'} discovered`,
      };
    }
  }
}

export async function sendAlertEmails(
  deps: AlertEmailDeps,
  eventIds: readonly string[],
): Promise<AlertEmailResult> {
  if (eventIds.length === 0) return { sent: 0, skipped: 0 };
  const ids = eventIds.map((id) => {
    try {
      return BigInt(id);
    } catch {
      throw new Error(`invalid alert event id: ${id}`);
    }
  });

  const rows = await deps.db
    .select({
      event: alertEvents,
      alertType: alerts.type,
      userId: alerts.userId,
      email: users.email,
      itemDisplayName: items.displayName,
      itemUrl: items.url,
    })
    .from(alertEvents)
    .innerJoin(alerts, eqAlert())
    .innerJoin(users, eqUser())
    .innerJoin(items, eqItem())
    .where(inArray(alertEvents.id, ids));

  const pending = rows.filter((row) => row.event.deliveryStatus === 'pending');
  if (pending.length === 0) return { sent: 0, skipped: eventIds.length };

  const now = deps.now?.() ?? new Date();
  const byUser = new Map<
    string,
    {
      email: string;
      userId: string;
      events: { row: (typeof pending)[number]; html: AlertEmailEvent }[];
    }
  >();
  for (const row of pending) {
    let group = byUser.get(row.userId);
    if (group === undefined) {
      group = { email: row.email, userId: row.userId, events: [] };
      byUser.set(row.userId, group);
    }
    const payload = row.event.payload;
    const item = itemName(payload);
    const described = describeEvent(row.alertType, payload);
    group.events.push({
      row,
      html: {
        type: row.alertType,
        itemName: item.name || row.itemDisplayName,
        itemUrl: item.url || row.itemUrl,
        summary: described.summary,
        detail: described.detail,
      },
    });
  }

  const expiresAt = now.getTime() + UNSUBSCRIBE_TTL_MS;
  let sent = 0;
  for (const group of byUser.values()) {
    const token = signUnsubscribeToken({
      userId: group.userId,
      purpose: 'alerts',
      expiresAt,
      secret: deps.unsubscribeSecret,
    });
    const apiUnsubscribe = `${deps.apiPublicUrl.replace(/\/$/, '')}/v1/unsubscribe?token=${encodeURIComponent(token)}`;
    const webUnsubscribe = `${deps.webPublicUrl.replace(/\/$/, '')}/unsubscribe?token=${encodeURIComponent(token)}`;
    const preferencesUrl = `${deps.webPublicUrl.replace(/\/$/, '')}/dashboard`;
    const dashboardUrl = `${deps.webPublicUrl.replace(/\/$/, '')}/dashboard`;
    const mailto = deps.unsubscribeMailto ?? 'unsubscribe@trendr.example';

    const rendered = await renderAlertEmail({
      events: group.events.map((event) => event.html),
      dashboardUrl,
      preferencesUrl,
      unsubscribeUrl: webUnsubscribe,
    });
    const subject =
      group.events.length === 1
        ? `Trendr alert: ${group.events[0]?.html.itemName ?? 'tracked item'}`
        : `Trendr: ${group.events.length} alerts for you`;

    try {
      await deps.sender.send({
        to: group.email,
        subject,
        html: rendered.html,
        text: rendered.text,
        headers: {
          'List-Unsubscribe': `<${apiUnsubscribe}>, <mailto:${mailto}?subject=unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        tags: { kind: 'alert' },
        idempotencyKey: group.events
          .map((event) => event.row.event.id.toString())
          .sort()
          .join('-'),
      });
      const eventIdsForGroup = group.events.map((event) => event.row.event.id);
      await deps.db
        .update(alertEvents)
        .set({ deliveryStatus: 'sent', deliveredAt: now })
        .where(inArray(alertEvents.id, eventIdsForGroup));
      sent += eventIdsForGroup.length;
    } catch (error) {
      deps.logger?.error({ err: error }, 'alert email delivery failed');
      throw error;
    }
  }

  return { sent, skipped: eventIds.length - pending.length };
}

// Drizzle column references kept local so the join order stays readable.

function eqAlert() {
  return eq(alerts.id, alertEvents.alertId);
}

function eqUser() {
  return eq(users.id, alerts.userId);
}

function eqItem() {
  return eq(items.id, alertEvents.itemId);
}
