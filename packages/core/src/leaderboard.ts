import { z } from 'zod';

import {
  ItemKindSchema,
  LeaderboardScopeSchema,
  MetricSchema,
  ScoreFlagSchema,
  SourceSchema,
  WindowSchema,
} from './types.js';

/**
 * Spec §9 — the leaderboard wire contracts: the board cap `LB_MAX_SIZE`
 * (§9.1), the `LeaderboardEntry` row (§5, mirrored by the API DTO in §10.3),
 * the `card:{itemId}:{window}` payload (§9.1: LeaderboardEntry minus rank) and
 * the `events:leaderboard` diff event (§9.2). The task 2.5 acceptance requires
 * the diff payload to be validated by a Zod schema, so the worker parses every
 * event before it is published and tests validate what subscribers receive.
 */

/** Spec §9.1 — each board ZSET holds at most this many members. */
export const LB_MAX_SIZE = 1000;

/** The item half of a leaderboard row (`items` columns the API re-serves). */
export const LeaderboardItemSchema = z.object({
  id: z.string(),
  source: SourceSchema,
  kind: ItemKindSchema,
  externalId: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  url: z.url(),
  language: z.string().nullable(),
  topics: z.array(z.string()),
  primaryMetric: MetricSchema,
});

/** Spec §5 `LeaderboardEntry` — one row on the wire. */
export const LeaderboardEntrySchema = z.object({
  rank: z.number().int().positive(),
  item: LeaderboardItemSchema,
  window: WindowSchema,
  delta: z.number(),
  relGrowth: z.number(),
  /** `final_score` for source boards, `z_score` for the combined board (§9.1). */
  score: z.number(),
  percentile: z.number(),
  /** Current level of the primary metric (or the last complete day's count). */
  current: z.number(),
  /** Up to 30 daily points, oldest first. */
  sparkline: z.array(z.number()).max(30),
  flags: z.array(ScoreFlagSchema),
});

/** Spec §9.1 `card:{itemId}:{window}` — `LeaderboardEntry` minus rank. */
export const LeaderboardCardSchema = LeaderboardEntrySchema.omit({ rank: true });
export type LeaderboardCard = z.infer<typeof LeaderboardCardSchema>;

/** One entry of the §9.2 diff `movers` array. */
export const LeaderboardMoverSchema = z.object({
  itemId: z.string(),
  rank: z.number().int().positive(),
  prevRank: z.number().int().positive(),
  /** Window growth (`scores.delta`) — the §9.2 example carries a growth value, not a rank change. */
  delta: z.number(),
});

/**
 * Spec §9.2 — the diff published on `events:leaderboard` after every board of
 * a run has been swapped. `entered`/`exited` are top-100 membership changes;
 * `movers` is the 20 largest rank changes inside the top 100.
 */
export const LeaderboardUpdatedEventSchema = z.object({
  type: z.literal('leaderboard.updated'),
  scope: LeaderboardScopeSchema,
  window: WindowSchema,
  runId: z.string(),
  computedAt: z.iso.datetime(),
  movers: z.array(LeaderboardMoverSchema).max(20),
  entered: z.array(z.string()),
  exited: z.array(z.string()),
});
export type LeaderboardUpdatedEvent = z.infer<typeof LeaderboardUpdatedEventSchema>;
