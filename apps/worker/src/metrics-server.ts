import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { Registry } from 'prom-client';

import type { Logger } from '@trendr/logger';

import { createRegistry } from './metrics.js';

export interface WorkerHealth {
  redis: 'connected' | 'disconnected';
  schedulerRegistered: boolean;
  /** Last successful job timestamp per queue; populated once processors exist. */
  lastJobByQueue: Record<string, string | null>;
}

export interface MetricsServerOptions {
  port: number;
  /** Bearer token required by GET /metrics (env: METRICS_TOKEN). */
  metricsToken: string;
  /** Registry to serve; defaults to a fresh registry with process metrics. */
  registry?: Registry;
  getHealth: () => WorkerHealth;
  logger?: Logger;
}

export interface RunningMetricsServer {
  /** Actual bound port (useful with port 0 in tests). */
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Worker observability endpoint (spec §14.4): `:9464/healthz` is open liveness,
 * `:9464/readyz` is open dependency readiness (503 when Redis is down), and
 * `:9464/metrics` requires `Authorization: Bearer ${METRICS_TOKEN}`.
 * The port is exposed to the Docker network only, never published on the host.
 */
export async function startMetricsServer(
  options: MetricsServerOptions,
): Promise<RunningMetricsServer> {
  const registry = options.registry ?? createRegistry();

  const server = createServer((request, response) => {
    void handleRequest(request, response, options, registry);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: MetricsServerOptions,
  registry: Registry,
): Promise<void> {
  try {
    if ((request.method ?? 'GET') !== 'GET') {
      response.writeHead(405, { allow: 'GET', 'content-type': 'text/plain; charset=utf-8' });
      response.end('method not allowed');
      return;
    }
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    switch (path) {
      case '/healthz': {
        respond(
          response,
          200,
          'application/json; charset=utf-8',
          JSON.stringify({ status: 'ok', ...options.getHealth() }),
        );
        return;
      }
      case '/readyz': {
        const health = options.getHealth();
        const ready = health.redis === 'connected';
        respond(
          response,
          ready ? 200 : 503,
          'application/json; charset=utf-8',
          JSON.stringify({ status: ready ? 'ready' : 'degraded', ...health }),
        );
        return;
      }
      case '/metrics': {
        if (request.headers.authorization !== `Bearer ${options.metricsToken}`) {
          respond(
            response,
            401,
            'application/json; charset=utf-8',
            JSON.stringify({ error: 'unauthorized' }),
          );
          return;
        }
        const body = await registry.metrics();
        respond(response, 200, registry.contentType, body);
        return;
      }
      default: {
        respond(
          response,
          404,
          'application/json; charset=utf-8',
          JSON.stringify({ error: 'not-found' }),
        );
      }
    }
  } catch (error: unknown) {
    options.logger?.error({ err: error }, 'metrics server request failed');
    if (response.headersSent) {
      response.end();
    } else {
      respond(
        response,
        500,
        'application/json; charset=utf-8',
        JSON.stringify({ error: 'internal-error' }),
      );
    }
  }
}

function respond(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  response.end(body);
}
