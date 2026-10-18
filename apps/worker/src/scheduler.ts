import { SOURCES, WINDOWS, type Source } from '@trendr/core';
import type { Logger } from '@trendr/logger';

import { defaultJobOpts, type Queues } from './queues.js';

/**
 * Spec §7.2 `score-safety` — the hourly safety net ("40 * * * *", UTC) that
 * scores every source in case an ingestion-triggered run was missed. The row
 * is per source (`compute-scores (per source)`), so each source gets its own
 * scheduler id; `upsertJobScheduler` writes to Redis and is idempotent, so
 * every boot of the scheduler role re-registers without duplicating work.
 */
export const SCORE_SAFETY_PATTERN = '40 * * * *';

export function scoreSafetySchedulerId(source: Source): string {
  return `score-safety-${source}`;
}

export async function registerSchedulers(queues: Queues, logger?: Logger): Promise<string[]> {
  const ids: string[] = [];
  for (const source of SOURCES) {
    const id = scoreSafetySchedulerId(source);
    await queues.scoring.upsertJobScheduler(
      id,
      { pattern: SCORE_SAFETY_PATTERN, tz: 'UTC' },
      {
        name: 'compute-scores',
        data: { source, windows: [...WINDOWS], trigger: 'schedule' },
        opts: defaultJobOpts,
      },
    );
    ids.push(id);
  }
  logger?.info({ ids, pattern: SCORE_SAFETY_PATTERN }, 'score-safety schedulers registered');
  return ids;
}
