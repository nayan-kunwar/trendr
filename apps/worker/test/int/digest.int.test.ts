import { randomUUID } from 'node:crypto';

import { eq, like, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDb,
  digestSends,
  digestSubscriptions,
  ingestionRuns,
  insertScores,
  items,
  scores,
  startRun,
  swapCurrentRun,
  upsertItems,
  users,
  watchlistItems,
  watchlists,
  type Connection,
  type ItemUpsert,
} from '@trendr/db';
import { SmtpEmailSender } from '@trendr/email';

import { buildWeeklyDigest } from '../../src/notify/build-weekly-digest.js';
import { buildDigestContent } from '../../src/notify/build-digest.js';
import { sendDigest } from '../../src/notify/send-digest.js';

/**
 * Task 7.4 acceptance over real Postgres + Redis + Mailpit: the daily build
 * computes/warm-caches content and fans out to due subscriptions; the digest
 * email arrives once and a repeated send for the same week is a no-op.
 */

const PREFIX = `int-digest-${randomUUID().slice(0, 8)}`;
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const REDIS_URL = process.env.REDIS_URL ?? '';
const SMTP_URL = process.env.SMTP_URL ?? '';
const MAILPIT_URL = process.env.MAILPIT_URL ?? '';
const UNSUBSCRIBE_SECRET = randomUUID();
const NOW = new Date('2026-10-21T08:00:00Z'); // Wednesday
const WEEK = '2026-10-19';

let connection: Connection;
let redis: Redis;

beforeAll(async () => {
  if (SMTP_URL === '' || MAILPIT_URL === '') {
    throw new Error('digest integration tests require the Mailpit fixture');
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
  await connection.db.execute(sql`
    DELETE FROM score_runs_current
    WHERE run_id IN (SELECT id FROM ingestion_runs WHERE job_id LIKE ${`${PREFIX}%`})`);
  await connection.db.delete(ingestionRuns).where(like(ingestionRuns.jobId, `${PREFIX}%`));
  await redis.del(`digest:content:2026-10-21`);
}

function fixture(
  source: 'github' | 'arxiv' | 'mcp',
  index: number,
  latestMetrics: Record<string, number> = {},
): ItemUpsert {
  const externalId = `${PREFIX}-${source}-${index}`;
  return {
    source,
    kind: source === 'arxiv' ? 'paper' : source === 'mcp' ? 'mcp_server' : 'repo',
    externalId,
    upstreamId: null,
    name: externalId,
    displayName: `${source} digest fixture ${index}`,
    description: `Fixture ${index}`,
    url: `https://example.test/${externalId}`,
    homepage: null,
    language: 'TypeScript',
    license: null,
    owner: PREFIX,
    primaryMetric: source === 'arxiv' ? 'upvotes' : 'stars',
    upstreamCreatedAt: new Date('2024-01-01T00:00:00Z'),
    isArchived: false,
    metadata: {},
    latestMetrics,
  };
}

function scoreRow(
  itemId: bigint,
  source: 'github' | 'arxiv',
  runId: bigint,
  rankAll: number,
): Parameters<typeof insertScores>[1][number] {
  return {
    itemId,
    window: '7d',
    runId,
    source,
    computedAt: NOW,
    delta: source === 'github' ? 900 : 30,
    base: 10_000,
    relGrowth: source === 'github' ? 0.09 : 0.03,
    rawScore: source === 'github' ? 900 : 30,
    ageFactor: 1,
    confidence: 1,
    anomalyPenalty: 0,
    finalScore: source === 'github' ? 900 : 30,
    zScore: source === 'github' ? 2.4 : 1.1,
    percentile: source === 'github' ? 98 : 80,
    rankSource: 1,
    rankAll,
  };
}

async function latestMessageTo(
  email: string,
): Promise<Record<string, unknown> & { Subject: string; HTML: string; Text: string }> {
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
      return (await detail.json()) as Record<string, unknown> & {
        Subject: string;
        HTML: string;
        Text: string;
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`no Mailpit message arrived for ${email}`);
}

describe('weekly digest (task 7.4)', () => {
  it('builds/caches content, sends once per week with List-Unsubscribe, and skips retries', async () => {
    const email = `${PREFIX}@example.test`;
    const [user] = await connection.db
      .insert(users)
      .values({ email, emailVerifiedAt: new Date() })
      .returning();
    if (user === undefined) throw new Error('user seed failed');

    const [github, arxiv, mcp] = await upsertItems(connection.db, [
      fixture('github', 1),
      fixture('arxiv', 1, { upvotes: 321 }),
      fixture('mcp', 1),
    ]);
    if (github === undefined || arxiv === undefined || mcp === undefined) {
      throw new Error('item seed failed');
    }
    // The full integration suite runs files concurrently; buildDigestContent must
    // not include MCP rows first seen after its digest timestamp.
    await connection.db.update(items).set({ firstSeenAt: NOW }).where(eq(items.id, mcp.id));

    const githubRun = await startRun(connection.db, {
      source: 'github',
      jobType: 'score',
      jobId: `${PREFIX}-score-github`,
    });
    await insertScores(connection.db, [scoreRow(github.id, 'github', githubRun, 1)]);
    await swapCurrentRun(connection.db, {
      source: 'github',
      window: '7d',
      runId: githubRun,
      computedAt: NOW,
    });
    const arxivRun = await startRun(connection.db, {
      source: 'arxiv',
      jobType: 'score',
      jobId: `${PREFIX}-score-arxiv`,
    });
    await insertScores(connection.db, [scoreRow(arxiv.id, 'arxiv', arxivRun, 2)]);
    await swapCurrentRun(connection.db, {
      source: 'arxiv',
      window: '7d',
      runId: arxivRun,
      computedAt: NOW,
    });

    const [watchlist] = await connection.db
      .insert(watchlists)
      .values({ userId: user.id, name: 'Digest list', isDefault: true })
      .returning();
    if (watchlist === undefined) throw new Error('watchlist seed failed');
    await connection.db
      .insert(watchlistItems)
      .values({ watchlistId: watchlist.id, itemId: github.id });

    const [subscription] = await connection.db
      .insert(digestSubscriptions)
      .values({
        userId: user.id,
        sources: ['github', 'mcp', 'arxiv'],
        topics: [],
        includeWatchlist: true,
        dayOfWeek: 3,
        enabled: true,
      })
      .returning();
    if (subscription === undefined) throw new Error('subscription seed failed');

    const content = await buildDigestContent(connection.db, redis, NOW, true);
    expect(content.sources.github?.[0]?.displayName).toBe('github digest fixture 1');
    expect(content.sources.arxiv?.[0]?.displayName).toBe('arxiv digest fixture 1');
    expect(content.mcpNew.map((item) => item.displayName)).toContain('mcp digest fixture 1');
    expect(content.papers[0]?.displayName).toBe('arxiv digest fixture 1');
    expect(content.all.length).toBeGreaterThan(0);

    const jobs: { subscriptionId: string; weekStart: string }[] = [];
    const build = await buildWeeklyDigest(
      {
        db: connection.db,
        redis,
        digestQueue: {
          add: (_name, data) => {
            jobs.push(data);
            return Promise.resolve({});
          },
        },
        now: () => NOW,
      },
      {},
    );
    expect(build).toMatchObject({ weekStart: WEEK, due: 1, enqueued: 1 });
    expect(jobs[0]?.subscriptionId).toBe(subscription.id);

    const sender = new SmtpEmailSender('Trendr <digest@localhost>', SMTP_URL);
    const deps = {
      db: connection.db,
      redis,
      sender,
      webPublicUrl: 'http://localhost:3000',
      apiPublicUrl: 'http://localhost:4000',
      unsubscribeSecret: UNSUBSCRIBE_SECRET,
      now: () => NOW,
    };
    const first = await sendDigest(deps, {
      subscriptionId: subscription.id,
      weekStart: WEEK,
    });
    expect(first.status).toBe('sent');
    expect(first.itemCount).toBeGreaterThan(0);

    const message = await latestMessageTo(email);
    expect(message.Subject).toContain('Trendr weekly digest');
    expect(message.HTML).toContain('github digest fixture 1');
    expect(message.HTML).toContain('Your watchlist this week');
    expect(message.Text).toContain('github digest fixture 1');
    expect(JSON.stringify(message)).toMatch(/List-Unsubscribe/i);

    const second = await sendDigest(deps, {
      subscriptionId: subscription.id,
      weekStart: WEEK,
    });
    expect(second).toMatchObject({ status: 'skipped', sendId: null });

    const sends = await connection.db
      .select()
      .from(digestSends)
      .where(eq(digestSends.subscriptionId, subscription.id));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.status).toBe('sent');
    expect(sends[0]?.providerMessageId).toBeTruthy();

    const scoreCount = await connection.db
      .select({ id: scores.itemId })
      .from(scores)
      .where(eq(scores.runId, githubRun));
    expect(scoreCount).toHaveLength(1);
  });
});
