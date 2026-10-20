import { describe, expect, it } from 'vitest';

import { SOURCES } from '@trendr/core';

import type { Queues } from './queues.js';
import {
  INGEST_SCHEDULES,
  MAINTENANCE_SCHEDULES,
  SCORE_SAFETY_PATTERN,
  registerSchedulers,
  scoreSafetySchedulerId,
} from './scheduler.js';

interface SchedulerCall {
  queue: string;
  id: string;
  pattern: string;
  tz: string | undefined;
  name: string;
  data: unknown;
}

function fakeQueues(): { queues: Queues; calls: SchedulerCall[] } {
  const calls: SchedulerCall[] = [];
  const recorder = (queue: string) => ({
    upsertJobScheduler: (
      id: string,
      repeat: { pattern: string; tz?: string },
      template: { name: string; data: unknown },
    ): Promise<unknown> => {
      calls.push({
        queue,
        id,
        pattern: repeat.pattern,
        tz: repeat.tz,
        name: template.name,
        data: template.data,
      });
      return Promise.resolve({});
    },
  });
  const ingest = {
    github: recorder('ingest-github'),
    npm: recorder('ingest-npm'),
    pypi: recorder('ingest-pypi'),
    huggingface: recorder('ingest-huggingface'),
    arxiv: recorder('ingest-arxiv'),
    mcp: recorder('ingest-mcp'),
  };
  return {
    queues: {
      ingest,
      scoring: recorder('scoring'),
      maintenance: recorder('maintenance'),
    } as unknown as Queues,
    calls,
  };
}

describe('registerSchedulers (spec §7.2)', () => {
  it('registers the score safety net for every source plus the ingest rows', async () => {
    const { queues, calls } = fakeQueues();
    const ids = await registerSchedulers(queues);

    const scoreCalls = calls.filter((call) => call.queue === 'scoring');
    expect(scoreCalls.map((call) => call.id).sort()).toEqual(
      SOURCES.map(scoreSafetySchedulerId).sort(),
    );
    for (const call of scoreCalls) {
      expect(call.pattern).toBe(SCORE_SAFETY_PATTERN);
      expect(call.tz).toBe('UTC');
      expect(call.name).toBe('compute-scores');
    }
    const ingestCount = SOURCES.reduce(
      (total, source) => total + INGEST_SCHEDULES[source].length,
      0,
    );
    expect(ids).toHaveLength(SOURCES.length + ingestCount + MAINTENANCE_SCHEDULES.length);
  });

  it('registers the maintenance rows, including the §7.8 retier-items cron', async () => {
    const { queues, calls } = fakeQueues();
    await registerSchedulers(queues);

    const maintenanceCalls = calls.filter((call) => call.queue === 'maintenance');
    expect(maintenanceCalls.map((call) => [call.id, call.pattern])).toEqual([
      ['retier-items', '0 5 * * *'],
    ]);
    expect(maintenanceCalls[0]?.tz).toBe('UTC');
    expect(maintenanceCalls[0]?.name).toBe('retier-items');
    expect(maintenanceCalls[0]?.data).toEqual({ type: 'retier-items' });
  });

  it('registers the six GitHub rows with their §7.2 crons and payloads', async () => {
    const { queues, calls } = fakeQueues();
    await registerSchedulers(queues);

    const githubCalls = calls.filter((call) => call.queue === 'ingest-github');
    expect(githubCalls).toHaveLength(6);
    expect(Object.fromEntries(githubCalls.map((call) => [call.id, call.pattern]))).toEqual({
      'gh-discover-new': '*/30 * * * *',
      'gh-discover-rising': '10 */2 * * *',
      'gh-discover-topics': '20 */3 * * *',
      'gh-snapshot-hot': '5 * * * *',
      'gh-snapshot-warm': '15 */6 * * *',
      'gh-snapshot-cold': '30 1 * * *',
    });
    for (const call of githubCalls) {
      expect(call.tz).toBe('UTC');
      expect(call.data).toMatchObject({ source: 'github', trigger: 'schedule' });
    }

    const byId = Object.fromEntries(githubCalls.map((call) => [call.id, call]));
    expect(byId['gh-discover-new']?.name).toBe('discover');
    expect(byId['gh-discover-new']?.data).toMatchObject({ strategy: 'new-hot', maxItems: 500 });
    expect(byId['gh-discover-rising']?.data).toMatchObject({ strategy: 'rising', maxItems: 300 });
    expect(byId['gh-discover-topics']?.data).toMatchObject({ strategy: 'topics', maxItems: 150 });
    expect(byId['gh-snapshot-hot']?.name).toBe('snapshot-fanout');
    expect(byId['gh-snapshot-hot']?.data).toMatchObject({ type: 'snapshot-fanout', tier: 'hot' });
    expect(byId['gh-snapshot-cold']?.data).toMatchObject({ tier: 'cold' });
  });

  it('registers the three npm rows with their §7.3.2 crons and payloads', async () => {
    const { queues, calls } = fakeQueues();
    await registerSchedulers(queues);

    const npmCalls = calls.filter((call) => call.queue === 'ingest-npm');
    expect(npmCalls).toHaveLength(3);
    expect(Object.fromEntries(npmCalls.map((call) => [call.id, call.pattern]))).toEqual({
      'npm-discover': '0 */6 * * *',
      'npm-daily': '30 2 * * *',
      'npm-daily-retry': '0 6 * * *',
    });
    for (const call of npmCalls) {
      expect(call.tz).toBe('UTC');
      expect(call.data).toMatchObject({ source: 'npm', trigger: 'schedule' });
    }

    const byId = Object.fromEntries(npmCalls.map((call) => [call.id, call]));
    expect(byId['npm-discover']?.name).toBe('discover');
    expect(byId['npm-discover']?.data).toMatchObject({
      strategy: 'keywords',
      maxItems: 1000,
    });
    expect(byId['npm-daily']?.name).toBe('daily');
    expect(byId['npm-daily']?.data).toEqual({
      type: 'daily',
      source: 'npm',
      trigger: 'schedule',
    });
    expect(byId['npm-daily-retry']?.name).toBe('daily');
    expect(byId['npm-daily-retry']?.data).toMatchObject({ type: 'daily' });
  });
});
