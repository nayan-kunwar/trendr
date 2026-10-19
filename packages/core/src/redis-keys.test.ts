import { describe, expect, it } from 'vitest';

import { API_RATE_LIMIT_KEY_PREFIX, LEADERBOARD_EVENTS_CHANNEL, redisKeys } from './redis-keys.js';

describe('redisKeys (spec §9.1)', () => {
  it('builds leaderboard keys with _all as the default language', () => {
    expect(redisKeys.leaderboard('github', '24h')).toBe('lb:github:24h:_all');
    expect(redisKeys.leaderboard('all', '7d', 'python')).toBe('lb:all:7d:python');
    expect(redisKeys.leaderboard('npm', '30d', 'typescript')).toBe('lb:npm:30d:typescript');
  });

  it('builds leaderboard metadata keys', () => {
    expect(redisKeys.leaderboardMeta('npm', '30d')).toBe('lbmeta:npm:30d');
    expect(redisKeys.leaderboardMeta('all', '24h')).toBe('lbmeta:all:24h');
  });

  it('builds card and item keys from bigint or string ids', () => {
    expect(redisKeys.card(123n, '24h')).toBe('card:123:24h');
    expect(redisKeys.card('123', '7d')).toBe('card:123:7d');
    expect(redisKeys.item(42n)).toBe('item:42');
    expect(redisKeys.item('42')).toBe('item:42');
  });

  it('builds history keys', () => {
    expect(redisKeys.history(7n, 'stars', 'hour', '14d')).toBe('hist:7:stars:hour:14d');
    expect(redisKeys.history('7', 'downloads', 'day', '90d')).toBe('hist:7:downloads:day:90d');
  });

  it('hashes queries with sha1', () => {
    // sha1('') is a well-known vector; the rest of the key is the hex digest.
    expect(redisKeys.queryCache('')).toBe('q:da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });

  it('queryCache is deterministic and distinct per query', () => {
    const a = redisKeys.queryCache('source=github&topic=ai');
    const b = redisKeys.queryCache('source=github&topic=ai');
    const c = redisKeys.queryCache('source=github&topic=llm');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.slice(2)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('builds upstream token-bucket keys', () => {
    expect(redisKeys.rateBucket('github-graphql')).toBe('rl:github-graphql');
    expect(redisKeys.ratePause('github-graphql')).toBe('rl:github-graphql:pause');
  });

  it('builds worker bookkeeping keys', () => {
    expect(redisKeys.etagGithub(9n)).toBe('etag:github:9');
    expect(redisKeys.scoreLock('pypi')).toBe('lock:score:pypi');
    expect(redisKeys.arxivConnectionLock()).toBe('lock:arxiv:conn');
    expect(redisKeys.mcpRegistryCursor()).toBe('mcp:registry:cursor_ts');
  });

  it('builds the api-key last-used debounce key', () => {
    expect(redisKeys.apiKeyLastUsed('key-1')).toBe('apikey:last-used:key-1');
  });

  it('builds the SSE concurrency counter key', () => {
    expect(redisKeys.sseConnections('ip:127.0.0.1')).toBe('apirl:sse:ip:127.0.0.1');
    expect(redisKeys.sseConnections('key:abc')).toBe('apirl:sse:key:abc');
  });

  it('exports the inbound rate-limit prefix and the events channel', () => {
    expect(API_RATE_LIMIT_KEY_PREFIX).toBe('apirl:');
    expect(LEADERBOARD_EVENTS_CHANNEL).toBe('events:leaderboard');
  });
});
