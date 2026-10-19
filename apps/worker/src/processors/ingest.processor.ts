import { UnrecoverableError, Worker, type Job, type Queue, type WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';

import {
  IngestJobSchema,
  QUEUE,
  UpstreamError,
  type IngestJob,
  type ScoringJob,
  type Source,
  type Tier,
} from '@trendr/core';
import { getItemById, listTrackedItems, type Db, type TrackedItemRef } from '@trendr/db';
import type { Logger } from '@trendr/logger';
import {
  AdapterNotRegisteredError,
  createBucket,
  getAdapter,
  SOURCE_PRIMARY_BUCKET,
  type AdapterContext,
  type DiscoveredRef,
  type NormalizedItem,
  type SourceAdapter,
} from '@trendr/sources';

import { attachDeadLetter } from '../dlq.js';
import { RunRecorder } from '../ingestion/run-recorder.js';
import { persistDailySeries, persistNormalizedItems } from '../ingestion/upsert.js';
import { enqueueScoringRun, workerSettings, type Queues, type ScoringResult } from '../queues.js';

type DiscoverJob = Extract<IngestJob, { type: 'discover' }>;
type SnapshotJob = Extract<IngestJob, { type: 'snapshot' }>;
type DailyJob = Extract<IngestJob, { type: 'daily' }>;
type BackfillJob = Extract<IngestJob, { type: 'backfill' }>;
type RefreshItemJob = Extract<IngestJob, { type: 'refresh-item' }>;

export interface IngestDeps {
  db: Db;
  redis: Redis;
  logger: Logger;
  /** Where ingest-triggered scoring runs land (spec §7.1 step 7); omit to skip. */
  scoringQueue?: Queue<ScoringJob, ScoringResult>;
  /** `HF_RATE_PER_5MIN` for the `huggingface:api` bucket (spec §7.4). */
  hfRatePer5Min?: number;
  /** Clock override for tests. */
  now?: () => Date;
}

export interface IngestResult {
  type: IngestJob['type'];
  source: Source;
  status: 'succeeded' | 'partial';
  itemsSeen: number;
  itemsUpserted: number;
  itemsFailed: number;
}

export interface IngestWorkerOptions {
  deps: IngestDeps;
  /** BullMQ connection (`maxRetriesPerRequest: null`), shared with the producers. */
  connection: Redis;
  concurrency?: number;
  /** Overrides the §7.5 worker backoff (tests use a tiny delay). */
  settings?: NonNullable<WorkerOptions['settings']>;
  /** When present, finally-failed jobs are parked per §7.7. */
  deadLetter?: Queues['deadLetter'];
}

/**
 * Spec §7.1 — the ingest pipeline: validate the payload, open an
 * `ingestion_runs` row, resolve the adapter and dispatch by job type. The
 * processor never swallows systemic errors: single-item problems are counted,
 * more than 50% failures or any thrown error retries the job (non-retryable
 * failures become `UnrecoverableError` → straight to the dead-letter queue).
 */
export async function processIngestJob(
  deps: IngestDeps,
  job: Job<unknown>,
  signal?: AbortSignal,
): Promise<IngestResult> {
  const parsed = IngestJobSchema.safeParse(job.data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new UnrecoverableError(`invalid ingest job payload: ${issues}`);
  }
  const data = parsed.data;
  const now = deps.now ?? (() => new Date());
  const recorder = await RunRecorder.start(deps.db, {
    jobId: job.id ?? `${data.source}.${data.type}`,
    attempt: job.attemptsMade + 1,
    source: data.source,
    jobType: data.type,
    params: data,
  });

  try {
    const adapter = getAdapter(data.source);
    const context: AdapterContext = {
      logger: deps.logger.child({
        source: data.source,
        jobId: job.id,
        runId: recorder.runId.toString(),
      }),
      bucket: createBucket(deps.redis, SOURCE_PRIMARY_BUCKET[data.source], {
        ...(deps.hfRatePer5Min === undefined ? {} : { hfRatePer5Min: deps.hfRatePer5Min }),
      }),
      signal: signal ?? new AbortController().signal,
      now,
      runId: recorder.runId,
    };
    await runJob({ deps, data, adapter, context, recorder });
  } catch (error) {
    await failRun(recorder, error);
    throw asJobError(error);
  }

  const status = recorder.itemsFailed === 0 ? 'succeeded' : 'partial';
  await recorder.finish(status);
  deps.logger.info(
    {
      source: data.source,
      type: data.type,
      runId: recorder.runId.toString(),
      status,
      seen: recorder.itemsSeen,
      upserted: recorder.itemsUpserted,
      failed: recorder.itemsFailed,
    },
    'ingest run finished',
  );
  return {
    type: data.type,
    source: data.source,
    status,
    itemsSeen: recorder.itemsSeen,
    itemsUpserted: recorder.itemsUpserted,
    itemsFailed: recorder.itemsFailed,
  };
}

/**
 * Spec §3.3/§7.1 — the per-source `ingest-*` queue worker. Ingest workers are
 * serialized per queue (concurrency 1 by default) because each job mutates
 * whole batches; jobs abort their AdapterContext signal on shutdown.
 */
export function createIngestWorker(
  source: Source,
  options: IngestWorkerOptions,
): Worker<IngestJob, IngestResult> {
  const queueName = QUEUE.ingest[source];
  const controllers = new Set<AbortController>();

  const worker = new Worker<IngestJob, IngestResult>(
    queueName,
    async (job) => {
      const controller = new AbortController();
      controllers.add(controller);
      try {
        return await processIngestJob(options.deps, job, controller.signal);
      } finally {
        controllers.delete(controller);
      }
    },
    {
      connection: options.connection,
      concurrency: options.concurrency ?? 1,
      settings: options.settings ?? workerSettings,
    },
  );

  worker.on('error', (error) => {
    options.deps.logger.error({ err: error, queue: queueName }, 'ingest worker error');
  });
  worker.on('closing', () => {
    for (const controller of controllers) {
      controller.abort();
    }
  });

  if (options.deadLetter !== undefined) {
    attachDeadLetter(worker, options.deadLetter, options.deps.logger);
  }
  return worker;
}

interface JobRunInput {
  deps: IngestDeps;
  data: IngestJob;
  adapter: SourceAdapter;
  context: AdapterContext;
  recorder: RunRecorder;
}

async function runJob(input: JobRunInput): Promise<void> {
  const { data } = input;
  switch (data.type) {
    case 'discover':
      await runDiscover(input, data);
      return;
    case 'snapshot':
      await runSnapshot(input, data);
      return;
    case 'daily':
      await runDaily(input, data);
      return;
    case 'backfill':
      await runBackfill(input, data);
      return;
    case 'refresh-item':
      await runRefreshItem(input, data);
      return;
  }
}

/**
 * Spec §7.1 step 4 (`discover`) — iterate the adapter's pages, normalize the
 * refs that already carry a payload and upsert them (`warm` for new items).
 * The minimal-row upsert for payload-less refs and the `backfill` fan-out
 * land with the real adapters (see docs/SPEC_REVIEW.md).
 */
async function runDiscover(input: JobRunInput, data: DiscoverJob): Promise<void> {
  const { deps, adapter, context, recorder } = input;
  const pages = adapter.discover(context, { maxItems: data.maxItems, strategy: data.strategy });

  for await (const page of pages) {
    context.signal.throwIfAborted();
    recorder.apiCalls += 1;
    recorder.itemsSeen += page.length;

    const toPersist: NormalizedItem[] = [];
    for (const ref of page) {
      if (ref.raw === undefined) {
        continue; // counted for now; needs the per-source stub defaults (4.3+)
      }
      const normalized = adapter.normalize({ ref, raw: ref.raw, fetchedAt: context.now() });
      if (normalized === null) {
        recorder.itemsFailed += 1;
        context.logger.warn({ externalId: ref.externalId }, 'adapter could not normalize item');
        continue;
      }
      toPersist.push(normalized);
    }

    if (toPersist.length > 0) {
      recorder.itemsUpserted += await persistNormalizedItems(deps.db, toPersist, {
        mode: 'snapshot',
        tier: 'warm',
        capturedAt: context.now(),
        runId: recorder.runId,
        newItemTier: 'warm', // §7.1: discovered items are new ⇒ warm
      });
    }
  }

  assertFailureQuota(recorder);
}

/** Spec §7.1 step 4 (`snapshot`) — the tracked batch of `(source, tier)`. */
async function runSnapshot(input: JobRunInput, data: SnapshotJob): Promise<void> {
  const refs = await listTrackedItems(input.deps.db, {
    source: data.source,
    tier: data.tier,
    batch: data.batch,
    batchCount: data.batchCount,
  });
  await fetchAndPersist({
    ...input,
    refs: refs.map((row) => toRef(data.source, row)),
    tier: data.tier,
    mode: 'snapshot',
  });
  await enqueueScoring(input.deps, data.source);
}

/**
 * Spec §7.1 step 4 (`daily`) — as snapshot, but only the daily series; the
 * job carries no tier, so refs are grouped by their tracked tier to keep the
 * `FetchOptions.tier` hint accurate.
 */
async function runDaily(input: JobRunInput, data: DailyJob): Promise<void> {
  const rows = await listTrackedItems(input.deps.db, { source: data.source });

  const byTier = new Map<Tier, DiscoveredRef[]>();
  for (const row of rows) {
    const refs = byTier.get(row.tier) ?? [];
    refs.push(toRef(data.source, row));
    byTier.set(row.tier, refs);
  }

  for (const [tier, refs] of byTier) {
    await fetchAndPersist({ ...input, refs, tier, mode: 'daily' });
  }
  await enqueueScoring(input.deps, data.source);
}

/** Spec §7.1 step 4 (`backfill`) — one item's historical series. */
async function runBackfill(input: JobRunInput, data: BackfillJob): Promise<void> {
  const { deps, adapter, context, recorder } = input;
  const item = await loadTrackedItem(deps, data.itemId, data.source);
  if (adapter.backfill === undefined) {
    throw new UnrecoverableError(`adapter "${data.source}" does not implement backfill`);
  }

  recorder.itemsSeen += 1;
  recorder.apiCalls += 1;
  const daily = await adapter.backfill(context, toRef(data.source, item), data.days);
  await persistDailySeries(deps.db, item.id, daily);
  recorder.itemsUpserted += 1;
}

/** Spec §7.1 step 4 (`refresh-item`) — one tracked item, full snapshot. */
async function runRefreshItem(input: JobRunInput, data: RefreshItemJob): Promise<void> {
  const item = await loadTrackedItem(input.deps, data.itemId, data.source);
  await fetchAndPersist({
    ...input,
    refs: [toRef(data.source, item)],
    tier: item.tier,
    mode: 'snapshot',
  });
}

interface FetchAndPersistInput extends JobRunInput {
  refs: DiscoveredRef[];
  tier: Tier;
  mode: 'snapshot' | 'daily';
}

/**
 * Fetch a ref set in `adapter.batchSize` chunks and persist each chunk in one
 * transaction. Per-item problems (404, unnormalizable payload) are counted and
 * logged; more than 50% failures fail the job (spec §7.1).
 */
async function fetchAndPersist(input: FetchAndPersistInput): Promise<void> {
  const { deps, adapter, context, recorder, refs, tier, mode } = input;
  recorder.itemsSeen += refs.length;

  for (const chunk of chunked(refs, Math.max(1, adapter.batchSize))) {
    context.signal.throwIfAborted();
    recorder.apiCalls += 1;
    const fetched = await adapter.fetchMetrics(context, chunk, { tier });

    const toPersist: NormalizedItem[] = [];
    for (const item of fetched) {
      if (item.notFound === true) {
        recorder.itemsFailed += 1;
        context.logger.warn({ externalId: item.ref.externalId }, 'item not found upstream');
        continue;
      }
      if (item.notModified === true) {
        recorder.notModified += 1;
        continue;
      }
      const normalized = adapter.normalize(item);
      if (normalized === null) {
        recorder.itemsFailed += 1;
        context.logger.warn(
          { externalId: item.ref.externalId },
          'adapter could not normalize item',
        );
        continue;
      }
      toPersist.push(normalized);
    }

    if (toPersist.length > 0) {
      recorder.itemsUpserted += await persistNormalizedItems(deps.db, toPersist, {
        mode,
        tier,
        capturedAt: context.now(),
        runId: recorder.runId,
      });
    }
  }

  assertFailureQuota(recorder);
}

/** Spec §7.1: more than half the items failing means the job is retried. */
function assertFailureQuota(recorder: RunRecorder): void {
  if (recorder.itemsSeen > 0 && recorder.itemsFailed * 2 > recorder.itemsSeen) {
    throw new Error(
      `${recorder.itemsFailed} of ${recorder.itemsSeen} items failed — retrying (spec §7.1)`,
    );
  }
}

/** Spec §7.1 step 7 — a successful snapshot/daily triggers a scoring run. */
async function enqueueScoring(deps: IngestDeps, source: Source): Promise<void> {
  if (deps.scoringQueue === undefined) return;
  await enqueueScoringRun(deps.scoringQueue, { source, trigger: 'ingest' });
}

async function loadTrackedItem(
  deps: IngestDeps,
  rawId: string,
  source: Source,
): Promise<TrackedItemRef> {
  if (!/^\d+$/.test(rawId)) {
    throw new UnrecoverableError(`invalid item id "${rawId}"`);
  }
  const item = await getItemById(deps.db, BigInt(rawId));
  if (item === null) {
    throw new UnrecoverableError(`item ${rawId} not found`);
  }
  if (item.source !== source) {
    throw new UnrecoverableError(
      `item ${rawId} belongs to source "${item.source}", not "${source}"`,
    );
  }
  return { id: item.id, externalId: item.externalId, kind: item.kind, tier: item.tier };
}

function toRef(source: Source, item: TrackedItemRef): DiscoveredRef {
  return { source, kind: item.kind, externalId: item.externalId };
}

function chunked<T>(rows: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += size) {
    chunks.push(rows.slice(offset, offset + size));
  }
  return chunks;
}

async function failRun(recorder: RunRecorder, error: unknown): Promise<void> {
  try {
    await recorder.finish('failed', error instanceof Error ? error.message : String(error));
  } catch {
    // The run row is best-effort bookkeeping; the job error is what matters.
  }
}

/** Spec §7.5: non-retryable failures skip the remaining attempts (→ DLQ). */
function asJobError(error: unknown): Error {
  if (error instanceof UnrecoverableError) return error;
  if (error instanceof AdapterNotRegisteredError) return new UnrecoverableError(error.message);
  if (error instanceof UpstreamError && !error.retryable)
    return new UnrecoverableError(error.message);
  return error instanceof Error ? error : new Error(String(error));
}
