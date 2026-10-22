import { describe, expect, it } from 'vitest';

import { SOURCES } from '@trendr/core';

import type { Queues } from './queues.js';
import {
  DIGEST_SCHEDULES,
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
      digest: recorder('digest'),
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
    expect(ids).toHaveLength(
      SOURCES.length + ingestCount + MAINTENANCE_SCHEDULES.length + DIGEST_SCHEDULES.length,
    );
  });

  it('registers the maintenance rows, including the §7.8 retier-items cron', async () => {
    const { queues, calls } = fakeQueues();
    await registerSchedulers(queues);

    const maintenanceCalls = calls.filter((call) => call.queue === 'maintenance');
    expect(maintenanceCalls.map((call) => [call.id, call.pattern])).toEqual([
      ['rollup-daily', '20 0 * * *'],
      ['create-partitions', '0 1 * * *'],
      ['retention', '30 3 * * *'],
      ['retier-items', '0 5 * * *'],
      ['cleanup-tokens', '0 4 * * 0'],
    ]);
    expect(maintenanceCalls.every((call) => call.tz === 'UTC')).toBe(true);
    expect(maintenanceCalls.map((call) => call.name)).toEqual([
      'rollup-daily',
      'create-partitions',
      'retention',
      'retier-items',
      'cleanup-tokens',
    ]);
    expect(maintenanceCalls.map((call) => call.data)).toEqual([
      { type: 'rollup-daily' },
      { type: 'create-partitions' },
      { type: 'retention' },
      { type: 'retier-items' },
      { type: 'cleanup-tokens' },
    ]);
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

  it('registers the four Hugging Face rows with their §7.2 crons and payloads', async () => {
    const { queues, calls } = fakeQueues();
    await registerSchedulers(queues);

    const hfCalls = calls.filter((call) => call.queue === 'ingest-huggingface');
    expect(hfCalls).toHaveLength(4);
    expect(Object.fromEntries(hfCalls.map((call) => [call.id, call.pattern]))).toEqual({
      'hf-discover': '0 * * * *',
      'hf-snapshot-hot': '10 * * * *',
      'hf-snapshot-warm': '40 */6 * * *',
      'hf-snapshot-cold': '45 2 * * *',
    });
    for (const call of hfCalls) {
      expect(call.tz).toBe('UTC');
      expect(call.data).toMatchObject({ source: 'huggingface', trigger: 'schedule' });
    }

    const byId = Object.fromEntries(hfCalls.map((call) => [call.id, call]));
    expect(byId['hf-discover']?.name).toBe('discover');
    expect(byId['hf-discover']?.data).toMatchObject({ strategy: 'trending', maxItems: 1_100 });
    expect(byId['hf-snapshot-hot']?.name).toBe('snapshot-fanout');
    expect(byId['hf-snapshot-hot']?.data).toMatchObject({ tier: 'hot' });
    expect(byId['hf-snapshot-warm']?.data).toMatchObject({ tier: 'warm' });
    expect(byId['hf-snapshot-cold']?.data).toMatchObject({ tier: 'cold' });
  });

  it('registers the two arXiv rows with their §7.3.5 crons and payloads', async () => {
    const { queues, calls } = fakeQueues();
    await registerSchedulers(queues);

    const arxivCalls = calls.filter((call) => call.queue === 'ingest-arxiv');
    expect(arxivCalls).toHaveLength(2);
    expect(Object.fromEntries(arxivCalls.map((call) => [call.id, call.pattern]))).toEqual({
      'arxiv-discover': '0 3 * * *',
      'arxiv-snapshot': '20 * * * *',
    });
    for (const call of arxivCalls) {
      expect(call.tz).toBe('UTC');
      expect(call.data).toMatchObject({ source: 'arxiv', trigger: 'schedule' });
    }

    const byId = Object.fromEntries(arxivCalls.map((call) => [call.id, call]));
    expect(byId['arxiv-discover']?.name).toBe('discover');
    expect(byId['arxiv-discover']?.data).toMatchObject({
      strategy: 'new-listings',
      maxItems: 3_000,
    });
    expect(byId['arxiv-snapshot']?.name).toBe('snapshot-fanout');
    expect(byId['arxiv-snapshot']?.data).toMatchObject({
      type: 'snapshot-fanout',
      tier: 'hot',
    });
  });

  it('registers the five MCP rows with their §7.2/§7.3.6 crons and payloads', async () => {
    const { queues, calls } = fakeQueues();
    await registerSchedulers(queues);

    const mcpCalls = calls.filter((call) => call.queue === 'ingest-mcp');
    expect(mcpCalls).toHaveLength(5);
    expect(Object.fromEntries(mcpCalls.map((call) => [call.id, call.pattern]))).toEqual({
      'mcp-discover': '0 */2 * * *',
      'mcp-discover-full': '30 0 * * 0',
      'mcp-discover-gh-npm': '50 */6 * * *',
      'mcp-snapshot': '25 * * * *',
      'mcp-snapshot-warm': '35 */6 * * *',
    });
    for (const call of mcpCalls) {
      expect(call.tz).toBe('UTC');
      expect(call.data).toMatchObject({ source: 'mcp', trigger: 'schedule' });
    }

    const byId = Object.fromEntries(mcpCalls.map((call) => [call.id, call]));
    expect(byId['mcp-discover']?.name).toBe('discover');
    expect(byId['mcp-discover']?.data).toMatchObject({
      strategy: 'registry',
      maxItems: 50_000,
    });
    expect(byId['mcp-discover-full']?.data).toMatchObject({
      strategy: 'full',
      maxItems: 50_000,
    });
    expect(byId['mcp-discover-gh-npm']?.data).toMatchObject({
      strategy: 'github-npm',
      maxItems: 1_000,
    });
    expect(byId['mcp-snapshot']?.name).toBe('snapshot-fanout');
    expect(byId['mcp-snapshot']?.data).toMatchObject({
      type: 'snapshot-fanout',
      tier: 'hot',
    });
    expect(byId['mcp-snapshot-warm']?.data).toMatchObject({
      type: 'snapshot-fanout',
      tier: 'warm',
    });
  });

  it('registers the three PyPI rows with their §7.3.3 crons and payloads', async () => {
    const { queues, calls } = fakeQueues();
    await registerSchedulers(queues);

    const pypiCalls = calls.filter((call) => call.queue === 'ingest-pypi');
    expect(pypiCalls).toHaveLength(3);
    expect(Object.fromEntries(pypiCalls.map((call) => [call.id, call.pattern]))).toEqual({
      'pypi-discover': '*/30 * * * *',
      'pypi-daily': '0 5 * * *',
      'pypi-daily-retry': '0 11 * * *',
    });
    for (const call of pypiCalls) {
      expect(call.tz).toBe('UTC');
      expect(call.data).toMatchObject({ source: 'pypi', trigger: 'schedule' });
    }

    const byId = Object.fromEntries(pypiCalls.map((call) => [call.id, call]));
    expect(byId['pypi-discover']?.name).toBe('discover');
    expect(byId['pypi-discover']?.data).toMatchObject({ strategy: 'rss', maxItems: 1000 });
    expect(byId['pypi-daily']?.name).toBe('daily');
    expect(byId['pypi-daily']?.data).toEqual({
      type: 'daily',
      source: 'pypi',
      trigger: 'schedule',
    });
    expect(byId['pypi-daily-retry']?.name).toBe('daily');
    expect(byId['pypi-daily-retry']?.data).toMatchObject({ type: 'daily' });
  });
});
