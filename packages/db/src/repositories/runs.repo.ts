import { eq, sql } from 'drizzle-orm';

import type { Source } from '@trendr/core';

import type { DbExecutor } from '../client.js';
import { jobTypeEnum, runStatusEnum } from '../schema/enums.js';
import { ingestionRuns } from '../schema/ops.js';

export type JobType = (typeof jobTypeEnum.enumValues)[number];
export type RunStatus = (typeof runStatusEnum.enumValues)[number];

export interface StartRunInput {
  /** null for cross-source jobs (digest, maintenance). */
  source: Source | null;
  jobType: JobType;
  /** BullMQ job id — the idempotency key together with `attempt`. */
  jobId: string;
  /** 1-based BullMQ attempt; a retry inserts a new row. */
  attempt?: number;
  params?: Record<string, unknown>;
}

/**
 * Open (or re-open) the `ingestion_runs` row for a job attempt and return its
 * id. Re-running the same `(job_id, attempt)` resets the row to `running`.
 */
export async function startRun(db: DbExecutor, input: StartRunInput): Promise<bigint> {
  const [row] = await db
    .insert(ingestionRuns)
    .values({
      source: input.source,
      jobType: input.jobType,
      jobId: input.jobId,
      attempt: input.attempt ?? 1,
      params: input.params ?? {},
    })
    .onConflictDoUpdate({
      target: [ingestionRuns.jobId, ingestionRuns.attempt],
      set: { status: 'running', startedAt: sql`now()`, finishedAt: null, error: null },
    })
    .returning({ id: ingestionRuns.id });

  if (row === undefined) throw new Error('startRun: insert returned no row');
  return row.id;
}

export interface FinishRunPatch {
  status: Exclude<RunStatus, 'queued' | 'running'>;
  itemsSeen?: number;
  itemsUpserted?: number;
  itemsFailed?: number;
  apiCalls?: number;
  notModified?: number;
  rateLimitRemaining?: number | null;
  error?: string | null;
}

/** Close a run with its final status and counters. */
export async function finishRun(
  db: DbExecutor,
  runId: bigint,
  patch: FinishRunPatch,
): Promise<void> {
  await db
    .update(ingestionRuns)
    .set({ ...patch, finishedAt: sql`now()` })
    .where(eq(ingestionRuns.id, runId));
}

export type RunRow = typeof ingestionRuns.$inferSelect;

export async function getRun(db: DbExecutor, runId: bigint): Promise<RunRow | null> {
  const [row] = await db.select().from(ingestionRuns).where(eq(ingestionRuns.id, runId));
  return row ?? null;
}
