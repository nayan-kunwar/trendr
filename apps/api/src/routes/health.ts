import type { FastifyInstance } from 'fastify';

/**
 * Liveness/readiness (spec §14.4). Liveness is process-only; readiness probes
 * the dependencies required to serve traffic, including the Drizzle migration
 * journal. A probe timeout keeps a hung dependency from hanging the endpoint.
 */
const READINESS_TIMEOUT_MS = 2_000;
const MIGRATIONS_PROBE = 'SELECT 1 FROM drizzle.__drizzle_migrations LIMIT 1';

type CheckState = 'ok' | 'error';

interface ReadinessChecks {
  db: CheckState;
  redis: CheckState;
  migrations: CheckState;
}

async function withTimeout<T>(label: string, operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} readiness probe timed out`));
        }, READINESS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/healthz', () => ({ status: 'ok', uptimeSec: process.uptime() }));

  app.get('/readyz', async (_request, reply) => {
    const checks: ReadinessChecks = {
      db: 'error',
      redis: 'error',
      migrations: 'error',
    };

    if (app.hasDecorator('pool')) {
      try {
        await withTimeout('db', app.pool.query('SELECT 1'));
        checks.db = 'ok';
      } catch {
        // The degraded response reports the check without leaking driver errors.
      }
    }

    if (app.hasDecorator('redis')) {
      try {
        await withTimeout('redis', app.redis.ping());
        checks.redis = 'ok';
      } catch {
        // The degraded response reports the check without leaking driver errors.
      }
    }

    if (checks.db === 'ok' && app.hasDecorator('pool')) {
      try {
        const result = await withTimeout('migrations', app.pool.query(MIGRATIONS_PROBE));
        checks.migrations = (result.rowCount ?? 0) > 0 ? 'ok' : 'error';
      } catch {
        // Missing/unreadable migration journal means the API is not ready.
      }
    }

    const ready = checks.db === 'ok' && checks.redis === 'ok' && checks.migrations === 'ok';
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'degraded',
      checks,
    });
  });
}
