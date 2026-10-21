// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveLeaderboard } from '@/components/live-leaderboard';
import type { LeaderboardEntry, TrendingResponse } from '@/lib/schemas';

type Listener = (event: Event) => void;

class FakeEventSource {
  static latest: FakeEventSource | undefined;
  readonly url: string;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.latest = this;
  }

  addEventListener(type: string, listener: Listener | null): void {
    if (listener === null) return;
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener | null): void {
    if (listener === null) return;
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.listeners.clear();
  }

  emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function entry(id: string, name: string, rank: number): LeaderboardEntry {
  return {
    rank,
    item: {
      id,
      source: 'github',
      kind: 'repo',
      externalId: `owner/${name}`,
      displayName: `owner/${name}`,
      description: `${name} description`,
      url: `https://github.com/owner/${name}`,
      language: 'TypeScript',
      topics: ['testing'],
      primaryMetric: 'stars',
    },
    window: '24h',
    delta: 10,
    relGrowth: 0.05,
    score: 3.2,
    percentile: 99,
    current: 1000,
    sparkline: [1, 2, 3, 4, 5],
    flags: [],
  };
}

function board(entries: LeaderboardEntry[]): TrendingResponse {
  return {
    scope: 'all',
    window: '24h',
    runId: 'run-1',
    computedAt: '2026-10-21T10:00:00.000Z',
    data: entries,
    page: { nextCursor: null, limit: 25 },
  };
}

describe('LiveLeaderboard', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    cleanup();
    FakeEventSource.latest = undefined;
    vi.unstubAllGlobals();
  });

  it('refetches on an SSE update and animates the row that moved up', async () => {
    const initial = board([entry('1', 'alpha', 1), entry('2', 'beta', 2)]);
    const updated = board([entry('2', 'beta', 1), entry('1', 'alpha', 2)]);
    const fetcher = vi.fn().mockResolvedValue(updated);

    const { container } = render(
      <LiveLeaderboard
        initialData={initial}
        refreshPath="/v1/trending?scope=all&window=24h"
        scope="all"
        window="24h"
        streamUrl="http://api.test/v1/stream/leaderboard?scope=all&window=24h"
        fetcher={fetcher}
      />,
    );

    await waitFor(() => {
      expect(FakeEventSource.latest).toBeDefined();
    });
    const source = FakeEventSource.latest;
    if (source === undefined) throw new Error('EventSource was not created');

    act(() => {
      source.emit('open', new Event('open'));
      source.emit(
        'leaderboard.update',
        new MessageEvent('leaderboard.update', {
          data: JSON.stringify({
            scope: 'all',
            window: '24h',
            runId: 'run-2',
            movers: [],
            entered: [],
            exited: [],
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledWith('/v1/trending?scope=all&window=24h');
    });
    await waitFor(() => {
      const movedRow = container.querySelector('[data-item-id="2"]');
      expect(movedRow?.className).toContain('rank-up');
    });
    expect(screen.getByText('Live')).toBeDefined();
  });
});
