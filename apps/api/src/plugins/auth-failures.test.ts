import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import {
  authFailureBudgetExhausted,
  clearAuthFailureMemory,
  noteAuthFailure,
  type AuthFailureOptions,
} from './auth-failures.js';

const OPTIONS: AuthFailureOptions = {
  trustProxy: false,
  trustCfConnectingIp: false,
  max: 2,
  windowSeconds: 60,
};

function request(ip: string): FastifyRequest {
  return { headers: {}, ip } as unknown as FastifyRequest;
}

describe('failed-credential guard (ADR-0035)', () => {
  it('counts failures only and throttles after the per-IP budget', async () => {
    clearAuthFailureMemory();
    const app = Fastify();
    try {
      const req = request('203.0.113.10');
      expect(await authFailureBudgetExhausted(app, req, 'bearer', OPTIONS)).toBe(false);
      await noteAuthFailure(app, req, 'bearer', OPTIONS);
      await noteAuthFailure(app, req, 'bearer', OPTIONS);
      expect(await authFailureBudgetExhausted(app, req, 'bearer', OPTIONS)).toBe(true);
      // A different IP and a different credential kind keep separate budgets.
      expect(
        await authFailureBudgetExhausted(app, request('203.0.113.11'), 'bearer', OPTIONS),
      ).toBe(false);
      expect(await authFailureBudgetExhausted(app, req, 'api-key', OPTIONS)).toBe(false);
    } finally {
      clearAuthFailureMemory();
      await app.close();
    }
  });

  it('uses Redis when available', async () => {
    const app = Fastify();
    let count = 0;
    const redis = {
      get: (): Promise<string | null> => Promise.resolve(String(count)),
      eval: (): Promise<number> => {
        count += 1;
        return Promise.resolve(count);
      },
    };
    app.decorate('redis', redis as unknown as Redis);
    try {
      const req = request('203.0.113.12');
      await noteAuthFailure(app, req, 'api-key', OPTIONS);
      await noteAuthFailure(app, req, 'api-key', OPTIONS);
      expect(await authFailureBudgetExhausted(app, req, 'api-key', OPTIONS)).toBe(true);
      expect(count).toBe(2);
    } finally {
      await app.close();
    }
  });
});
