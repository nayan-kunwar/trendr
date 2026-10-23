import type { FastifyError, FastifyInstance } from 'fastify';

import { AppError } from '@trendr/core';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  requestId: string;
  errors?: { path: string; message: string }[];
}

const PROBLEMS_BASE = 'https://trendr.dev/problems/';

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  410: 'Gone',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

const TYPE_BY_STATUS: Record<number, string> = {
  400: 'validation-error',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  409: 'conflict',
  422: 'query-too-broad',
  429: 'rate-limited',
  500: 'internal-error',
  503: 'unavailable',
};

/**
 * RFC 7807 problem+json for every error and unmatched route (spec §5.3, §10.2).
 * Validation errors from Fastify's schema compiler keep their `errors[]` list;
 * 5xx responses never leak internal messages.
 */
export function registerErrors(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    reply
      .status(404)
      .type('application/problem+json')
      .send({
        type: `${PROBLEMS_BASE}not-found`,
        title: 'Not Found',
        status: 404,
        detail: `Route ${request.method} ${request.url} not found`,
        instance: request.url,
        requestId: request.id,
      } satisfies ProblemDetails);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = resolveStatus(error);
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
    }
    const body: ProblemDetails = {
      type: `${PROBLEMS_BASE}${resolveType(error, status)}`,
      title: TITLES[status] ?? 'Error',
      status,
      instance: request.url,
      requestId: request.id,
    };
    const detail = resolveDetail(error, status);
    if (detail !== undefined) {
      body.detail = detail;
    }
    const issues = resolveValidationIssues(error);
    if (issues) {
      body.errors = issues;
    }
    if (status === 429 && !reply.hasHeader('retry-after')) {
      reply.header('retry-after', '60');
    }
    reply.status(status).type('application/problem+json').send(body);
  });
}

function resolveStatus(error: FastifyError): number {
  if (error instanceof AppError) {
    return error.status;
  }
  const { statusCode } = error;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 599) {
    return statusCode;
  }
  return 500;
}

function resolveType(error: FastifyError, status: number): string {
  if (error instanceof AppError) {
    return error.type;
  }
  return TYPE_BY_STATUS[status] ?? (status >= 500 ? 'internal-error' : 'validation-error');
}

function resolveDetail(error: FastifyError, status: number): string | undefined {
  if (error instanceof AppError) {
    return error.message;
  }
  if (status >= 500) {
    return undefined; // never leak internals
  }
  return error.message;
}

function resolveValidationIssues(error: FastifyError): ProblemDetails['errors'] {
  const validation = error.validation;
  if (!validation?.length) {
    return undefined;
  }
  return validation.map((issue) => {
    const missing = issue.params.missingProperty;
    return {
      path: issue.instancePath || (typeof missing === 'string' ? missing : '(body)'),
      message: issue.message ?? 'invalid value',
    };
  });
}
