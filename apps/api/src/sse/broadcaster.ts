import type { Redis } from 'ioredis';

import {
  LEADERBOARD_EVENTS_CHANNEL,
  LeaderboardUpdatedEventSchema,
  type LeaderboardScope,
  type LeaderboardUpdatedEvent,
  type Window,
} from '@trendr/core';

/**
 * Spec §10.6 — one Redis subscriber per API process fans `events:leaderboard`
 * messages out to connected SSE clients, grouped by board (`scope:window`).
 * The route layer owns headers, heartbeats, backpressure and the concurrency
 * counter; this class only routes frames.
 */

export interface LeaderboardSseClient {
  scope: LeaderboardScope;
  window: Window;
  /** Write one pre-encoded SSE frame (retry/snapshot/update/ping/shutdown). */
  send: (frame: string) => void;
  /** End the underlying stream (process shutdown). */
  end: () => void;
}

export function boardKey(scope: LeaderboardScope, window: Window): string {
  return `${scope}:${window}`;
}

/** §10.6 update frame; the wire payload drops the internal `type`/`computedAt`. */
export function updateFrame(event: LeaderboardUpdatedEvent): string {
  const data = {
    scope: event.scope,
    window: event.window,
    runId: event.runId,
    movers: event.movers,
    entered: event.entered,
    exited: event.exited,
  };
  return `id: ${event.runId}\nevent: leaderboard.update\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface BroadcasterOptions {
  /** Dedicated subscriber connection (`app.redisSub`); never quit from here. */
  subscriber: Redis;
  /** Receives messages that are not valid leaderboard events (called for logging). */
  onInvalidEvent?: (raw: string) => void;
}

/**
 * ioredis marks `subscribe` with the `loading` flag, so calling it while the
 * client is still connecting writes SUBSCRIBE in the middle of the handshake
 * (INFO/CLIENT) and loses the subscription. Wait for `ready` first; transient
 * errors are ignored (ioredis reconnects on its own), a permanent `end` rejects.
 */
function waitForReady(client: Redis): Promise<void> {
  if (client.status === 'ready') {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      client.off('ready', onReady);
      client.off('end', onEnd);
    };
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error('redis subscriber connection ended before it was ready'));
    };
    client.on('ready', onReady);
    client.on('end', onEnd);
  });
}

export class LeaderboardBroadcaster {
  private readonly clients = new Map<string, Set<LeaderboardSseClient>>();
  private readonly subscriber: Redis;
  private readonly onInvalidEvent: (raw: string) => void;
  private readonly onMessage = (channel: string, message: string): void => {
    this.route(channel, message);
  };
  private closed = false;

  constructor(options: BroadcasterOptions) {
    this.subscriber = options.subscriber;
    this.onInvalidEvent = options.onInvalidEvent ?? (() => undefined);
    this.subscriber.on('message', this.onMessage);
  }

  async subscribe(): Promise<void> {
    await waitForReady(this.subscriber);
    await this.subscriber.subscribe(LEADERBOARD_EVENTS_CHANNEL);
  }

  add(client: LeaderboardSseClient): void {
    if (this.closed) {
      return;
    }
    const key = boardKey(client.scope, client.window);
    const clients = this.clients.get(key);
    if (clients === undefined) {
      this.clients.set(key, new Set([client]));
      return;
    }
    clients.add(client);
  }

  remove(client: LeaderboardSseClient): void {
    const key = boardKey(client.scope, client.window);
    const clients = this.clients.get(key);
    if (clients === undefined) {
      return;
    }
    clients.delete(client);
    if (clients.size === 0) {
      this.clients.delete(key);
    }
  }

  /** Open streams for one board — feeds the `trendr_sse_clients` gauge. */
  size(scope: LeaderboardScope, window: Window): number {
    return this.clients.get(boardKey(scope, window))?.size ?? 0;
  }

  /** Spec §10.6 — on shutdown every stream ends with `event: shutdown`. */
  shutdown(): void {
    for (const clients of this.clients.values()) {
      for (const client of clients) {
        client.send('event: shutdown\ndata: {}\n\n');
        client.end();
      }
    }
    this.clients.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.subscriber.off('message', this.onMessage);
    // Unsubscribing while the connection is still connecting (or already gone)
    // would race the handshake / reject; the connection is torn down anyway.
    if (this.subscriber.status === 'ready') {
      await this.subscriber.unsubscribe(LEADERBOARD_EVENTS_CHANNEL);
    }
  }

  private route(channel: string, message: string): void {
    if (this.closed || channel !== LEADERBOARD_EVENTS_CHANNEL) {
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(message);
    } catch {
      this.onInvalidEvent(message);
      return;
    }
    const parsed = LeaderboardUpdatedEventSchema.safeParse(payload);
    if (!parsed.success) {
      this.onInvalidEvent(message);
      return;
    }
    const clients = this.clients.get(boardKey(parsed.data.scope, parsed.data.window));
    if (clients === undefined) {
      return;
    }
    const frame = updateFrame(parsed.data);
    for (const client of clients) {
      client.send(frame);
    }
  }
}
