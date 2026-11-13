import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger } from './index.js';

function capturingDestination(): { chunks: string[]; stream: Writable } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { chunks, stream };
}

interface LoggedLine {
  time: unknown;
  service: string;
  env: string;
  version: string;
  msg: string;
  req: { method: string; url: string; host: string; remoteAddress: string };
  user: { email: string };
  token: string;
  GITHUB_TOKENS: string;
}

describe('createLogger', () => {
  it('redacts secrets and emails outside production, and strips request queries', () => {
    const { chunks, stream } = capturingDestination();
    const logger = createLogger({
      service: 'api',
      level: 'info',
      env: 'test',
      destination: stream,
    });

    logger.info(
      {
        req: {
          method: 'GET',
          url: '/v1/unsubscribe?token=supersecret',
          host: 'api.example.test',
          ip: '203.0.113.9',
          headers: { authorization: 'Bearer supersecret' },
        },
        user: { email: 'dev@example.com' },
        token: 'tok-1',
        GITHUB_TOKENS: ['ghp_xxxxxxxxxxxx'],
      },
      'hello',
    );

    const line = JSON.parse(chunks.join('').trim()) as LoggedLine;
    expect(line.msg).toBe('hello');
    expect(line.service).toBe('api');
    expect(line.env).toBe('test');
    expect(line.version).toBe('dev');
    expect(typeof line.time).toBe('string');
    expect(line.req).toEqual({
      method: 'GET',
      url: '/v1/unsubscribe',
      host: 'api.example.test',
      remoteAddress: '203.0.113.9',
    });
    expect(line.user.email).toBe('[REDACTED]');
    expect(line.token).toBe('[REDACTED]');
    expect(line.GITHUB_TOKENS).toBe('[REDACTED]');
  });

  it('hashes emails in production instead of removing them', () => {
    const { chunks, stream } = capturingDestination();
    const logger = createLogger({
      service: 'worker',
      level: 'info',
      env: 'production',
      destination: stream,
    });

    logger.info({ user: { email: 'dev@example.com' } }, 'digest sent');

    const line = JSON.parse(chunks.join('').trim()) as LoggedLine;
    expect(line.user.email).toMatch(/^[0-9a-f]{16}$/);
    expect(line.user.email).not.toBe('dev@example.com');
  });

  it('respects the configured level', () => {
    const { chunks, stream } = capturingDestination();
    const logger = createLogger({
      service: 'api',
      level: 'warn',
      env: 'test',
      destination: stream,
    });

    logger.info('suppressed');
    logger.warn('kept');

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('kept');
  });
});
