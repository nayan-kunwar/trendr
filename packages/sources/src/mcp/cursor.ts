import { redisKeys } from '@trendr/core';
import type { Redis } from 'ioredis';

/**
 * Spec §7.3.6 — the registry cursor is the maximum `updatedAt` seen in a
 * complete pass. It lives in Redis (`mcp:registry:cursor_ts`) rather than
 * Postgres so a failed pass never advances it; the next incremental run
 * replays from the last complete watermark.
 */
export interface McpCursorStore {
  get(): Promise<Date | null>;
  set(cursor: Date): Promise<void>;
}

export function createRedisMcpCursorStore(redis: Redis): McpCursorStore {
  return {
    async get() {
      const value = await redis.get(redisKeys.mcpRegistryCursor());
      if (value === null) return null;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    },
    async set(cursor) {
      await redis.set(redisKeys.mcpRegistryCursor(), cursor.toISOString());
    },
  };
}
