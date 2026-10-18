import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { QueueEvents, type Worker } from 'bullmq';
import { and, count, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  QUEUE,
  SOURCES,
  jobId,
  redisKeys,
  type ScoringJob,
  type Source,
  type Window,
} from '@trendr/core';
import {
  createDb,
  ingestionRuns,
  scoreRunsCurrent,
  scores,
  type Connection,
  type Db,
} from '@trendr/db';
import { seed } from '@trendr/db/seed';

import {
  closeQueues,
  createQueues,
  createWorkerConnection,
  defaultJobOpts,
  enqueueScoringRun,
  scoringSlot,
  type Queues,
} from '../../src/queues.js';
import {
  SCORE_SAFETY_PATTERN,
  registerSchedulers,
  scoreSafetySchedulerId,
} from '../../src/scheduler.js';
import { createScoringWorker } from '../../src/scoring/processor.js';

/**
 * Task 2.6 acceptance (spec §18): a real BullMQ worker on the `scoring` queue
 * processes `compute-scores` over the seeded database (validation, board
 * publishing and the `evaluate-alerts` fan-out through `runScoring`),
 * deterministic slot jobIds dedupe, invalid payloads fail unrecoverably into
 * the dead-letter queue, the `score-safety` schedulers register idempotently,
 * and the `worker:score` CLI enqueues a job the worker then processes.
 */

const ANCHOR = new Date('2026-10-18T12:00:00Z');
const PEPPER = 'seed-int-test-pepper-0123456789abcdef';
const ADMIN_EMAIL = 'seed-admin@trendr.test';
const WORKER_DIR = fileURLToPath(new URL('../..', import.meta.url));
const CLI_SCRIPT = fileURLToPath(new URL('../../src/score-cli.ts', import.meta.url));

/** Env for the spawned CLI: schema-required vars the int runner does not set. */
const CLI_ENV = {
  JWT_SECRET: 'int-test-jwt-secret-0123456789abcdef',
  API_KEY_PEPPER: 'int-test-api-pepper-0123456789abcdef',
  UNSUBSCRIBE_SECRET: 'int-test-unsubscribe-secret-0123456789abcdef',
  METRICS_TOKEN: 'int-test-metrics-token',
  API_PUBLIC_URL: 'http://localhost:4000',
  WEB_PUBLIC_URL: 'http://localhost:3000',
  CORS_ORIGINS: 'http://localhost:3000',
  WORKER_ROLES: 'scoring',
};

let connection: Connection;
let db: Db;
let redis: Redis;
let bullRedis: Redis;
let queues: Queues;
let worker: Worker;
let events: QueueEvents;

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) {
    throw new Error('DATABASE_URL/REDIS_URL are missing — run through `pnpm test:int`');
  }
  connection = createDb(databaseUrl);
  db = connection.db;
  redis = new Redis(redisUrl);
  await seed(db, { pepper: PEPPER, adminEmail: ADMIN_EMAIL, now: ANCHOR });

  bullRedis = createWorkerConnection(redisUrl);
  queues = createQueues(bullRedis);
  events = new QueueEvents(QUEUE.scoring, { connection: createWorkerConnection(redisUrl) });
  await events.waitUntilReady();
  worker = createScoringWorker({
    db,
    redis,
    connection: bullRedis,
    notifyQueue: queues.notify,
    deadLetter: queues.deadLetter,
    now: () => ANCHOR,
    concurrency: 1,
  });
  await worker.waitUntilReady();
}, 180_000);

afterAll(async () => {
  await worker.close();
  await events.close();
  await closeQueues(queues);
  await redis.quit();
  await bullRedis.quit();
  await connection.pool.end();
});

function single<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('expected exactly one row');
  return row;
}

function requireJobId(job: { id?: string | undefined }): string {
  if (job.id === undefined) throw new Error('expected the job to have an id');
  return job.id;
}

async function currentRunId(source: Source, window: Window): Promise<bigint> {
  const current = single(
    await db
      .select()
      .from(scoreRunsCurrent)
      .where(and(eq(scoreRunsCurrent.source, source), eq(scoreRunsCurrent.window, window))),
  );
  return current.runId;
}

async function currentRunRowCount(source: Source, window: Window): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(scores)
    .where(
      and(
        eq(scores.runId, await currentRunId(source, window)),
        eq(scores.source, source),
        eq(scores.window, window),
      ),
    );
  return row?.n ?? 0;
}

describe('scoring queue processor', () => {
  it('processes an enqueued compute-scores job end to end', async () => {
    const job = await enqueueScoringRun(queues.scoring, {
      source: 'mcp',
      windows: ['24h'],
      trigger: 'admin',
      slot: '2026-10-18T12-00',
    });
    expect(job.id).toBe('score.mcp.2026-10-18T12-00');

    const result = await job.waitUntilFinished(events, 30_000);
    expect(result).toEqual({ source: 'mcp', windows: ['24h'] });

    const run = single(
      await db
        .select()
        .from(ingestionRuns)
        .where(eq(ingestionRuns.jobId, 'score.mcp.2026-10-18T12-00')),
    );
    expect(run.status).toBe('succeeded');
    expect(await currentRunRowCount('mcp', '24h')).toBeGreaterThan(0);
    expect(await redis.exists(redisKeys.leaderboard('mcp', '24h', '_all'))).toBe(1);
    expect(
      await queues.notify.getJob(jobId.evaluateAlerts(String(await currentRunId('mcp', '24h')))),
    ).toBeTruthy();
  }, 90_000);

  it('dedupes scoring jobs by slot jobId', async () => {
    const slot = '2026-10-18T12-10';
    const first = await enqueueScoringRun(queues.scoring, {
      source: 'huggingface',
      windows: ['7d'],
      trigger: 'schedule',
      slot,
    });
    const second = await enqueueScoringRun(queues.scoring, {
      source: 'huggingface',
      windows: ['7d'],
      trigger: 'admin',
      slot,
    });

    expect(first.id).toBe('score.huggingface.2026-10-18T12-10');
    expect(second.id).toBe(first.id);

    const jobs = await queues.scoring.getJobs([
      'waiting',
      'active',
      'delayed',
      'completed',
      'failed',
    ]);
    expect(jobs.filter((job) => job.id === first.id)).toHaveLength(1);
    const stored = await queues.scoring.getJob(requireJobId(first));
    expect(stored?.timestamp).toBe(first.timestamp);
  }, 30_000);

  it('fails invalid payloads unrecoverably and parks them in the dead-letter queue', async () => {
    const invalid = {
      source: 'gitlab',
      windows: ['24h'],
      trigger: 'schedule',
    } as unknown as ScoringJob;
    const job = await queues.scoring.add('compute-scores', invalid, { ...defaultJobOpts });

    await vi.waitFor(
      async () => {
        expect(await job.isFailed()).toBe(true);
      },
      { timeout: 20_000 },
    );
    const failed = await queues.scoring.getJob(requireJobId(job));
    expect(failed?.failedReason).toContain('invalid scoring job payload');
    expect(failed?.attemptsMade ?? 0).toBeLessThanOrEqual(1);

    await vi.waitFor(
      async () => {
        const dead = await queues.deadLetter.getJobs([
          'waiting',
          'active',
          'delayed',
          'completed',
          'failed',
        ]);
        expect(dead.filter((entry) => entry.name === 'dead')).toHaveLength(1);
      },
      { timeout: 10_000 },
    );
    const dead = await queues.deadLetter.getJobs([
      'waiting',
      'active',
      'delayed',
      'completed',
      'failed',
    ]);
    const entry = dead.find((candidate) => candidate.name === 'dead');
    expect(entry?.data.originalQueue).toBe(QUEUE.scoring);
    expect(entry?.data.name).toBe('compute-scores');
    expect(entry?.data.failedReason).toContain('invalid scoring job payload');
  }, 60_000);
});

describe('schedulers', () => {
  it('registers the score-safety schedulers idempotently', async () => {
    const first = await registerSchedulers(queues);
    const second = await registerSchedulers(queues);
    expect(second).toEqual(first);
    expect(await queues.scoring.getJobSchedulersCount()).toBe(SOURCES.length);

    const schedulers = await queues.scoring.getJobSchedulers(0, -1, true);
    const byKey = new Map(schedulers.map((scheduler) => [scheduler.key, scheduler]));
    for (const source of SOURCES) {
      const scheduler = byKey.get(scoreSafetySchedulerId(source));
      expect(scheduler?.pattern).toBe(SCORE_SAFETY_PATTERN);
      expect(scheduler?.tz).toBe('UTC');
      expect(scheduler?.name).toBe('compute-scores');
      expect(scheduler?.template?.data).toEqual({
        source,
        windows: ['24h', '7d', '30d'],
        trigger: 'schedule',
      });
      expect(typeof scheduler?.next).toBe('number');
    }
  }, 30_000);
});

describe('worker:score CLI', () => {
  it('enqueues a scoring job through the script and the worker processes it', async () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', CLI_SCRIPT, '--source', 'arxiv', '--windows', '24h'],
      {
        cwd: WORKER_DIR,
        env: { ...process.env, ...CLI_ENV },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);

    const jobs = await queues.scoring.getJobs([
      'waiting',
      'active',
      'delayed',
      'completed',
      'failed',
    ]);
    const cliJob = jobs.find((job) => job.name === 'compute-scores' && job.data.source === 'arxiv');
    expect(cliJob).toBeDefined();
    if (cliJob === undefined) {
      throw new Error('the CLI did not enqueue a compute-scores job');
    }
    expect(cliJob.id).toMatch(/^score\.arxiv\./);
    expect(cliJob.id).toBe(jobId.scoring('arxiv', scoringSlot(new Date())));
    expect(cliJob.data.trigger).toBe('admin');

    await cliJob.waitUntilFinished(events, 30_000);
    expect(await currentRunRowCount('arxiv', '24h')).toBeGreaterThan(0);
  }, 120_000);
});
