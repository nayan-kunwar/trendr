import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildApp } from '../app.js';

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, unknown>;
}

const DEPS = { corsOrigins: ['http://localhost:3000'], metricsToken: 'test-metrics-token' };

describe('openapi plugin (spec §10.1, §10.5)', () => {
  it('serves the OpenAPI 3.1 document at /openapi.json', async () => {
    const app = await buildApp(DEPS);
    try {
      const response = await app.inject({ method: 'GET', url: '/openapi.json' });
      expect(response.statusCode).toBe(200);
      const document = response.json<OpenApiDocument>();
      expect(document.openapi).toBe('3.1.0');
      expect(document.info.title).toBe('Trendr API');
      expect(document.paths).toHaveProperty('/healthz');
      expect(document.paths).toHaveProperty('/readyz');
    } finally {
      await app.close();
    }
  });

  it('renders the Swagger UI at /docs', async () => {
    const app = await buildApp(DEPS);
    try {
      const response = await app.inject({ method: 'GET', url: '/docs' });
      const page = response.statusCode === 302 ? response.headers.location : '/docs';
      const rendered =
        response.statusCode === 302 && page
          ? await app.inject({ method: 'GET', url: page })
          : response;
      expect(rendered.statusCode).toBe(200);
      expect(rendered.body.toLowerCase()).toContain('swagger');
    } finally {
      await app.close();
    }
  });

  it('validates with the Zod provider and lists Zod-schema routes in the document', async () => {
    const app = await buildApp(DEPS);
    try {
      app.withTypeProvider<ZodTypeProvider>().get('/v1/ping', {
        schema: {
          querystring: z.object({ q: z.string().min(2) }),
          response: { 200: z.object({ echo: z.string() }) },
        },
        handler: (request) => ({ echo: request.query.q }),
      });

      const invalid = await app.inject({ method: 'GET', url: '/v1/ping' });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.headers['content-type']).toContain('application/problem+json');

      const valid = await app.inject({ method: 'GET', url: '/v1/ping?q=hi' });
      expect(valid.statusCode).toBe(200);
      expect(valid.json()).toEqual({ echo: 'hi' });

      const document = (await app.inject({ method: 'GET', url: '/openapi.json' })).json<
        OpenApiDocument & { paths: Record<string, { get?: { parameters?: unknown[] } }> }
      >();
      expect(document.paths).toHaveProperty('/v1/ping');
      expect(document.paths['/v1/ping']?.get?.parameters).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('keeps the UI and document routes out of the OpenAPI document', async () => {
    const app = await buildApp(DEPS);
    try {
      const document = (
        await app.inject({ method: 'GET', url: '/openapi.json' })
      ).json<OpenApiDocument>();
      expect(Object.keys(document.paths).some((path) => path.startsWith('/docs'))).toBe(false);
      expect(document.paths).not.toHaveProperty('/openapi.json');
    } finally {
      await app.close();
    }
  });
});
