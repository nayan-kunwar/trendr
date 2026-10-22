import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';

import { env } from '@trendr/config';
import { MaintenanceJobSchema, QUEUE, type MaintenanceJob } from '@trendr/core';
import { createLogger } from '@trendr/logger';

import { defaultJobOpts } from './queues.js';

/**
 * Operator entry point for the §7.10 maintenance jobs. It enqueues the real
 * BullMQ job (rather than calling the processor in this process) so the
 * running worker owns the metrics update, especially
 * `trendr_snapshots_default_rows`.
 *
 *   node dist/maintenance-cli.js retention
 *   node dist/maintenance-cli.js create-partitions
 *   node dist/maintenance-cli.js rollup-daily
 *   node dist/maintenance-cli.js cleanup-tokens
 */
const type = process.argv[2] ?? 'retention';
const parsed = MaintenanceJobSchema.safeParse({ type });
if (!parsed.success) {
  console.error(
    'usage: node dist/maintenance-cli.js <create-partitions|retention|rollup-daily|cleanup-tokens|retier-items>',
  );
  process.exit(2);
}

const logger = createLogger({ service: 'worker', level: env.LOG_LEVEL });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue<MaintenanceJob>(QUEUE.maintenance, {
  connection: redis,
  defaultJobOptions: defaultJobOpts,
});
const events = new QueueEvents(QUEUE.maintenance, { connection: redis });

try {
  await events.waitUntilReady();
  const job = await queue.add(parsed.data.type, parsed.data, {
    jobId: `manual-${parsed.data.type}-${Date.now()}`,
  });
  logger.info({ jobId: job.id, type: parsed.data.type }, 'maintenance job enqueued');
  const result = (await job.waitUntilFinished(events, 10 * 60_000)) as unknown;
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  logger.error({ err: error }, 'maintenance command failed');
  process.exitCode = 1;
} finally {
  await events.close();
  await queue.close();
  await redis.quit();
}
