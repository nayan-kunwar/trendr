import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  createJsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { FastifyInstance } from 'fastify';

/** The spec pins OpenAPI 3.1 (spec §10.5). */
export const OPENAPI_VERSION = '3.1.0';

export interface OpenApiPluginOptions {
  title?: string;
  version?: string;
  /** Public API origin (env API_PUBLIC_URL); omitted → no `servers` entry. */
  serverUrl?: string;
}

/** Swagger UI routes are infrastructure, not API surface — keep them out of the document. */
const SKIP_LIST = ['/docs', '/docs/', '/docs/*', '/docs/json', '/openapi.json'];

/**
 * Wires the Zod type provider (one schema for validation, TS types and
 * OpenAPI — spec §3) and serves the OpenAPI 3.1 document at `/openapi.json`
 * with the UI at `/docs` (spec §10.1). `apps/api/openapi.json` is exported by
 * `pnpm --filter @trendr/api openapi:export` for the CI staleness check.
 *
 * Awaited by `buildApp`: `@fastify/swagger` collects routes through an
 * onRoute hook, and Fastify applies hooks only to routes registered after them.
 */
export async function registerOpenApi(
  app: FastifyInstance,
  options: OpenApiPluginOptions = {},
): Promise<void> {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      openapi: OPENAPI_VERSION,
      info: {
        title: options.title ?? 'Trendr API',
        version: options.version ?? '0.0.0',
        description:
          'Trending scores for GitHub, npm, PyPI, Hugging Face, arXiv and the MCP registry.',
      },
      ...(options.serverUrl ? { servers: [{ url: options.serverUrl }] } : {}),
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
          bearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
    },
    transform: createJsonSchemaTransform({ skipList: SKIP_LIST }),
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());
}
