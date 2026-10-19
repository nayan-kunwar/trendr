import { EventEmitter } from 'node:events';

import { UnrecoverableError, type Queue, type Worker } from 'bullmq';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { Logger } from '@trendr/logger';

import { attachDeadLetter } from '../../src/dlq.js';
import { dlqJobsTotal } from '../../src/metrics.js';
import type { DeadLetterJob } from '../../src/queues.js';

interface FailedJobDouble {
  queueName: string;
  name: string;
  data: unknown;
  id: string | undefined;
  opts: { attempts?: number };
  attemptsMade: number;
}

type AddFn = (
  name: string,
  data: DeadLetterJob,
  options: Record<string, unknown>,
) => Promise<unknown>;
type AddCall = [string, DeadLetterJob, Record<string, unknown>];

function jobDouble(overrides: Partial<FailedJobDouble> = {}): FailedJobDouble {
  return {
    queueName: 'ingest-github',
    name: 'snapshot',
    data: { type: 'snapshot', source: 'github' },
    id: '42',
    opts: { attempts: 5 },
    attemptsMade: 5,
    ...overrides,
  };
}

function setup(logger?: Logger): { worker: EventEmitter; add: Mock<AddFn> } {
  const worker = new EventEmitter();
  const add = vi.fn<AddFn>().mockResolvedValue({ id: 'dlq-entry' });
  const queue = { add } as unknown as Queue<DeadLetterJob>;
  attachDeadLetter(worker as unknown as Worker, queue, logger);
  return { worker, add };
}

function firstCall(add: Mock<AddFn>): AddCall {
  const call = add.mock.calls[0];
  if (call === undefined) {
    throw new Error('dead-letter add was not called');
  }
  return call;
}

async function dlqCountFor(queue: string): Promise<number> {
  const metric = await dlqJobsTotal.get();
  return metric.values.find((value) => value.labels.queue === queue)?.value ?? 0;
}

describe('dead-letter parking (spec §7.7)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parks a finally-failed job with its reason, retention and deterministic id', async () => {
    const { worker, add } = setup();
    const error = new Error('boom');
    worker.emit('failed', jobDouble(), error);

    await vi.waitFor(() => {
      expect(add).toHaveBeenCalledTimes(1);
    });
    const [name, entry, options] = firstCall(add);
    expect(name).toBe('dead');
    expect(entry.originalQueue).toBe('ingest-github');
    expect(entry.name).toBe('snapshot');
    expect(entry.jobId).toBe('42');
    expect(entry.failedReason).toBe('boom');
    expect(entry.stack).toBe(error.stack?.slice(0, 4000));
    expect(entry.attemptsMade).toBe(5);
    expect(options.jobId).toBe('dlq.ingest-github.42');
    expect(options.removeOnComplete).toBe(false);
    expect(options.removeOnFail).toBe(false);

    await vi.waitFor(async () => {
      expect(await dlqCountFor('ingest-github')).toBe(1);
    });
  });

  it('parks an unrecoverable failure on its first attempt', async () => {
    const { worker, add } = setup();
    worker.emit('failed', jobDouble({ attemptsMade: 1 }), new UnrecoverableError('schema drift'));

    await vi.waitFor(() => {
      expect(add).toHaveBeenCalledTimes(1);
    });
    expect(firstCall(add)[1].failedReason).toBe('schema drift');
  });

  it('leaves retryable jobs alone until the final attempt', () => {
    const { worker, add } = setup();
    worker.emit('failed', jobDouble({ attemptsMade: 2 }), new Error('boom'));

    expect(add).not.toHaveBeenCalled();
  });

  it('ignores failed events without a job', () => {
    const { worker, add } = setup();
    worker.emit('failed', undefined, new Error('boom'));

    expect(add).not.toHaveBeenCalled();
  });

  it('logs (and swallows) a dead-letter enqueue failure', async () => {
    const errorLog = vi.fn();
    const { worker, add } = setup({ error: errorLog } as unknown as Logger);
    add.mockRejectedValueOnce(new Error('redis down'));

    worker.emit('failed', jobDouble({ queueName: 'unit-dlq-broken' }), new Error('boom'));

    await vi.waitFor(() => {
      expect(errorLog).toHaveBeenCalledTimes(1);
    });
    expect(await dlqCountFor('unit-dlq-broken')).toBe(0);
  });
});
