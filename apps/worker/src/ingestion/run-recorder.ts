import type { Source } from '@trendr/core';
import { finishRun, startRun, type Db, type JobType } from '@trendr/db';

export interface RunRecorderStartInput {
  /** BullMQ job id — with `attempt` this is the run's idempotency key. */
  jobId: string;
  /** 1-based attempt (`job.attemptsMade + 1` while the job is being processed). */
  attempt: number;
  source: Source;
  jobType: JobType;
  params?: Record<string, unknown>;
}

/**
 * Spec §7.1 steps 2 and 6 — owns one `ingestion_runs` row: `start()` opens it,
 * the pipeline mutates the public counters, `finish()` closes it with the
 * final status (`succeeded`, `partial` or `failed`), the counters and the last
 * observed `rate_limit_remaining`.
 */
export class RunRecorder {
  itemsSeen = 0;
  itemsUpserted = 0;
  itemsFailed = 0;
  apiCalls = 0;
  notModified = 0;
  rateLimitRemaining: number | null = null;

  private finished = false;

  private constructor(
    private readonly db: Db,
    readonly runId: bigint,
  ) {}

  static async start(db: Db, input: RunRecorderStartInput): Promise<RunRecorder> {
    const runId = await startRun(db, {
      source: input.source,
      jobType: input.jobType,
      jobId: input.jobId,
      attempt: input.attempt,
      ...(input.params === undefined ? {} : { params: input.params }),
    });
    return new RunRecorder(db, runId);
  }

  /** Close the run; a second call is a no-op (failed attempts and handlers agree). */
  async finish(
    status: 'succeeded' | 'partial' | 'failed' | 'skipped',
    error: string | null = null,
  ): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await finishRun(this.db, this.runId, {
      status,
      itemsSeen: this.itemsSeen,
      itemsUpserted: this.itemsUpserted,
      itemsFailed: this.itemsFailed,
      apiCalls: this.apiCalls,
      notModified: this.notModified,
      rateLimitRemaining: this.rateLimitRemaining,
      error,
    });
  }
}
