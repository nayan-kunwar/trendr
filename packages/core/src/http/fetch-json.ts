import { createHash } from 'node:crypto';

import type { ZodType } from 'zod';

import { UpstreamError } from '../errors.js';
import type { RedisTokenBucket } from '../rate-limit/token-bucket.js';
import { backoffDelay } from './backoff.js';

/**
 * Spec §7.5 `fetch-json` + §15 SSRF rule: workers may only call the allowlisted
 * upstream hosts, over https, and never follow redirects off the allowlist.
 */
export const ALLOWED_UPSTREAM_HOSTS: ReadonlySet<string> = new Set([
  'api.github.com',
  'registry.npmjs.org',
  'api.npmjs.org',
  'pypi.org',
  'pypistats.org',
  'huggingface.co',
  'export.arxiv.org',
  'registry.modelcontextprotocol.io',
]);

/** `kind` label of `trendr_source_api_errors_total` (spec §12). */
export type SourceApiErrorKind = 'rate_limited' | 'server' | 'client' | 'network' | 'schema';

/**
 * The spec's `trendr_source_api_requests_total{source,endpoint,status}`,
 * `…_errors_total{source,endpoint,kind}` and `…_duration_seconds{source,endpoint}`
 * as a tiny sink so `@trendr/core` keeps its zero-dependency rule; the worker
 * adapts its prom-client registry to this interface.
 */
export interface FetchJsonMetricsSink {
  request(source: string, endpoint: string, status: string): void;
  error(source: string, endpoint: string, kind: SourceApiErrorKind): void;
  duration(source: string, endpoint: string, seconds: number): void;
}

export interface FetchJsonOptions<T> {
  url: string;
  schema: ZodType<T>;
  bucket: Pick<RedisTokenBucket, 'take' | 'pauseUntil'>;
  source: string;
  endpoint: string;
  /**
   * Body parser. JSON is the default; PyPI RSS discovery is XML, so the
   * adapter reads the body as text and parses it with fast-xml-parser.
   */
  responseType?: 'json' | 'text';
  /** `env.HTTP_USER_AGENT` — core does not read env; the caller passes it. */
  userAgent: string;
  cost?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
  maxAttempts?: number;
  etag?: string | null;
  /** Rate-limit header feedback (§7.4); may pause the bucket. */
  onHeaders?: (headers: Headers) => void | Promise<void>;
  metrics?: FetchJsonMetricsSink;
  signal?: AbortSignal;
  /** In-process retry window (§7.5 default: base 500 ms, cap 10 s). */
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

export type FetchJsonResult<T> =
  | { status: 'ok'; data: T; etag: string | null; headers: Headers }
  | { status: 'not_modified'; headers: Headers }
  | { status: 'not_found'; headers: Headers };

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const RATE_LIMIT_FALLBACK_MS = 60_000;

function assertAllowedUrl(raw: string, source: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UpstreamError(`invalid upstream url: ${raw}`, source, null, null, false);
  }
  if (url.protocol !== 'https:') {
    throw new UpstreamError(`upstream url must be https: ${raw}`, source, null, null, false);
  }
  if (!ALLOWED_UPSTREAM_HOSTS.has(url.hostname)) {
    throw new UpstreamError(
      `upstream host not allowed: ${url.hostname}`,
      source,
      null,
      null,
      false,
    );
  }
  return url;
}

function buildHeaders<T>(options: FetchJsonOptions<T>): Headers {
  const headers = new Headers(options.headers);
  if (!headers.has('accept')) {
    headers.set('accept', 'application/json');
  }
  headers.set('user-agent', options.userAgent);
  if (options.etag !== undefined && options.etag !== null && options.etag !== '') {
    headers.set('if-none-match', options.etag);
  }
  return headers;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      const reason: unknown = signal.reason;
      // The abort reason is re-thrown verbatim (a DOMException) so callers can
      // tell aborts apart from upstream failures.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      const reason: unknown = signal?.reason;
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isRateLimitResponse(response: Response): boolean {
  if (response.status === 429) {
    return true;
  }
  if (response.status !== 403) {
    return false;
  }
  return (
    response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'
  );
}

/**
 * retry-after (s or HTTP-date) → x-ratelimit-reset (epoch s) → 60 s (§7.4).
 * A zero or already-past value means "retry now" to some upstreams — Cloudflare
 * sends `Retry-After: 0` on a mitigation that actually lasts about a minute —
 * and pausing for 1 ms lets the retry extend the block, so those fall back too.
 */
function rateLimitDelayMs(headers: Headers, now = Date.now()): number {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return seconds > 0 ? Math.round(seconds * 1000) : RATE_LIMIT_FALLBACK_MS;
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      const delay = date - now;
      return delay > 0 ? delay : RATE_LIMIT_FALLBACK_MS;
    }
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset !== null) {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds) && epochSeconds > 0) {
      const delay = epochSeconds * 1000 - now;
      return delay > 0 ? delay : RATE_LIMIT_FALLBACK_MS;
    }
  }
  return RATE_LIMIT_FALLBACK_MS;
}

function formatIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function sampleHash(payload: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    serialized = String(payload);
  }
  return createHash('sha256').update(serialized).digest('hex').slice(0, 12);
}

async function performFetch<T>(
  url: URL,
  options: FetchJsonOptions<T>,
  timeoutMs: number,
): Promise<Response> {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (options.signal !== undefined) {
    signals.push(options.signal);
  }
  const headers = buildHeaders(options);
  const method = options.method ?? 'GET';
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.any(signals),
    // §15: a redirect could leave the allowlist, so never follow one.
    redirect: 'manual',
  };
  if (method !== 'GET' && options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
  }
  return fetch(url, init);
}

/**
 * One JSON request against an allowlisted upstream: token-bucket gated, with
 * in-process retries for network errors and 5xx, ETag-aware and status mapped
 * to the `FetchJsonResult` union. `UpstreamError.retryable` decides whether the
 * surrounding BullMQ job retries (§7.5).
 */
export async function fetchJson<T>(options: FetchJsonOptions<T>): Promise<FetchJsonResult<T>> {
  const url = assertAllowedUrl(options.url, options.source);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseMs = options.backoffBaseMs ?? 500;
  const capMs = options.backoffCapMs ?? 10_000;

  for (let attempt = 0; ; attempt += 1) {
    await options.bucket.take(options.cost ?? 1, options.signal);

    const startedAt = performance.now();
    let response: Response;
    try {
      response = await performFetch(url, options, timeoutMs);
    } catch (error) {
      options.metrics?.duration(
        options.source,
        options.endpoint,
        (performance.now() - startedAt) / 1000,
      );
      options.metrics?.request(options.source, options.endpoint, 'network');
      options.metrics?.error(options.source, options.endpoint, 'network');
      if (options.signal?.aborted === true) {
        throw error;
      }
      if (attempt + 1 < maxAttempts) {
        await delay(backoffDelay(attempt, baseMs, capMs), options.signal);
        continue;
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new UpstreamError(
        `network error fetching ${url.href}: ${detail}`,
        options.source,
        null,
        null,
        true,
      );
    }

    options.metrics?.duration(
      options.source,
      options.endpoint,
      (performance.now() - startedAt) / 1000,
    );
    options.metrics?.request(options.source, options.endpoint, String(response.status));
    await options.onHeaders?.(response.headers);

    if (response.status === 304) {
      return { status: 'not_modified', headers: response.headers };
    }
    if (response.status === 404 || response.status === 410) {
      return { status: 'not_found', headers: response.headers };
    }
    if (isRateLimitResponse(response)) {
      const retryAfterMs = rateLimitDelayMs(response.headers);
      await options.bucket.pauseUntil(Date.now() + retryAfterMs);
      options.metrics?.error(options.source, options.endpoint, 'rate_limited');
      throw new UpstreamError(
        `rate limited by ${url.hostname} (${response.status})`,
        options.source,
        response.status,
        retryAfterMs,
        true,
      );
    }
    if (response.status >= 500) {
      options.metrics?.error(options.source, options.endpoint, 'server');
      if (attempt + 1 < maxAttempts) {
        await delay(backoffDelay(attempt, baseMs, capMs), options.signal);
        continue;
      }
      throw new UpstreamError(
        `server error from ${url.hostname} (${response.status})`,
        options.source,
        response.status,
        null,
        true,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      options.metrics?.error(options.source, options.endpoint, 'client');
      throw new UpstreamError(
        `unexpected ${response.status} redirect from ${url.hostname}`,
        options.source,
        response.status,
        null,
        false,
      );
    }
    if (response.status >= 400) {
      options.metrics?.error(options.source, options.endpoint, 'client');
      throw new UpstreamError(
        `unexpected ${response.status} from ${url.hostname}`,
        options.source,
        response.status,
        null,
        false,
      );
    }

    let payload: unknown;
    try {
      payload = options.responseType === 'text' ? await response.text() : await response.json();
    } catch {
      options.metrics?.error(options.source, options.endpoint, 'schema');
      throw new UpstreamError(
        `invalid ${options.responseType === 'text' ? 'text' : 'JSON'} body from ${url.hostname}`,
        options.source,
        response.status,
        null,
        false,
      );
    }
    const parsed = options.schema.safeParse(payload);
    if (!parsed.success) {
      options.metrics?.error(options.source, options.endpoint, 'schema');
      throw new UpstreamError(
        `schema mismatch from ${url.hostname}: ${formatIssues(parsed.error)} (payload sha256=${sampleHash(payload)})`,
        options.source,
        response.status,
        null,
        false,
      );
    }
    return {
      status: 'ok',
      data: parsed.data,
      etag: response.headers.get('etag'),
      headers: response.headers,
    };
  }
}
