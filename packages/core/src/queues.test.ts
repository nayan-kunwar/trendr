import { describe, expect, it } from 'vitest';

import {
  type DigestJob,
  DigestJobSchema,
  type IngestJob,
  IngestJobSchema,
  jobId,
  MaintenanceJobSchema,
  NotifyJobSchema,
  QUEUE,
  ScoringJobSchema,
} from './queues.js';
import { SOURCES } from './types.js';

describe('QUEUE (spec §5.2)', () => {
  const allNames = [
    ...Object.values(QUEUE.ingest),
    ...Object.values(QUEUE).filter((v) => typeof v === 'string'),
  ];

  it('contains no ":" — BullMQ forbids it in queue names', () => {
    for (const name of allNames) {
      expect(name).not.toContain(':');
    }
  });

  it('has one ingest queue per source and no extras', () => {
    expect(Object.keys(QUEUE.ingest)).toEqual([...SOURCES]);
  });

  it('uses unique names', () => {
    expect(new Set(allNames).size).toBe(allNames.length);
  });
});

describe('jobId builders (spec §5.2)', () => {
  it('produces the exact deterministic ids', () => {
    expect(jobId.snapshot('github', 'hot', '2026-10-18T14', 0)).toBe(
      'github.snapshot.hot.2026-10-18T14.0',
    );
    expect(jobId.daily('npm', '2026-10-18')).toBe('npm.daily.2026-10-18');
    expect(jobId.discover('pypi', 'updated', '2026-10-18T14')).toBe(
      'pypi.discover.updated.2026-10-18T14',
    );
    expect(jobId.scoring('npm', '2026-10-18T14-40')).toBe('score.npm.2026-10-18T14-40');
    expect(jobId.sendDigest('42', '2026-10-13')).toBe('digest.42.2026-10-13');
    expect(jobId.alertEmail('9')).toBe('alert.9');
    expect(jobId.evaluateAlerts('81234')).toBe('alerts.81234');
  });

  it('never emits ":" — BullMQ custom ids forbid it', () => {
    const ids = [
      jobId.snapshot('github', 'hot', '2026-10-18T14', 0),
      jobId.daily('npm', '2026-10-18'),
      jobId.discover('pypi', 'updated', '2026-10-18T14'),
      jobId.scoring('npm', '2026-10-18T14-40'),
      jobId.sendDigest('42', '2026-10-13'),
      jobId.alertEmail('9'),
      jobId.evaluateAlerts('81234'),
    ];
    for (const id of ids) {
      expect(id).not.toContain(':');
    }
  });

  it('is stable for identical input (dedup key)', () => {
    expect(jobId.snapshot('github', 'warm', '2026-10-18T14', 3)).toBe(
      jobId.snapshot('github', 'warm', '2026-10-18T14', 3),
    );
  });
});

describe('IngestJobSchema (spec §5.2)', () => {
  it('parses every variant', () => {
    const jobs: IngestJob[] = [
      { type: 'discover', source: 'github', strategy: 'updated', maxItems: 500 },
      { type: 'snapshot-fanout', source: 'github', tier: 'hot', trigger: 'schedule' },
      { type: 'snapshot', source: 'github', tier: 'hot', batch: 0, batchCount: 4 },
      { type: 'daily', source: 'npm', day: '2026-10-18' },
      { type: 'backfill', source: 'arxiv', itemId: '123', days: 30 },
      { type: 'refresh-item', source: 'mcp', itemId: '456' },
    ];
    for (const job of jobs) {
      expect(IngestJobSchema.parse(job)).toEqual(job);
    }
  });

  it('accepts only known triggers', () => {
    expect(
      IngestJobSchema.parse({
        type: 'snapshot',
        source: 'github',
        tier: 'cold',
        batch: 0,
        batchCount: 1,
        trigger: 'schedule',
      }),
    ).toMatchObject({ trigger: 'schedule' });
    expect(
      IngestJobSchema.safeParse({
        type: 'snapshot',
        source: 'github',
        tier: 'cold',
        batch: 0,
        batchCount: 1,
        trigger: 'cron',
      }).success,
    ).toBe(false);
  });

  it('rejects malformed payloads', () => {
    expect(IngestJobSchema.safeParse({}).success).toBe(false);
    expect(
      IngestJobSchema.safeParse({
        type: 'snapshot',
        source: 'github',
        tier: 'hot',
        batch: -1,
        batchCount: 1,
      }).success,
    ).toBe(false);
    expect(
      IngestJobSchema.safeParse({
        type: 'snapshot',
        source: 'gitlab',
        tier: 'hot',
        batch: 0,
        batchCount: 1,
      }).success,
    ).toBe(false);
    expect(
      IngestJobSchema.safeParse({ type: 'daily', source: 'npm', day: '18-10-2026' }).success,
    ).toBe(false);
    expect(
      IngestJobSchema.safeParse({ type: 'backfill', source: 'arxiv', itemId: '1', days: 366 })
        .success,
    ).toBe(false);
    expect(
      IngestJobSchema.safeParse({ type: 'backfill', source: 'arxiv', itemId: '1', days: 0 })
        .success,
    ).toBe(false);
  });
});

describe('ScoringJobSchema (spec §5.2)', () => {
  it('defaults windows to all three', () => {
    const job = ScoringJobSchema.parse({ source: 'npm', trigger: 'schedule' });
    expect(job.windows).toEqual(['24h', '7d', '30d']);
  });

  it('accepts an explicit window subset', () => {
    const job = ScoringJobSchema.parse({ source: 'npm', windows: ['24h'], trigger: 'ingest' });
    expect(job.windows).toEqual(['24h']);
  });

  it('rejects unknown triggers', () => {
    expect(ScoringJobSchema.safeParse({ source: 'npm', trigger: 'cron' }).success).toBe(false);
  });
});

describe('Notify / Digest / Maintenance schemas (spec §5.2)', () => {
  it('parses notify variants', () => {
    expect(
      NotifyJobSchema.parse({ type: 'evaluate-alerts', scoreRunId: '1', source: 'github' }),
    ).toEqual({ type: 'evaluate-alerts', scoreRunId: '1', source: 'github' });
    expect(NotifyJobSchema.parse({ type: 'send-alert-email', alertEventId: '2' })).toEqual({
      type: 'send-alert-email',
      alertEventId: '2',
    });
  });

  it('parses digest variants', () => {
    const job: DigestJob = { type: 'build-weekly-digest', weekStart: '2026-10-13' };
    expect(DigestJobSchema.parse(job)).toEqual(job);
    expect(
      DigestJobSchema.parse({ type: 'send-digest', subscriptionId: '7', weekStart: '2026-10-13' }),
    ).toEqual({ type: 'send-digest', subscriptionId: '7', weekStart: '2026-10-13' });
  });

  it('accepts exactly the maintenance types', () => {
    for (const type of [
      'create-partitions',
      'retention',
      'retier-items',
      'rollup-daily',
      'cleanup-tokens',
    ]) {
      expect(MaintenanceJobSchema.parse({ type })).toEqual({ type });
    }
    expect(MaintenanceJobSchema.safeParse({ type: 'vacuum' }).success).toBe(false);
  });
});
