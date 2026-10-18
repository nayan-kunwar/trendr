#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createLogger } from '@trendr/logger';

import { closeQueues, createQueues, createWorkerConnection, enqueueScoringRun } from './queues.js';
import { parseScoreArgs, type ScoreCliOptions } from './scoring/score-args.js';

/**
 * `pnpm worker:score --source github [--windows 24h,7d]` — the admin-less
 * trigger of spec §18 task 2.6 (`node dist/score-cli.js` in compose): enqueue
 * one `compute-scores` job (deterministic slot jobId) and exit.
 */

export async function enqueueScoreRun(options: ScoreCliOptions, redisUrl: string): Promise<string> {
  const connection = createWorkerConnection(redisUrl);
  const queues = createQueues(connection);
  try {
    const job = await enqueueScoringRun(queues.scoring, {
      source: options.source,
      windows: options.windows,
      trigger: 'admin',
    });
    return job.id ?? '';
  } finally {
    await closeQueues(queues);
    await connection.quit();
  }
}

async function main(): Promise<void> {
  // Imported after `.env` loading so boot-time validation sees it (same pattern
  // as `packages/db/src/seed.ts`).
  const { env } = await import('@trendr/config');
  const logger = createLogger({ service: 'worker', level: env.LOG_LEVEL });
  try {
    const options = parseScoreArgs(process.argv.slice(2));
    const id = await enqueueScoreRun(options, env.REDIS_URL);
    logger.info(
      { jobId: id, source: options.source, windows: options.windows },
      'scoring job enqueued',
    );
  } catch (error: unknown) {
    logger.error({ err: error }, 'could not enqueue scoring job');
    process.exitCode = 1;
  }
}

/**
 * `node dist/score-cli.js` detection that survives symlinks (same pattern as
 * the seed CLI): pnpm deploy symlinks `import.meta.url` under `.pnpm/`.
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/** Local DX: pick up `.env` when the shell has not exported it (compose sets env itself). */
function loadEnvFiles(candidates: readonly string[]): void {
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    process.loadEnvFile(candidate);
  }
}

if (isDirectRun()) {
  loadEnvFiles(['.env', '../../.env', '../../../.env']);
  await main();
}
