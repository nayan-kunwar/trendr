import { z } from 'zod';

import { LeaderboardScopeSchema, WindowSchema } from '@trendr/core';

/** Spec §10.6 — `GET /v1/stream/leaderboard` query. */
export const StreamQuery = z.object({
  scope: LeaderboardScopeSchema.default('all'),
  window: WindowSchema.default('24h'),
});

export type StreamQueryInput = z.infer<typeof StreamQuery>;
