import { afterEach, describe, expect, it, vi } from 'vitest';

import { UpstreamError } from '@trendr/core';

import { workerSettings } from '../../src/queues.js';

function configuredStrategy(): NonNullable<(typeof workerSettings)['backoffStrategy']> {
  const strategy = workerSettings.backoffStrategy;
  if (strategy === undefined) {
    throw new Error('workerSettings.backoffStrategy is not configured');
  }
  return strategy;
}

const strategy = configuredStrategy();

describe('worker backoff strategy (spec §7.5)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('honours UpstreamError.retryAfterMs plus jitter', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const error = new UpstreamError('rate limited', 'github', 429, 7_000, true);

    expect(strategy(2, 'custom', error)).toBe(9_500);
  });

  it('falls back to full jitter between 5 s and 30 minutes', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    // attempt 1 → min(cap, 5_000 * 2^1) = 10_000 → 0.5 × 10_000
    expect(strategy(1, 'custom', new Error('boom'))).toBe(5_000);
    // high attempts cap at 30 minutes → 0.5 × 1_800_000
    expect(strategy(12, 'custom', new Error('boom'))).toBe(15 * 60_000);
  });

  it('treats a zero retryAfterMs as absent', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const error = new UpstreamError('quota', 'github', 403, 0, true);

    expect(strategy(0, 'custom', error)).toBe(0);
  });
});
