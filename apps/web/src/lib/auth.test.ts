// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = {
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  email: 'ada@example.test',
  displayName: null,
  role: 'user',
  emailVerifiedAt: '2026-11-01T12:00:00.000Z',
  createdAt: '2026-10-01T12:00:00.000Z',
  lastLoginAt: '2026-11-01T12:00:00.000Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function problemResponse(status: number, type: string): Response {
  return jsonResponse(
    {
      type: `https://trendr.dev/problems/${type}`,
      title: 'Unauthorized',
      status,
      instance: '/v1/auth/refresh',
      requestId: 'req-test',
    },
    status,
  );
}

function sessionResponse(accessToken: string): Response {
  return jsonResponse({ accessToken, expiresIn: 900, user: USER });
}

async function loadAuth(): Promise<typeof import('@/lib/auth')> {
  return import('@/lib/auth');
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  document.cookie = 'dt_refresh=test-cookie; path=/';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('refresh rotation races (H-2)', () => {
  it('retries once when another tab already rotated the cookie', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(problemResponse(401, 'refresh-rotated'))
      .mockResolvedValueOnce(sessionResponse('access-2'));
    vi.stubGlobal('fetch', fetchMock);
    const auth = await loadAuth();

    await expect(auth.refreshSession()).resolves.toMatchObject({ email: USER.email });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auth.getAccessToken()).toBe('access-2');
  });

  it('keeps the current access token when the grace retry also loses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sessionResponse('access-1'))
      .mockImplementation(() => Promise.resolve(problemResponse(401, 'refresh-rotated')));
    vi.stubGlobal('fetch', fetchMock);
    const auth = await loadAuth();
    await auth.verifyMagicLink('magic-token');

    await expect(auth.refreshSession()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(auth.getAccessToken()).toBe('access-1');
  });

  it('single-flights concurrent refreshes through the Web Locks API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sessionResponse('access-3'));
    vi.stubGlobal('fetch', fetchMock);
    const request = vi.fn(
      async (_name: string, callback: () => Promise<unknown>): Promise<unknown> => callback(),
    );
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    });
    const auth = await loadAuth();

    await Promise.all([auth.refreshSession(), auth.refreshSession()]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('trendr.auth.refresh');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    delete (navigator as { locks?: unknown }).locks;
  });
});
