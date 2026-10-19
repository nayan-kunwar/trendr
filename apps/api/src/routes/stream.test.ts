import { describe, expect, it, vi } from 'vitest';

import { SSE_HEARTBEAT_MS, snapshotFrame, startHeartbeat, type SnapshotEntry } from './stream.js';

const TOP: SnapshotEntry[] = [
  { rank: 1, itemId: '1042', score: 7.49, delta: 900 },
  { rank: 2, itemId: '1043', score: 5.1, delta: 0 },
];

describe('snapshotFrame (spec §10.6)', () => {
  it('stamps the runId as event id and carries the top-N rows', () => {
    const frame = snapshotFrame('github', '24h', '81234', TOP, undefined);
    expect(frame).toBe(
      `id: 81234\nevent: leaderboard.snapshot\ndata: ${JSON.stringify({
        scope: 'github',
        window: '24h',
        runId: '81234',
        top: TOP,
      })}\n\n`,
    );
  });

  it('skips the snapshot when Last-Event-ID already equals the runId', () => {
    expect(snapshotFrame('github', '24h', '81234', TOP, '81234')).toBeNull();
    expect(snapshotFrame('github', '24h', '81234', TOP, '81233')).not.toBeNull();
    expect(snapshotFrame('github', '24h', '81234', TOP, undefined)).not.toBeNull();
  });
});

describe('startHeartbeat (spec §10.6)', () => {
  it('sends on the interval until stopped', () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const stop = startHeartbeat(send, SSE_HEARTBEAT_MS);
      vi.advanceTimersByTime(SSE_HEARTBEAT_MS * 3);
      expect(send).toHaveBeenCalledTimes(3);

      stop();
      vi.advanceTimersByTime(SSE_HEARTBEAT_MS);
      expect(send).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
