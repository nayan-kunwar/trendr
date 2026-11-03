import { describe, expect, it, vi } from 'vitest';

import type { Db } from '@trendr/db';

import { RunRecorder } from '../../src/ingestion/run-recorder.js';
import { failRun } from '../../src/processors/ingest.processor.js';

/**
 * L-5: run bookkeeping is best-effort. A failing `finishRun` must stay
 * retryable (so the row does not stay `running`), must be logged with the
 * original job error, and must never replace that original error.
 */

function flakyDb(failures: number): { db: Db; calls: () => number } {
  let calls = 0;
  const db = {
    update: () => ({
      set: () => ({
        where: () => {
          calls += 1;
          return calls <= failures
            ? Promise.reject(new Error('bookkeeping write failed'))
            : Promise.resolve(undefined);
        },
      }),
    }),
  };
  return { db: db as unknown as Db, calls: () => calls };
}

describe('run bookkeeping failures (L-5)', () => {
  it('keeps the recorder retryable until a close succeeds', async () => {
    const { db, calls } = flakyDb(1);
    const recorder = new RunRecorder(db, 42n);

    await expect(recorder.finish('failed', 'upstream exploded')).rejects.toThrow(
      'bookkeeping write failed',
    );
    expect(calls()).toBe(1);

    // The flag was not set, so a second close actually retries the write.
    await recorder.finish('failed', 'upstream exploded');
    expect(calls()).toBe(2);

    // A third call is a no-op because the close succeeded.
    await recorder.finish('succeeded');
    expect(calls()).toBe(2);
  });

  it('logs both errors and retries once when recording a failure', async () => {
    const finish = vi.fn(async () => Promise.reject(new Error('db down')));
    const logger = { error: vi.fn() };

    await expect(
      failRun({ finish }, new Error('the real failure'), logger),
    ).resolves.toBeUndefined();

    expect(finish).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenCalledWith('failed', 'the real failure');
    expect(logger.error).toHaveBeenCalledTimes(2);
    for (const call of logger.error.mock.calls) {
      expect(call[0]).toMatchObject({ original: 'the real failure' });
    }
  });

  it('does not throw when the first close succeeds (the common path)', async () => {
    const finish = vi.fn(() => Promise.resolve());
    const logger = { error: vi.fn() };

    await failRun({ finish }, 'boom', logger);

    expect(finish).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
