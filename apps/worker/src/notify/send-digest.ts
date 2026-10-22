import { and, eq, inArray, sql } from 'drizzle-orm';

import { UNSUBSCRIBE_TTL_MS, signUnsubscribeToken, type Source } from '@trendr/core';
import {
  claimDigestSend,
  finishDigestSend,
  getDigestRecipient,
  loadCardItems,
  releaseDigestSend,
  scoreRunsCurrent,
  scores,
  watchlistItems,
  watchlists,
  type Db,
} from '@trendr/db';
import type { EmailSender } from '@trendr/email';
import type { Logger } from '@trendr/logger';

import { buildDigestContent, type DigestContent, type DigestItem } from './build-digest.js';
import {
  renderDigestEmail,
  type DigestEmailItem,
  type DigestEmailSection,
} from './templates/digest.js';

/**
 * Spec §13.2 — send one personalized weekly digest. `(subscription_id,
 * week_start)` is claimed before rendering so two workers cannot send the same
 * week twice; a provider failure releases the claim for BullMQ to retry.
 */

export interface DigestEmailDeps {
  db: Db;
  redis: import('ioredis').Redis;
  sender: EmailSender;
  webPublicUrl: string;
  apiPublicUrl: string;
  unsubscribeSecret: string;
  unsubscribeMailto?: string;
  now?: () => Date;
  logger?: Logger;
}

export interface DigestSendResult {
  status: 'sent' | 'skipped';
  sendId: string | null;
  itemCount: number;
}

const SOURCE_LABEL: Record<Source, string> = {
  github: 'GitHub',
  npm: 'npm',
  pypi: 'PyPI',
  huggingface: 'Hugging Face',
  arxiv: 'arXiv',
  mcp: 'MCP / agent tools',
};

export function weekStartUtc(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay(); // 0 = Sunday
  const offset = weekday === 0 ? 6 : weekday - 1;
  day.setUTCDate(day.getUTCDate() - offset);
  return day.toISOString().slice(0, 10);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: Math.abs(value) >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value);
}

function detail(item: DigestItem): string {
  const delta = item.delta === 0 ? 'new this week' : `+${formatNumber(item.delta)} in 7d`;
  return `${delta} · #${item.rank} in ${SOURCE_LABEL[item.source]}`;
}

function toEmailItem(item: DigestItem): DigestEmailItem {
  return { name: item.displayName, url: item.url, detail: detail(item) };
}

function topicMatches(item: DigestItem, topics: readonly string[]): boolean {
  if (topics.length === 0) return true;
  return item.topics.some((topic) => topics.includes(topic));
}

function filterItems(items: readonly DigestItem[], topics: readonly string[]): DigestItem[] {
  return items.filter((item) => topicMatches(item, topics));
}

interface WatchlistRow {
  itemId: bigint;
  delta: number;
  relGrowth: number;
  percentile: number;
  rank: number | null;
  computedAt: Date;
}

async function watchlistItemsForUser(
  db: Db,
  userId: string,
  topics: readonly string[],
): Promise<DigestItem[]> {
  const ids = await db
    .selectDistinct({ itemId: watchlistItems.itemId })
    .from(watchlists)
    .innerJoin(watchlistItems, eq(watchlistItems.watchlistId, watchlists.id))
    .where(eq(watchlists.userId, userId));
  if (ids.length === 0) return [];
  const itemIds = ids.map((row) => row.itemId);
  const cards = await loadCardItems(db, itemIds);
  const current: WatchlistRow[] = await db
    .select({
      itemId: scores.itemId,
      delta: scores.delta,
      relGrowth: scores.relGrowth,
      percentile: scores.percentile,
      rank: scores.rankSource,
      computedAt: scores.computedAt,
    })
    .from(scores)
    .innerJoin(
      scoreRunsCurrent,
      and(
        eq(scoreRunsCurrent.source, scores.source),
        eq(scoreRunsCurrent.window, scores.window),
        eq(scoreRunsCurrent.runId, scores.runId),
      ),
    )
    .where(and(eq(scores.window, '7d'), inArray(scores.itemId, itemIds)));

  if (current.length === 0) return [];
  const computedAt = current.reduce(
    (latest, row) => (row.computedAt > latest ? row.computedAt : latest),
    current[0]?.computedAt ?? new Date(0),
  );
  const computationStart = computedAt;
  const previousRanks = await db.execute<{ itemId: string; rank: number }>(sql`
      SELECT item_id::text AS "itemId", rank
      FROM (
        SELECT s.item_id, s.rank_source AS rank,
               row_number() OVER (PARTITION BY s.item_id ORDER BY s.computed_at DESC) AS rn
        FROM scores s
        WHERE s.window = '7d'
          AND s.item_id IN (${sql.join(
            itemIds.map((id) => sql`${id}`),
            sql`, `,
          )})
          AND s.computed_at < ${computationStart}
      ) x
      WHERE x.rn = 1`);
  const previous = new Map<bigint, number>();
  for (const row of previousRanks.rows) {
    previous.set(BigInt(row.itemId), row.rank);
  }

  const result: DigestItem[] = [];
  for (const row of current) {
    const card = cards.get(row.itemId);
    if (card === undefined) continue;
    if (
      !topicMatches(
        {
          id: card.id.toString(),
          source: card.source,
          displayName: card.displayName,
          description: card.description,
          url: card.url,
          language: card.language,
          topics: card.topics,
          delta: row.delta,
          relGrowth: row.relGrowth,
          percentile: row.percentile,
          rank: row.rank ?? 0,
          previousRank: null,
        },
        topics,
      )
    ) {
      continue;
    }
    result.push({
      id: card.id.toString(),
      source: card.source,
      displayName: card.displayName,
      description: card.description,
      url: card.url,
      language: card.language,
      topics: card.topics,
      delta: row.delta,
      relGrowth: row.relGrowth,
      percentile: row.percentile,
      rank: row.rank ?? 0,
      previousRank: previous.get(row.itemId) ?? null,
    });
  }
  result.sort((a, b) => a.rank - b.rank);
  return result;
}

function sectionsFor(
  content: DigestContent,
  sources: readonly Source[],
  topics: readonly string[],
): DigestEmailSection[] {
  const sections: DigestEmailSection[] = [];
  const all = filterItems(content.all, topics);
  if (all.length > 0) {
    sections.push({ title: 'Trending across all sources', items: all.map(toEmailItem) });
  }
  for (const source of sources) {
    const items = filterItems(content.sources[source] ?? [], topics);
    if (items.length > 0) {
      sections.push({ title: `Top ${SOURCE_LABEL[source]}`, items: items.map(toEmailItem) });
    }
  }
  if (sources.includes('mcp')) {
    const mcp = filterItems(content.mcpNew, topics);
    if (mcp.length > 0) {
      sections.push({ title: 'New MCP servers', items: mcp.map(toEmailItem) });
    }
  }
  if (sources.includes('arxiv')) {
    const papers = filterItems(content.papers, topics);
    if (papers.length > 0) {
      sections.push({ title: 'Top arXiv papers by upvotes', items: papers.map(toEmailItem) });
    }
  }
  return sections;
}

export async function sendDigest(
  deps: DigestEmailDeps,
  input: { subscriptionId: string; weekStart?: string },
): Promise<DigestSendResult> {
  const recipient = await getDigestRecipient(deps.db, input.subscriptionId);
  if (recipient === null) return { status: 'skipped', sendId: null, itemCount: 0 };
  const { subscription, email } = recipient;
  if (!subscription.enabled || subscription.unsubscribedAt !== null) {
    return { status: 'skipped', sendId: null, itemCount: 0 };
  }

  const now = deps.now?.() ?? new Date();
  const weekStart = input.weekStart ?? weekStartUtc(now);
  const sendId = await claimDigestSend(deps.db, subscription.id, weekStart);
  if (sendId === null) return { status: 'skipped', sendId: null, itemCount: 0 };

  try {
    const content = await buildDigestContent(deps.db, deps.redis, now);
    const sections = sectionsFor(content, subscription.sources, subscription.topics);
    const watchlist = subscription.includeWatchlist
      ? (await watchlistItemsForUser(deps.db, subscription.userId, subscription.topics)).map(
          toEmailItem,
        )
      : [];
    const itemCount =
      sections.reduce((total, section) => total + section.items.length, 0) + watchlist.length;
    if (itemCount === 0) {
      await finishDigestSend(deps.db, sendId, 'skipped', undefined, now);
      return { status: 'skipped', sendId: sendId.toString(), itemCount: 0 };
    }

    const token = signUnsubscribeToken({
      userId: subscription.userId,
      purpose: 'digest',
      expiresAt: now.getTime() + UNSUBSCRIBE_TTL_MS,
      secret: deps.unsubscribeSecret,
    });
    const web = deps.webPublicUrl.replace(/\/$/, '');
    const api = deps.apiPublicUrl.replace(/\/$/, '');
    const apiUnsubscribe = `${api}/v1/unsubscribe?token=${encodeURIComponent(token)}`;
    const unsubscribeUrl = `${web}/unsubscribe?token=${encodeURIComponent(token)}`;
    const preferencesUrl = `${web}/settings`;
    const dashboardUrl = `${web}/dashboard`;
    const mailto = deps.unsubscribeMailto ?? 'unsubscribe@trendr.example';
    const weekLabel = `Week of ${new Date(`${weekStart}T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    })}`;

    const rendered = await renderDigestEmail({
      weekLabel,
      sections,
      watchlist,
      dashboardUrl,
      preferencesUrl,
      unsubscribeUrl,
    });
    const result = await deps.sender.send({
      to: email,
      subject: `Trendr weekly digest · ${weekLabel}`,
      html: rendered.html,
      text: rendered.text,
      headers: {
        'List-Unsubscribe': `<${apiUnsubscribe}>, <mailto:${mailto}?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      tags: { kind: 'digest' },
      idempotencyKey: `digest-${subscription.id}-${weekStart}`,
    });
    await finishDigestSend(deps.db, sendId, 'sent', result.id, now);
    return { status: 'sent', sendId: sendId.toString(), itemCount };
  } catch (error) {
    deps.logger?.error({ err: error, subscriptionId: subscription.id }, 'digest send failed');
    await releaseDigestSend(deps.db, sendId);
    throw error;
  }
}
