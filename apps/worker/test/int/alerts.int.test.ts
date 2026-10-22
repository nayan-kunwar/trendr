import { randomUUID } from 'node:crypto';

import { eq, like } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  alerts,
  alertEvents,
  createDb,
  ingestionRuns,
  insertScores,
  items,
  startRun,
  upsertItems,
  users,
  type Connection,
  type ItemUpsert,
} from '@trendr/db';
import { SmtpEmailSender } from '@trendr/email';

import { evaluateAlerts } from '../../src/notify/evaluate-alerts.js';
import { sendAlertEmails } from '../../src/notify/send-alert-email.js';

/**
 * Task 7.3 acceptance over real Postgres + Redis + Mailpit: a seeded velocity
 * spike fires exactly one `alert_events` row even when evaluation is retried,
 * and the rendered alert email arrives in Mailpit.
 */

const PREFIX = `int-alerts-${randomUUID().slice(0, 8)}`;
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const REDIS_URL = process.env.REDIS_URL ?? '';
const SMTP_URL = process.env.SMTP_URL ?? '';
const MAILPIT_URL = process.env.MAILPIT_URL ?? '';
const UNSUBSCRIBE_SECRET = 'int-alert-unsubscribe-secret-0123456789abcdef';

let connection: Connection;
let redis: Redis;

beforeAll(async () => {
  if (SMTP_URL === '' || MAILPIT_URL === '') {
    throw new Error('alert integration tests require the Mailpit fixture');
  }
  connection = createDb(DATABASE_URL, { max: 4 });
  redis = new Redis(REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await connection.pool.end();
  redis.disconnect();
});

async function cleanup(): Promise<void> {
  await connection.db.delete(users).where(like(users.email, `${PREFIX}%`));
  await connection.db.delete(items).where(like(items.owner, PREFIX));
  await connection.db.delete(ingestionRuns).where(like(ingestionRuns.jobId, `${PREFIX}%`));
}

function itemFixture(): ItemUpsert {
  return {
    source: 'github',
    kind: 'repo',
    externalId: `${PREFIX}-repo`,
    upstreamId: null,
    name: `${PREFIX}-repo`,
    displayName: 'Spiking Repository',
    description: 'Fixture for alert evaluation',
    url: 'https://example.test/spiking-repository',
    homepage: null,
    language: 'TypeScript',
    license: null,
    owner: PREFIX,
    primaryMetric: 'stars',
    upstreamCreatedAt: new Date('2024-01-01T00:00:00Z'),
    isArchived: false,
    metadata: {},
  };
}

function scoreRow(
  itemId: bigint,
  runId: bigint,
  computedAt: Date,
  delta: number,
  percentile: number,
): {
  itemId: bigint;
  window: '24h';
  runId: bigint;
  source: 'github';
  computedAt: Date;
  delta: number;
  base: number;
  relGrowth: number;
  rawScore: number;
  ageFactor: number;
  confidence: number;
  anomalyPenalty: number;
  finalScore: number;
  zScore: number;
  percentile: number;
  rankSource: number;
  rankAll: number | null;
  flags: never[];
} {
  return {
    itemId,
    window: '24h',
    runId,
    source: 'github',
    computedAt,
    delta,
    base: 10_000,
    relGrowth: delta / 10_000,
    rawScore: delta,
    ageFactor: 1,
    confidence: 1,
    anomalyPenalty: 0,
    finalScore: delta,
    zScore: percentile / 10,
    percentile,
    rankSource: 1,
    rankAll: 1,
    flags: [],
  };
}

async function latestMessageTo(
  email: string,
): Promise<{ Subject: string; HTML: string; Text: string }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=50`);
    const body = (await response.json()) as {
      messages?: { ID: string; To?: { Address?: string }[] }[];
    };
    const match = body.messages?.find((message) =>
      message.To?.some((recipient) => recipient.Address?.toLowerCase() === email),
    );
    if (match !== undefined) {
      const detail = await fetch(`${MAILPIT_URL}/api/v1/message/${match.ID}`);
      return (await detail.json()) as { Subject: string; HTML: string; Text: string };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`no Mailpit message arrived for ${email}`);
}

describe('alert evaluation and email (task 7.3)', () => {
  it('fires one deduplicated event on retry and delivers the email', async () => {
    const email = `${PREFIX}@example.test`;
    const [user] = await connection.db
      .insert(users)
      .values({ email, emailVerifiedAt: new Date() })
      .returning();
    const [item] = await upsertItems(connection.db, [itemFixture()]);
    if (user === undefined || item === undefined) throw new Error('seed failed');

    const now = new Date();
    const previousRun = await startRun(connection.db, {
      source: 'github',
      jobType: 'score',
      jobId: `${PREFIX}-score-previous`,
    });
    const previousAt = new Date(now.getTime() - 86_400_000);
    await insertScores(connection.db, [scoreRow(item.id, previousRun, previousAt, 10, 50)]);

    const currentRun = await startRun(connection.db, {
      source: 'github',
      jobType: 'score',
      jobId: `${PREFIX}-score-current`,
    });
    await insertScores(connection.db, [scoreRow(item.id, currentRun, now, 5_000, 99)]);

    const [alert] = await connection.db
      .insert(alerts)
      .values({
        userId: user.id,
        type: 'velocity_spike',
        itemId: item.id,
        watchlistId: null,
        window: '24h',
        params: { minPercentile: 90, minDeltaMultiple: 2 },
        cooldownHours: 24,
        enabled: true,
      })
      .returning();
    if (alert === undefined) throw new Error('alert seed failed');

    const jobs: { type: string; alertEventId: string; alertEventIds?: string[] }[] = [];
    const notifyQueue = {
      add: (
        _name: string,
        data: { type: string; alertEventId: string; alertEventIds?: string[] },
      ) => {
        jobs.push(data);
        return Promise.resolve({});
      },
    };

    const first = await evaluateAlerts(
      { db: connection.db, redis, notifyQueue },
      { scoreRunId: currentRun.toString(), source: 'github' },
    );
    expect(first.inserted).toBe(1);
    expect(first.emailJobs).toBe(1);
    expect(jobs).toHaveLength(1);

    const events = await connection.db
      .select()
      .from(alertEvents)
      .where(eq(alertEvents.alertId, alert.id));
    expect(events).toHaveLength(1);
    expect(events[0]?.dedupeKey).toContain(`${alert.id}:${item.id.toString()}:24h:`);

    // Simulate the small race where a retry starts before `last_triggered_at`
    // is visible: the unique dedupe_key is the real guard.
    await connection.db
      .update(alerts)
      .set({ lastTriggeredAt: null })
      .where(eq(alerts.id, alert.id));
    const retry = await evaluateAlerts(
      { db: connection.db, redis, notifyQueue },
      { scoreRunId: currentRun.toString(), source: 'github' },
    );
    expect(retry.inserted).toBe(0);
    expect(
      await connection.db.select().from(alertEvents).where(eq(alertEvents.alertId, alert.id)),
    ).toHaveLength(1);

    const sender = new SmtpEmailSender('Trendr <digest@localhost>', SMTP_URL);
    const delivered = await sendAlertEmails(
      {
        db: connection.db,
        sender,
        webPublicUrl: 'http://localhost:3000',
        apiPublicUrl: 'http://localhost:4000',
        unsubscribeSecret: UNSUBSCRIBE_SECRET,
      },
      jobs.map((job) => job.alertEventId),
    );
    expect(delivered.sent).toBe(1);

    const message = await latestMessageTo(email);
    expect(message.Subject).toContain('Trendr alert');
    expect(message.HTML).toContain('Spiking Repository');
    expect(message.Text).toContain('Spiking Repository');

    const [sentEvent] = await connection.db
      .select()
      .from(alertEvents)
      .where(eq(alertEvents.alertId, alert.id));
    expect(sentEvent?.deliveryStatus).toBe('sent');
    expect(sentEvent?.deliveredAt).not.toBeNull();
  });
});
