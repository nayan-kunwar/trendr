import { afterEach, describe, expect, it } from 'vitest';

import { startMetricsServer } from '../../src/metrics-server.js';
import type {
  MetricsServerOptions,
  RunningMetricsServer,
  WorkerHealth,
} from '../../src/metrics-server.js';

const servers: RunningMetricsServer[] = [];

async function start(overrides: Partial<MetricsServerOptions> = {}): Promise<RunningMetricsServer> {
  const server = await startMetricsServer({
    port: 0,
    metricsToken: 'test-metrics-token',
    getHealth: () => ({ redis: 'connected', schedulerRegistered: true, lastJobByQueue: {} }),
    ...overrides,
  });
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('worker metrics server', () => {
  it('serves an open /healthz with worker state', async () => {
    const server = await start();
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as WorkerHealth & { status: string };
    expect(body).toMatchObject({ status: 'ok', redis: 'connected', schedulerRegistered: true });
  });

  it('reports redis disconnection in /healthz', async () => {
    const server = await start({
      getHealth: () => ({ redis: 'disconnected', schedulerRegistered: false, lastJobByQueue: {} }),
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(response.status).toBe(200);
    expect((await response.json()) as WorkerHealth).toMatchObject({ redis: 'disconnected' });
  });

  it('serves /readyz as readiness when redis is connected', async () => {
    const server = await start();
    const response = await fetch(`http://127.0.0.1:${server.port}/readyz`);
    expect(response.status).toBe(200);
    expect((await response.json()) as WorkerHealth & { status: string }).toMatchObject({
      status: 'ready',
      redis: 'connected',
    });
  });

  it('returns 503 from /readyz when redis is disconnected', async () => {
    const server = await start({
      getHealth: () => ({ redis: 'disconnected', schedulerRegistered: false, lastJobByQueue: {} }),
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/readyz`);
    expect(response.status).toBe(503);
    expect((await response.json()) as WorkerHealth & { status: string }).toMatchObject({
      status: 'degraded',
      redis: 'disconnected',
    });
  });

  it('requires the bearer token for /metrics', async () => {
    const server = await start();
    const denied = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    expect(denied.status).toBe(401);

    const wrong = await fetch(`http://127.0.0.1:${server.port}/metrics`, {
      headers: { authorization: 'Bearer test-metrics-tokeN' },
    });
    expect(wrong.status).toBe(401);

    const allowed = await fetch(`http://127.0.0.1:${server.port}/metrics`, {
      headers: { authorization: 'Bearer test-metrics-token' },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain('trendr_process_cpu_seconds_total');
  });

  it('answers 404 for unknown paths', async () => {
    const server = await start();
    const response = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(response.status).toBe(404);
  });
});
