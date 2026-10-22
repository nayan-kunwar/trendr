import type { Queue } from 'bullmq';

import type { Db } from '@trendr/db';

import { describe, expect, it } from 'vitest';

import { startFreshnessPoller } from './freshness.js';
import { startQueueDepthPoller } from './queue-depth.js';

interface Observation {
  key: string;
  value: number;
}

function fakeQueue(
  name: string,
  counts: { waiting?: number; active?: number; delayed?: number; failed?: number },
): Queue {
  return {
    name,
    getJobCounts: () =>
      Promise.resolve({ waiting: 0, active: 0, delayed: 0, failed: 0, ...counts }),
  } as unknown as Queue;
}

describe('queue-depth poller (spec §14.1)', () => {
  it('publishes waiting/active/delayed/failed counts for every queue', async () => {
    const observations: Observation[] = [];
    const queues = [
      fakeQueue('ingest-github', { waiting: 3, active: 1, delayed: 2, failed: 4 }),
      fakeQueue('scoring', { waiting: 0, active: 0, delayed: 0, failed: 0 }),
    ];
    const poller = startQueueDepthPoller({
      queues,
      immediate: false,
      observe: (queue, state, value) => observations.push({ key: `${queue}.${state}`, value }),
    });
    try {
      await poller.poll();
    } finally {
      poller.stop();
    }
    expect(Object.fromEntries(observations.map((o) => [o.key, o.value]))).toEqual({
      'ingest-github.waiting': 3,
      'ingest-github.active': 1,
      'ingest-github.delayed': 2,
      'ingest-github.failed': 4,
      'scoring.waiting': 0,
      'scoring.active': 0,
      'scoring.delayed': 0,
      'scoring.failed': 0,
    });
  });

  it('keeps polling the remaining queues when one getJobCounts fails', async () => {
    const warnings: unknown[] = [];
    const observations: Observation[] = [];
    const bad = {
      name: 'bad',
      getJobCounts: () => Promise.reject(new Error('redis down')),
    } as unknown as Queue;
    const poller = startQueueDepthPoller({
      queues: [bad, fakeQueue('ok', { waiting: 7 })],
      immediate: false,
      logger: { warn: (...args: unknown[]) => warnings.push(args) } as never,
      observe: (queue, state, value) => observations.push({ key: `${queue}.${state}`, value }),
    });
    try {
      await poller.poll();
    } finally {
      poller.stop();
    }
    expect(observations).toContainEqual({ key: 'ok.waiting', value: 7 });
    expect(warnings).toHaveLength(1);
  });
});

describe('freshness poller (spec §14.1)', () => {
  it('loads the age of the newest snapshot per source/tier', async () => {
    const rows = [
      { source: 'github', tier: 'hot', ageSeconds: '120.5' },
      { source: 'npm', tier: 'warm', ageSeconds: 7200 },
    ];
    const db = {
      execute: () => Promise.resolve({ rows, rowCount: rows.length }),
    } as unknown as Db;
    const observations: Observation[] = [];
    const poller = startFreshnessPoller({
      db,
      immediate: false,
      now: () => new Date('2026-10-20T00:00:00Z'),
      observe: (source, tier, seconds) =>
        observations.push({ key: `${source}.${tier}`, value: seconds }),
    });
    try {
      await poller.poll();
    } finally {
      poller.stop();
    }
    expect(observations).toEqual([
      { key: 'github.hot', value: 120.5 },
      { key: 'npm.warm', value: 7200 },
    ]);
  });

  it('logs and preserves the previous gauge on a query failure', async () => {
    const warnings: unknown[] = [];
    const db = {
      execute: () => Promise.reject(new Error('db down')),
    } as unknown as Db;
    const poller = startFreshnessPoller({
      db,
      immediate: false,
      logger: { warn: (...args: unknown[]) => warnings.push(args) } as never,
    });
    try {
      await expect(poller.poll()).resolves.toBeUndefined();
    } finally {
      poller.stop();
    }
    expect(warnings).toHaveLength(1);
  });
});
