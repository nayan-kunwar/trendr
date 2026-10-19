import { afterEach, describe, expect, it, vi } from 'vitest';

import { z } from 'zod';

import { UpstreamError } from '../errors.js';
import type { RedisTokenBucket } from '../rate-limit/token-bucket.js';
import {
  ALLOWED_UPSTREAM_HOSTS,
  fetchJson,
  type FetchJsonMetricsSink,
  type FetchJsonOptions,
} from './fetch-json.js';

const SCHEMA = z.object({ value: z.number() });
type Payload = z.infer<typeof SCHEMA>;

function bucketSpy(): {
  take: ReturnType<typeof vi.fn>;
  pauseUntil: ReturnType<typeof vi.fn>;
} & Pick<RedisTokenBucket, 'take' | 'pauseUntil'> {
  return {
    take: vi.fn((): Promise<void> => Promise.resolve()),
    pauseUntil: vi.fn((): Promise<void> => Promise.resolve()),
  };
}

function metricsSpy(): {
  sink: FetchJsonMetricsSink;
  request: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  duration: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn();
  const error = vi.fn();
  const duration = vi.fn();
  return { sink: { request, error, duration }, request, error, duration };
}

function options(overrides: Partial<FetchJsonOptions<Payload>> = {}): FetchJsonOptions<Payload> {
  return {
    url: 'https://api.github.com/repos/acme/widget',
    schema: SCHEMA,
    bucket: bucketSpy(),
    source: 'github',
    endpoint: 'repos',
    userAgent: 'Trendr/test (+https://example.test)',
    ...overrides,
  };
}

function respond(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** `vi.fn` implementation for a fixed response, without an `async` no-op. */
function respondWith(...args: [unknown, number, Record<string, string>?]): () => Promise<Response> {
  return () => Promise.resolve(respond(...args));
}

/** fetch that only settles when its signal aborts (timeout / caller abort). */
function hangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    if (signal?.aborted === true) {
      throw signal.reason;
    }
    await new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        // Mimics real fetch: rejects with the signal's reason verbatim.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(signal.reason);
      });
    });
    return respond({ value: 1 }, 200);
  });
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetchJson (spec §7.5)', () => {
  it('returns parsed data with the etag and records metrics', async () => {
    const bucket = bucketSpy();
    const metrics = metricsSpy();
    const onHeaders = vi.fn();
    const fetchMock = vi.fn(respondWith({ value: 7 }, 200, { etag: 'W/"abc"' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchJson(
      options({ bucket, metrics: metrics.sink, onHeaders, cost: 2, etag: 'W/"old"' }),
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.data).toEqual({ value: 7 });
    expect(result.etag).toBe('W/"abc"');
    expect(bucket.take).toHaveBeenCalledWith(2, undefined);

    const call = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(call[0])).toBe('https://api.github.com/repos/acme/widget');
    const headers = new Headers(call[1].headers);
    expect(headers.get('user-agent')).toBe('Trendr/test (+https://example.test)');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('if-none-match')).toBe('W/"old"');
    expect(call[1].redirect).toBe('manual');

    expect(onHeaders).toHaveBeenCalledWith(result.headers);
    expect(metrics.request).toHaveBeenCalledWith('github', 'repos', '200');
    expect(metrics.duration).toHaveBeenCalledWith('github', 'repos', expect.any(Number));
    expect(metrics.error).not.toHaveBeenCalled();
  });

  it('sends a JSON body with content-type for POST without overriding explicit headers', async () => {
    const fetchMock = vi.fn(respondWith({ value: 1 }, 200));
    vi.stubGlobal('fetch', fetchMock);

    await fetchJson(
      options({
        method: 'POST',
        body: { query: 'x' },
        headers: { accept: 'application/vnd.github+json' },
      }),
    );

    const call = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(call[1].method).toBe('POST');
    expect(call[1].body).toBe(JSON.stringify({ query: 'x' }));
    const headers = new Headers(call[1].headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('accept')).toBe('application/vnd.github+json');
  });

  it('throws a non-retryable hashed error on schema mismatch', async () => {
    const metrics = metricsSpy();
    vi.stubGlobal('fetch', vi.fn(respondWith({ value: 'nope' }, 200)));

    const error = await failure(fetchJson(options({ metrics: metrics.sink })));

    expect(error).toBeInstanceOf(UpstreamError);
    const upstream = error as UpstreamError;
    expect(upstream.retryable).toBe(false);
    expect(upstream.status).toBe(200);
    expect(upstream.message).toContain('schema mismatch');
    expect(upstream.message).toMatch(/sha256=[0-9a-f]{12}/);
    expect(metrics.error).toHaveBeenCalledWith('github', 'repos', 'schema');
  });

  it('throws a non-retryable error on an invalid JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))),
    );

    const error = await failure(fetchJson(options()));

    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).retryable).toBe(false);
    expect((error as UpstreamError).message).toContain('invalid JSON body');
  });

  it('maps 304 to not_modified', async () => {
    const metrics = metricsSpy();
    vi.stubGlobal('fetch', vi.fn(respondWith(null, 304)));

    const result = await fetchJson(options({ etag: 'W/"cached"', metrics: metrics.sink }));

    expect(result.status).toBe('not_modified');
    expect(metrics.request).toHaveBeenCalledWith('github', 'repos', '304');
    expect(metrics.error).not.toHaveBeenCalled();
  });

  it('maps 404 and 410 to not_found', async () => {
    vi.stubGlobal('fetch', vi.fn(respondWith({ message: 'gone' }, 404)));
    expect((await fetchJson(options())).status).toBe('not_found');

    vi.stubGlobal('fetch', vi.fn(respondWith({ message: 'gone' }, 410)));
    expect((await fetchJson(options())).status).toBe('not_found');
  });

  it('pauses the bucket and throws retryable with retry-after on 429', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T10:00:00.000Z'));
    const bucket = bucketSpy();
    const metrics = metricsSpy();
    const fetchMock = vi.fn(respondWith({ message: 'slow down' }, 429, { 'retry-after': '7' }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await failure(fetchJson(options({ bucket, metrics: metrics.sink })));

    expect(bucket.pauseUntil).toHaveBeenCalledWith(Date.now() + 7_000);
    expect(error).toBeInstanceOf(UpstreamError);
    const upstream = error as UpstreamError;
    expect(upstream.status).toBe(429);
    expect(upstream.retryAfterMs).toBe(7_000);
    expect(upstream.retryable).toBe(true);
    expect(upstream.source).toBe('github');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(metrics.error).toHaveBeenCalledWith('github', 'repos', 'rate_limited');
  });

  it('treats a 403 with exhausted quota as rate limiting and uses x-ratelimit-reset', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T10:00:00.000Z'));
    const bucket = bucketSpy();
    const reset = Math.floor(Date.now() / 1000) + 30;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        respondWith({ message: 'forbidden' }, 403, {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(reset),
        }),
      ),
    );

    const error = await failure(fetchJson(options({ bucket })));

    expect(bucket.pauseUntil).toHaveBeenCalledWith(reset * 1000);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).retryAfterMs).toBe(30_000);
    expect((error as UpstreamError).retryable).toBe(true);
  });

  it('falls back to 60 s when a 429 carries no reset headers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T10:00:00.000Z'));
    const bucket = bucketSpy();
    vi.stubGlobal('fetch', vi.fn(respondWith({ message: 'slow down' }, 429)));

    const error = await failure(fetchJson(options({ bucket })));

    expect((error as UpstreamError).retryAfterMs).toBe(60_000);
    expect(bucket.pauseUntil).toHaveBeenCalledWith(Date.now() + 60_000);
  });

  it('treats a plain 403 as a non-retryable client error', async () => {
    const bucket = bucketSpy();
    const metrics = metricsSpy();
    vi.stubGlobal('fetch', vi.fn(respondWith({ message: 'forbidden' }, 403)));

    const error = await failure(fetchJson(options({ bucket, metrics: metrics.sink })));

    expect((error as UpstreamError).retryable).toBe(false);
    expect((error as UpstreamError).message).toContain('unexpected 403');
    expect((error as UpstreamError).message).not.toContain('redirect');
    expect(bucket.pauseUntil).not.toHaveBeenCalled();
    expect(metrics.error).toHaveBeenCalledWith('github', 'repos', 'client');
  });

  it('retries 5xx in-process and succeeds when a later attempt is 2xx', async () => {
    const metrics = metricsSpy();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond({ message: 'oops' }, 500))
      .mockResolvedValueOnce(respond({ value: 3 }, 200));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchJson(
      options({ metrics: metrics.sink, backoffBaseMs: 1, backoffCapMs: 2 }),
    );

    expect(result.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(metrics.error).toHaveBeenCalledWith('github', 'repos', 'server');
    expect(metrics.request).toHaveBeenLastCalledWith('github', 'repos', '200');
  });

  it('throws a retryable error after exhausting 5xx attempts', async () => {
    const fetchMock = vi.fn(respondWith({ message: 'oops' }, 502));
    vi.stubGlobal('fetch', fetchMock);

    const error = await failure(
      fetchJson(options({ maxAttempts: 2, backoffBaseMs: 1, backoffCapMs: 2 })),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(UpstreamError);
    const upstream = error as UpstreamError;
    expect(upstream.retryable).toBe(true);
    expect(upstream.status).toBe(502);
  });

  it('retries network errors in-process and succeeds when a later attempt works', async () => {
    const metrics = metricsSpy();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(respond({ value: 5 }, 200));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchJson(
      options({ metrics: metrics.sink, backoffBaseMs: 1, backoffCapMs: 2 }),
    );

    expect(result.status).toBe('ok');
    expect(metrics.request).toHaveBeenCalledWith('github', 'repos', 'network');
    expect(metrics.error).toHaveBeenCalledWith('github', 'repos', 'network');
  });

  it('throws a retryable error with a null status when the network stays down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENOTFOUND')));

    const error = await failure(fetchJson(options({ maxAttempts: 1 })));

    expect(error).toBeInstanceOf(UpstreamError);
    const upstream = error as UpstreamError;
    expect(upstream.retryable).toBe(true);
    expect(upstream.status).toBeNull();
    expect(upstream.retryAfterMs).toBeNull();
    expect(upstream.message).toContain('network error');
  });

  it('treats its own timeout as a retryable network error', async () => {
    vi.stubGlobal('fetch', hangingFetch());

    const startedAt = Date.now();
    const error = await failure(fetchJson(options({ timeoutMs: 40, maxAttempts: 1 })));

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).retryable).toBe(true);
  });

  it('propagates a caller abort instead of wrapping it', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const controller = new AbortController();

    const pending = fetchJson(options({ signal: controller.signal }));
    setTimeout(() => {
      controller.abort();
    }, 5);
    const error = await failure(pending);

    expect(error).not.toBeInstanceOf(UpstreamError);
    expect((error as DOMException).name).toBe('AbortError');
  });

  it('refuses non-allowlisted hosts before fetching (SSRF, spec §15)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const error = await failure(fetchJson(options({ url: 'https://evil.example/data' })));

    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).retryable).toBe(false);
    expect((error as UpstreamError).message).toContain('host not allowed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses plain http even on an allowlisted host', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const error = await failure(fetchJson(options({ url: 'http://api.github.com/repos/a/b' })));

    expect((error as UpstreamError).message).toContain('must be https');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to follow a redirect off the allowlist', async () => {
    const metrics = metricsSpy();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(null, { status: 301, headers: { location: 'https://evil.example/' } }),
        ),
      ),
    );

    const error = await failure(fetchJson(options({ metrics: metrics.sink })));

    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).retryable).toBe(false);
    expect((error as UpstreamError).message).toContain('redirect');
    expect(metrics.error).toHaveBeenCalledWith('github', 'repos', 'client');
  });

  it('pins the allowlist to the hosts named in spec §15', () => {
    expect([...ALLOWED_UPSTREAM_HOSTS].sort()).toEqual(
      [
        'api.github.com',
        'api.npmjs.org',
        'export.arxiv.org',
        'huggingface.co',
        'pypi.org',
        'pypistats.org',
        'registry.modelcontextprotocol.io',
        'registry.npmjs.org',
      ].sort(),
    );
  });
});
