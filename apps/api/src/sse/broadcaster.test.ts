import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import {
  LEADERBOARD_EVENTS_CHANNEL,
  LeaderboardUpdatedEventSchema,
  type LeaderboardScope,
  type Window,
} from '@trendr/core';

import {
  LeaderboardBroadcaster,
  boardKey,
  updateFrame,
  type LeaderboardSseClient,
} from './broadcaster.js';

/** Stand-in for `app.redisSub`: records handlers and lets tests emit events. */
class FakeSubscriber {
  status = 'ready';
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  readonly subscribed: string[] = [];
  readonly unsubscribed: string[] = [];

  on(event: string, handler: (...args: unknown[]) => void): this {
    const handlers = this.handlers.get(event) ?? new Set<(...args: unknown[]) => void>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  off(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  subscribe(channel: string): Promise<void> {
    this.subscribed.push(channel);
    return Promise.resolve();
  }

  unsubscribe(channel: string): Promise<void> {
    this.unsubscribed.push(channel);
    return Promise.resolve();
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      handler(...args);
    }
  }

  emitMessage(channel: string, message: string): void {
    this.emit('message', channel, message);
  }
}

interface TestClient extends LeaderboardSseClient {
  frames: string[];
  ended: boolean;
}

function testClient(scope: LeaderboardScope, window: Window): TestClient {
  const client: TestClient = {
    scope,
    window,
    frames: [],
    ended: false,
    send(frame) {
      client.frames.push(frame);
    },
    end() {
      client.ended = true;
    },
  };
  return client;
}

function updateMessage(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    LeaderboardUpdatedEventSchema.parse({
      type: 'leaderboard.updated',
      scope: 'github',
      window: '24h',
      runId: '81240',
      computedAt: '2026-10-19T10:00:00.000Z',
      movers: [{ itemId: '123', rank: 1, prevRank: 7, delta: 412 }],
      entered: ['456'],
      exited: ['789'],
      ...overrides,
    }),
  );
}

function setup(): {
  broadcaster: LeaderboardBroadcaster;
  subscriber: FakeSubscriber;
  onInvalidEvent: ReturnType<typeof vi.fn>;
} {
  const subscriber = new FakeSubscriber();
  const onInvalidEvent = vi.fn();
  const broadcaster = new LeaderboardBroadcaster({
    subscriber: subscriber as unknown as Redis,
    onInvalidEvent,
  });
  return { broadcaster, subscriber, onInvalidEvent };
}

describe('LeaderboardBroadcaster (spec §10.6)', () => {
  it('subscribes the process-wide subscriber to events:leaderboard', async () => {
    const { broadcaster, subscriber } = setup();
    await broadcaster.subscribe();
    expect(subscriber.subscribed).toEqual([LEADERBOARD_EVENTS_CHANNEL]);
  });

  it('defers the subscription until the connection is ready', async () => {
    const { broadcaster, subscriber } = setup();
    subscriber.status = 'connect';
    const pending = broadcaster.subscribe();
    expect(subscriber.subscribed).toEqual([]);

    subscriber.status = 'ready';
    subscriber.emit('ready');
    await expect(pending).resolves.toBeUndefined();
    expect(subscriber.subscribed).toEqual([LEADERBOARD_EVENTS_CHANNEL]);
  });

  it('rejects when the connection ends before it is ready', async () => {
    const { broadcaster, subscriber } = setup();
    subscriber.status = 'connect';
    const pending = broadcaster.subscribe();
    subscriber.emit('end');
    await expect(pending).rejects.toThrow('ended before it was ready');
  });

  it('fans a valid update out to the matching board only', () => {
    const { broadcaster, subscriber } = setup();
    const github = testClient('github', '24h');
    const npm = testClient('npm', '24h');
    const github7d = testClient('github', '7d');
    broadcaster.add(github);
    broadcaster.add(npm);
    broadcaster.add(github7d);

    subscriber.emitMessage(LEADERBOARD_EVENTS_CHANNEL, updateMessage());

    expect(github.frames).toHaveLength(1);
    expect(npm.frames).toHaveLength(0);
    expect(github7d.frames).toHaveLength(0);
    const frame = github.frames[0] ?? '';
    expect(frame).toContain('id: 81240');
    expect(frame).toContain('event: leaderboard.update');
    expect(frame.endsWith('\n\n')).toBe(true);
    const data = frame.slice(frame.indexOf('data: ') + 'data: '.length).trimEnd();
    expect(JSON.parse(data)).toEqual({
      scope: 'github',
      window: '24h',
      runId: '81240',
      movers: [{ itemId: '123', rank: 1, prevRank: 7, delta: 412 }],
      entered: ['456'],
      exited: ['789'],
    });
  });

  it('reports malformed or schema-invalid messages and delivers nothing', () => {
    const { broadcaster, subscriber, onInvalidEvent } = setup();
    const client = testClient('github', '24h');
    broadcaster.add(client);

    subscriber.emitMessage(LEADERBOARD_EVENTS_CHANNEL, 'not json');
    subscriber.emitMessage(
      LEADERBOARD_EVENTS_CHANNEL,
      JSON.stringify({ type: 'leaderboard.updated', scope: 'github' }),
    );

    expect(client.frames).toHaveLength(0);
    expect(onInvalidEvent).toHaveBeenCalledTimes(2);
  });

  it('ignores messages on other channels', () => {
    const { broadcaster, subscriber, onInvalidEvent } = setup();
    const client = testClient('github', '24h');
    broadcaster.add(client);
    subscriber.emitMessage('events:other', updateMessage());
    expect(client.frames).toHaveLength(0);
    expect(onInvalidEvent).not.toHaveBeenCalled();
  });

  it('tracks membership per board and stops delivery after remove', () => {
    const { broadcaster, subscriber } = setup();
    const first = testClient('github', '24h');
    const second = testClient('github', '24h');
    broadcaster.add(first);
    broadcaster.add(second);
    expect(broadcaster.size('github', '24h')).toBe(2);

    broadcaster.remove(first);
    expect(broadcaster.size('github', '24h')).toBe(1);
    subscriber.emitMessage(LEADERBOARD_EVENTS_CHANNEL, updateMessage());

    expect(first.frames).toHaveLength(0);
    expect(second.frames).toHaveLength(1);
  });

  it('ends every stream with event: shutdown and clears the map', () => {
    const { broadcaster } = setup();
    const client = testClient('all', '7d');
    broadcaster.add(client);

    broadcaster.shutdown();

    expect(client.frames).toEqual(['event: shutdown\ndata: {}\n\n']);
    expect(client.ended).toBe(true);
    expect(broadcaster.size('all', '7d')).toBe(0);
  });

  it('unsubscribes on close and stops routing', async () => {
    const { broadcaster, subscriber } = setup();
    const client = testClient('github', '24h');
    broadcaster.add(client);
    await broadcaster.close();

    expect(subscriber.unsubscribed).toEqual([LEADERBOARD_EVENTS_CHANNEL]);
    subscriber.emitMessage(LEADERBOARD_EVENTS_CHANNEL, updateMessage());
    expect(client.frames).toHaveLength(0);
  });

  it('builds stable board keys and update frames', () => {
    expect(boardKey('all', '30d')).toBe('all:30d');
    const frame = updateFrame({
      type: 'leaderboard.updated',
      scope: 'npm',
      window: '7d',
      runId: '9',
      computedAt: '2026-10-19T10:00:00.000Z',
      movers: [],
      entered: [],
      exited: [],
    });
    expect(frame).toBe(
      'id: 9\nevent: leaderboard.update\ndata: {"scope":"npm","window":"7d","runId":"9","movers":[],"entered":[],"exited":[]}\n\n',
    );
  });
});
