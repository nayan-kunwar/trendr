import { describe, expect, it } from 'vitest';

import { buildAdminIngestJob, tenMinuteSlot, utcDay } from './admin.service.js';

/**
 * Task 4.6 — the §10.1 ingest body maps to deterministic job ids and payloads.
 * The route tests cover the HTTP surface; this pins the per-type mapping
 * (including the `snapshot` → `snapshot-fanout` translation) without infra.
 */

const SLOT = '2026-10-19T14-30';
const DAY = '2026-10-19';

describe('buildAdminIngestJob (spec §10.1)', () => {
  it('maps discover with the manual trigger', () => {
    const trigger = buildAdminIngestJob(
      { type: 'discover', source: 'github', strategy: 'rising', maxItems: 42 },
      SLOT,
      DAY,
    );
    expect(trigger).toEqual({
      id: 'github.discover.rising.2026-10-19T14-30',
      name: 'discover',
      job: {
        type: 'discover',
        source: 'github',
        strategy: 'rising',
        maxItems: 42,
        trigger: 'manual',
      },
    });
  });

  it('maps snapshot to the §7.2 snapshot-fanout payload', () => {
    const trigger = buildAdminIngestJob(
      { type: 'snapshot', source: 'npm', tier: 'cold' },
      SLOT,
      DAY,
    );
    expect(trigger).toEqual({
      id: 'npm.snapshot-fanout.cold.2026-10-19T14-30',
      name: 'snapshot-fanout',
      job: { type: 'snapshot-fanout', source: 'npm', tier: 'cold', trigger: 'manual' },
    });
  });

  it('maps daily, backfill and refresh-item to their UTC-day job ids', () => {
    expect(buildAdminIngestJob({ type: 'daily', source: 'pypi' }, SLOT, DAY)).toEqual({
      id: 'pypi.daily.2026-10-19',
      name: 'daily',
      job: { type: 'daily', source: 'pypi', day: '2026-10-19', trigger: 'manual' },
    });

    expect(
      buildAdminIngestJob(
        { type: 'backfill', source: 'github', itemId: '4711', days: 90 },
        SLOT,
        DAY,
      ),
    ).toEqual({
      id: 'backfill.github.4711.2026-10-19',
      name: 'backfill',
      job: {
        type: 'backfill',
        source: 'github',
        itemId: '4711',
        days: 90,
        trigger: 'manual',
      },
    });

    expect(
      buildAdminIngestJob({ type: 'refresh-item', source: 'arxiv', itemId: '9' }, SLOT, DAY),
    ).toEqual({
      id: 'refresh.arxiv.9.2026-10-19',
      name: 'refresh-item',
      job: { type: 'refresh-item', source: 'arxiv', itemId: '9', trigger: 'manual' },
    });
  });
});

describe('admin time helpers (spec §5.2)', () => {
  it('derives the UTC day and the ten-minute slot', () => {
    const at = new Date('2026-10-19T14:37:12.000Z');
    expect(utcDay(at)).toBe('2026-10-19');
    expect(tenMinuteSlot(at)).toBe('2026-10-19T14-30');
  });
});
