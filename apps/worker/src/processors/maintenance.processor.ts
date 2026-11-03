import { UnrecoverableError, Worker, type WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';

import { MaintenanceJobSchema, QUEUE, type MaintenanceJob } from '@trendr/core';
import {
  countSnapshotsDefault,
  deleteExpiredAuthTokens,
  dropOldPartitions,
  ensurePartitions,
  partitionLeadDays,
  pruneAlertEvents,
  pruneDailyMetrics,
  pruneIngestionRuns,
  pruneScores,
  rollupDailyMetrics,
  type Db,
} from '@trendr/db';
import type { Logger } from '@trendr/logger';

import { attachDeadLetter } from '../dlq.js';
import { runRetierItems, type HotMaxBySource, type RetierSummary } from '../ingestion/tiering.js';
import { partitionLeadDaysGauge, snapshotsDefaultRows } from '../metrics.js';
import { workerSettings, type Queues } from '../queues.js';

/**
 * Spec §7.10 — the `maintenance` queue processor. Every job is idempotent and
 * safe to run manually: partition creation is `IF NOT EXISTS`, rollups upsert,
 * score pruning keeps the current pointer, and token cleanup is a cutoff
 * delete. The scheduler in `scheduler.ts` owns the production cadence.
 */

/** Spec §6.5 — `daily_metrics` horizon (L-10). */
export const DAILY_METRICS_RETENTION_DAYS = 400;

export interface MaintenanceRetentionOptions {
  snapshotMonths: number;
  scoresHourlyHours: number;
  scoresDailyDays: number;
}

export interface MaintenanceMetrics {
  setSnapshotsDefaultRows(rows: number): void;
  /** M-11: days of monthly partitions provisioned ahead of today. */
  setPartitionLeadDays(days: number): void;
}

export interface MaintenanceProcessorOptions {
  db: Db;
  /** BullMQ connection (`maxRetriesPerRequest: null`), shared with the producers. */
  connection: Redis;
  /** When present, finally-failed jobs are parked per §7.7. */
  deadLetter?: Queues['deadLetter'];
  logger?: Logger;
  /** `TRACKED_HOT_MAX_*` (spec §7.8); omitted ⇒ no cap. */
  hotMaxBySource?: HotMaxBySource;
  /** Clock override (tests). */
  now?: () => Date;
  retention?: MaintenanceRetentionOptions;
  metrics?: MaintenanceMetrics;
  concurrency?: number;
  settings?: NonNullable<WorkerOptions['settings']>;
}

export interface MaintenanceResult {
  type: MaintenanceJob['type'];
  /** Present for `retier-items`. */
  retier?: RetierSummary;
  /** Present for `create-partitions`. */
  defaultRows?: number;
  /** Present for `create-partitions` (M-11). */
  leadDays?: number;
  /** Present for `rollup-daily`. */
  day?: string;
  rolledUpRows?: number;
  /** Present for `retention`. */
  droppedPartitions?: number;
  deletedDailyMetrics?: number;
  deletedScores?: number;
  deletedAlertEvents?: number;
  deletedIngestionRuns?: number;
  /** Present for `cleanup-tokens`. */
  deletedTokens?: number;
}

const DEFAULT_RETENTION: MaintenanceRetentionOptions = {
  snapshotMonths: 3,
  scoresHourlyHours: 48,
  scoresDailyDays: 365,
};

export function createMaintenanceWorker(
  options: MaintenanceProcessorOptions,
): Worker<MaintenanceJob, MaintenanceResult> {
  const worker = new Worker<MaintenanceJob, MaintenanceResult>(
    QUEUE.maintenance,
    async (job) => {
      const parsed = MaintenanceJobSchema.safeParse(job.data);
      if (!parsed.success) {
        const problems = parsed.error.issues
          .map((issue) => issue.path.join('.') || issue.message)
          .join(', ');
        throw new UnrecoverableError(`invalid maintenance job payload: ${problems}`);
      }
      return runMaintenanceJob(options, parsed.data);
    },
    {
      connection: options.connection,
      concurrency: options.concurrency ?? 1,
      settings: options.settings ?? workerSettings,
    },
  );

  worker.on('error', (error: Error) => {
    options.logger?.error({ err: error, queue: QUEUE.maintenance }, 'maintenance worker error');
  });
  if (options.deadLetter !== undefined) {
    attachDeadLetter(worker, options.deadLetter, options.logger);
  }
  return worker;
}

/** Pure-ish dispatch for the worker and the manual maintenance CLI. */
export async function runMaintenanceJob(
  options: MaintenanceProcessorOptions,
  data: MaintenanceJob,
): Promise<MaintenanceResult> {
  const now = options.now?.() ?? new Date();
  switch (data.type) {
    case 'create-partitions': {
      // M-11: a twelve-month lead absorbs an outage longer than a quarter; the
      // guard inside `ensurePartitions` refuses to run DDL when
      // `snapshots_default` already holds rows in the window.
      await ensurePartitions(options.db, 0, 12);
      const defaultRows = await countSnapshotsDefault(options.db);
      const leadDays = await partitionLeadDays(options.db);
      const metrics = options.metrics ?? {
        setSnapshotsDefaultRows: (rows: number) => {
          snapshotsDefaultRows.set(rows);
        },
        setPartitionLeadDays: (days: number) => {
          partitionLeadDaysGauge.set(days);
        },
      };
      metrics.setSnapshotsDefaultRows(defaultRows);
      metrics.setPartitionLeadDays(leadDays);
      if (defaultRows > 0) {
        options.logger?.error(
          { defaultRows, leadDays },
          'snapshots_default is not empty — partition creation will be blocked for overlapping months',
        );
      } else {
        options.logger?.info({ defaultRows, leadDays }, 'snapshot partitions ensured');
      }
      return { type: data.type, defaultRows, leadDays };
    }
    case 'rollup-daily': {
      const day = previousUtcDay(now);
      const rolledUpRows = await rollupDailyMetrics(options.db, day);
      options.logger?.info({ day, rolledUpRows }, 'daily metrics rolled up');
      return { type: data.type, day, rolledUpRows };
    }
    case 'retention': {
      const retention = options.retention ?? DEFAULT_RETENTION;
      const droppedPartitions = await dropOldPartitions(options.db, retention.snapshotMonths);
      const deletedScores = await pruneScores(
        options.db,
        retention.scoresHourlyHours,
        retention.scoresDailyDays,
      );
      // Order matters: alert events reference score runs, so remove the
      // 180-day-old events before the 30-day run sweep can see those runs.
      const deletedDailyMetrics = await pruneDailyMetrics(
        options.db,
        new Date(now.getTime() - DAILY_METRICS_RETENTION_DAYS * 86_400_000),
      );
      const deletedAlertEvents = await pruneAlertEvents(
        options.db,
        new Date(now.getTime() - 180 * 86_400_000),
      );
      const deletedIngestionRuns = await pruneIngestionRuns(
        options.db,
        new Date(now.getTime() - 30 * 86_400_000),
      );
      options.logger?.info(
        {
          droppedPartitions,
          deletedScores,
          deletedDailyMetrics,
          deletedAlertEvents,
          deletedIngestionRuns,
        },
        'retention pass finished',
      );
      return {
        type: data.type,
        droppedPartitions,
        deletedScores,
        deletedDailyMetrics,
        deletedAlertEvents,
        deletedIngestionRuns,
      };
    }
    case 'cleanup-tokens': {
      const deletedTokens = await deleteExpiredAuthTokens(
        options.db,
        new Date(now.getTime() - 7 * 86_400_000),
      );
      options.logger?.info({ deletedTokens }, 'expired auth tokens cleaned up');
      return { type: data.type, deletedTokens };
    }
    case 'retier-items': {
      const retier = await runRetierItems({
        db: options.db,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        ...(options.hotMaxBySource === undefined ? {} : { hotMaxBySource: options.hotMaxBySource }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      return { type: data.type, retier };
    }
  }
}

/** Previous UTC calendar day as `YYYY-MM-DD`, the rollup input (§7.10). */
export function previousUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
    .toISOString()
    .slice(0, 10);
}
