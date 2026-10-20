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
  /** BullMQ job name on the source's `ingest-{source}` queue. */
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

/**
 * Spec §7.2 npm rows. `npm-daily-retry` is a second scheduler id for the same
 * daily job: BullMQ stores one cron per scheduler id, and the 06:00 retry is
 * the documented gap-filler for a `partial` 02:30 run (§7.3.2).
 */
export const NPM_INGEST_SCHEDULES: readonly IngestSchedule[] = [
  {
    id: 'npm-discover',
    name: 'discover',
    pattern: '0 */6 * * *',
    data: {
      type: 'discover',
      source: 'npm',
      strategy: 'keywords',
      maxItems: 1000,
      trigger: 'schedule',
    },
  },
  {
    id: 'npm-daily',
    name: 'daily',
    pattern: '30 2 * * *',
    data: { type: 'daily', source: 'npm', trigger: 'schedule' },
  },
  {
    id: 'npm-daily-retry',
    name: 'daily',
    pattern: '0 6 * * *',
    data: { type: 'daily', source: 'npm', trigger: 'schedule' },
  },
];

/**
 * Spec §7.2 PyPI rows. The 30-minute RSS pass is cheap; admission brings the
 * pypistats call down to once per project per day. The 11:00 retry repairs a
 * `partial` 05:00 daily run after pypistats publishes.
 */
export const PYPI_INGEST_SCHEDULES: readonly IngestSchedule[] = [
  {
    id: 'pypi-discover',
    name: 'discover',
    pattern: '*/30 * * * *',
    data: {
      type: 'discover',
      source: 'pypi',
      strategy: 'rss',
      maxItems: 1000,
      trigger: 'schedule',
    },
  },
  {
    id: 'pypi-daily',
    name: 'daily',
    pattern: '0 5 * * *',
    data: { type: 'daily', source: 'pypi', trigger: 'schedule' },
  },
  {
    id: 'pypi-daily-retry',
    name: 'daily',
    pattern: '0 11 * * *',
    data: { type: 'daily', source: 'pypi', trigger: 'schedule' },
  },
];

/** Every implemented ingest row, by source (spec §7.2). */
export const INGEST_SCHEDULES: Readonly<Record<Source, readonly IngestSchedule[]>> = {
  github: GITHUB_INGEST_SCHEDULES,
  npm: NPM_INGEST_SCHEDULES,
  pypi: PYPI_INGEST_SCHEDULES,
  huggingface: [],
  arxiv: [],
  mcp: [],
};

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

  const ingestIds: string[] = [];
  for (const source of SOURCES) {
    for (const schedule of INGEST_SCHEDULES[source]) {
      await queues.ingest[source].upsertJobScheduler(
        schedule.id,
        { pattern: schedule.pattern, tz: 'UTC' },
        { name: schedule.name, data: schedule.data, opts: defaultJobOpts },
      );
      ingestIds.push(schedule.id);
    }
  }
  logger?.info(
    {
      ids: ingestIds,
      schedules: SOURCES.flatMap((source) =>
        INGEST_SCHEDULES[source].map((entry) => ({
          source,
          id: entry.id,
          pattern: entry.pattern,
        })),
      ),
    },
    'ingest schedulers registered',
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

  return [...scoreIds, ...ingestIds, ...maintenanceIds];
}
