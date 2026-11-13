import { createHash } from 'node:crypto';

import { pino } from 'pino';
import type { DestinationStream, Logger, LoggerOptions } from 'pino';

export type { Logger } from 'pino';

export type ServiceName = 'api' | 'worker' | 'mcp' | 'web';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface CreateLoggerOptions {
  service: ServiceName;
  /** Defaults to `LOG_LEVEL`, then `info`. */
  level?: LogLevel;
  /** Defaults to `NODE_ENV`, then `development`. */
  env?: string;
  /** Git sha baked in at build/CI time (`GIT_SHA`); defaults to `dev`. */
  version?: string;
  /** Custom destination (tests, Fastify's own stream). Skips `pino-pretty`. */
  destination?: DestinationStream;
}

export const REDACTED = '[REDACTED]';

/** Production email redaction keeps logs joinable without storing PII (spec §14.3). */
export function hashEmail(value: unknown): string {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

const SECRET_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'token',
  '*.token',
  'GITHUB_TOKENS',
  '*.GITHUB_TOKENS',
];

const EMAIL_PATHS = ['email', '*.email'];

/**
 * Pino 10 accepts one redact config with a single censor, so the per-path
 * decision lives here: emails are hashed in production, everything else is
 * censored with `[REDACTED]`.
 */
function makeRedactionCensor(env: string) {
  return (value: unknown, path: string[]): string => {
    if (path.at(-1) === 'email') {
      return env === 'production' ? hashEmail(value) : REDACTED;
    }
    return REDACTED;
  };
}

/**
 * Access logs must not retain bearer material in query strings. Magic-link,
 * unsubscribe, OAuth code/state and API-key test secrets all travel as query
 * parameters in at least one flow; the path is enough for operations.
 */
export function redactRequestUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const query = raw.indexOf('?');
  return query === -1 ? raw : raw.slice(0, query);
}

interface RequestLike {
  method?: unknown;
  url?: unknown;
  host?: unknown;
  ip?: unknown;
  socket?: { remotePort?: unknown } | null;
}

/** Fastify's default `req` serializer, with the query string removed. */
export function serializeRequest(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {};
  const request = value as RequestLike;
  const url = redactRequestUrl(request.url);
  const remotePort = request.socket?.remotePort;
  return {
    method: request.method,
    ...(url === undefined ? {} : { url }),
    host: request.host,
    remoteAddress: request.ip,
    ...(remotePort === undefined ? {} : { remotePort }),
  };
}

/**
 * Pino options shared by `createLogger` and Fastify's built-in logger (0.5):
 * JSON with `level, time, service, env, version, msg` and secret redaction.
 */
export function buildLoggerOptions(options: CreateLoggerOptions): LoggerOptions {
  const env = options.env ?? process.env.NODE_ENV ?? 'development';
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info';
  const version = options.version ?? process.env.GIT_SHA ?? 'dev';
  return {
    level,
    base: { service: options.service, env, version },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [...SECRET_PATHS, ...EMAIL_PATHS],
      censor: makeRedactionCensor(env),
    },
    // Fastify logs `{ req: request }` for every request. Its default serializer
    // keeps the raw URL (including `?token=`); this one keeps the path only.
    serializers: {
      req: serializeRequest,
    },
  };
}

/**
 * The only logger factory in the repo (spec §14.3, rule: no `console.log`).
 * JSON in production/test; `pino-pretty` in development only.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const env = options.env ?? process.env.NODE_ENV ?? 'development';
  const loggerOptions = buildLoggerOptions(options);
  if (options.destination) {
    return pino(loggerOptions, options.destination);
  }
  if (env === 'development') {
    return pino({
      ...loggerOptions,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
      },
    });
  }
  return pino(loggerOptions);
}
