import { SOURCES, WINDOWS, type IngestJob, type MaintenanceJob, type Source } from '@trendr/core';
import type { Logger } from '@trendr/logger';

import { defaultJobOpts, type Queues } from './queues.js';

/**
 * Spec §7.2 — every schedule is registered with `queue.upsertJobScheduler`
 * (UTC), which is idempotent: each boot of the scheduler role re-registers
 * without duplicating work.
 */

/** Spec §7.2 `score-safety` — the hourly safety net ("40 * * * *", UTC). */
export const SCORE_SAFETY_PATTERN = '40 * * * *';

export function scoreSafetySchedulerId(source: Source): string {
  return `score-safety-${source}`;
}

export interface IngestSchedule {
  /** §7.2 scheduler id (`gh-…`). */
  id: string;
  /** BullMQ job name on the `ingest-github` queue. */
  name: string;
  /** UTC cron pattern (§7.2 table). */
  pattern: string;
  data: IngestJob;
}

/**
 * Spec §7.2 GitHub rows. The discovery cap bounds each scheduled pass to a few
 * search pages; the snapshot rows enqueue `snapshot-fanout` jobs that split
 * each tier into `FANOUT_BATCH_ITEMS` children. There is deliberately no
 * `gh-daily` row: GitHub daily series come from the hourly snapshots (cold
 * items are day-bucketed) plus the `rollup-daily` maintenance job.
 */
export const GITHUB_INGEST_SCHEDULES: readonly IngestSchedule[] = [
  {
    id: 'gh-discover-new',
    name: 'discover',
    pattern: '*/30 * * * *',
    data: {
      type: 'discover',
      source: 'github',
      strategy: 'new-hot',
      maxItems: 500,
      trigger: 'schedule',
    },
  },
  {
    id: 'gh-discover-rising',
    name: 'discover',
    pattern: '10 */2 * * *',
    data: {
      type: 'discover',
      source: 'github',
      strategy: 'rising',
      maxItems: 300,
      trigger: 'schedule',
    },
  },
  {
    id: 'gh-discover-topics',
    name: 'discover',
    pattern: '20 */3 * * *',
    data: {
      type: 'discover',
      source: 'github',
      strategy: 'topics',
      maxItems: 150,
      trigger: 'schedule',
    },
  },
  {
    id: 'gh-snapshot-hot',
    name: 'snapshot-fanout',
    pattern: '5 * * * *',
    data: { type: 'snapshot-fanout', source: 'github', tier: 'hot', trigger: 'schedule' },
  },
  {
    id: 'gh-snapshot-warm',
    name: 'snapshot-fanout',
    pattern: '15 */6 * * *',
    data: { type: 'snapshot-fanout', source: 'github', tier: 'warm', trigger: 'schedule' },
  },
  {
    id: 'gh-snapshot-cold',
    name: 'snapshot-fanout',
    pattern: '30 1 * * *',
    data: { type: 'snapshot-fanout', source: 'github', tier: 'cold', trigger: 'schedule' },
  },
];

export interface MaintenanceSchedule {
  /** §7.2 scheduler id. */
  id: string;
  /** BullMQ job name on the `maintenance` queue. */
  name: string;
  /** UTC cron pattern (§7.2 table). */
  pattern: string;
  data: MaintenanceJob;
}

/** Spec §7.2 maintenance rows implemented so far (retier-items, task 4.5). */
export const MAINTENANCE_SCHEDULES: readonly MaintenanceSchedule[] = [
  {
    id: 'retier-items',
    name: 'retier-items',
    pattern: '0 5 * * *',
    data: { type: 'retier-items' },
  },
];

export async function registerSchedulers(queues: Queues, logger?: Logger): Promise<string[]> {
  const scoreIds: string[] = [];
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
    scoreIds.push(id);
  }
  logger?.info(
    { ids: scoreIds, pattern: SCORE_SAFETY_PATTERN },
    'score-safety schedulers registered',
  );

  const githubIds: string[] = [];
  for (const schedule of GITHUB_INGEST_SCHEDULES) {
    await queues.ingest.github.upsertJobScheduler(
      schedule.id,
      { pattern: schedule.pattern, tz: 'UTC' },
      { name: schedule.name, data: schedule.data, opts: defaultJobOpts },
    );
    githubIds.push(schedule.id);
  }
  logger?.info(
    {
      ids: githubIds,
      schedules: GITHUB_INGEST_SCHEDULES.map((entry) => ({
        id: entry.id,
        pattern: entry.pattern,
      })),
    },
    'github ingest schedulers registered',
  );

  const maintenanceIds: string[] = [];
  for (const schedule of MAINTENANCE_SCHEDULES) {
    await queues.maintenance.upsertJobScheduler(
      schedule.id,
      { pattern: schedule.pattern, tz: 'UTC' },
      { name: schedule.name, data: schedule.data, opts: defaultJobOpts },
    );
    maintenanceIds.push(schedule.id);
  }
  logger?.info({ ids: maintenanceIds }, 'maintenance schedulers registered');

  return [...scoreIds, ...githubIds, ...maintenanceIds];
}
