// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SESSION_HINT_KEY = 'trendr.hasSession';
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
      title: status === 429 ? 'Too Many Requests' : 'Unauthorized',
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

describe('session hint (H-3)', () => {
  it('does not call refresh for anonymous visitors', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const auth = await loadAuth();

    await expect(auth.refreshSession()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records the hint after verification and clears it on sign-out', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(sessionResponse('access-1'));
    vi.stubGlobal('fetch', fetchMock);
    const auth = await loadAuth();

    await auth.verifyMagicLink('magic-token');
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe('1');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await auth.signOut();
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBeNull();
    expect(auth.getAccessToken()).toBeNull();
  });
});

describe('refresh error handling (H-3)', () => {
  it('clears the session on a definitive 401', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sessionResponse('access-1'))
      .mockResolvedValueOnce(problemResponse(401, 'unauthorized'));
    vi.stubGlobal('fetch', fetchMock);
    const auth = await loadAuth();
    await auth.verifyMagicLink('magic-token');

    await expect(auth.refreshSession()).resolves.toBeNull();
    expect(auth.getAccessToken()).toBeNull();
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBeNull();
  });

  it('keeps a valid session when refresh is rate limited', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sessionResponse('access-1'))
      .mockResolvedValueOnce(problemResponse(429, 'rate-limited'));
    vi.stubGlobal('fetch', fetchMock);
    const auth = await loadAuth();
    await auth.verifyMagicLink('magic-token');

    await expect(auth.refreshSession()).resolves.toBeNull();
    expect(auth.getAccessToken()).toBe('access-1');
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe('1');
  });

  it('keeps a valid session when the API is unavailable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sessionResponse('access-1'))
      .mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const auth = await loadAuth();
    await auth.verifyMagicLink('magic-token');

    await expect(auth.refreshSession()).resolves.toBeNull();
    expect(auth.getAccessToken()).toBe('access-1');
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe('1');
  });
});

describe('refresh rotation races (H-2)', () => {
  it('retries once when another tab already rotated the cookie', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(problemResponse(401, 'refresh-rotated'))
      .mockResolvedValueOnce(sessionResponse('access-2'));
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem(SESSION_HINT_KEY, '1');
    const auth = await loadAuth();

    await expect(auth.refreshSession()).resolves.toMatchObject({ email: USER.email });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auth.getAccessToken()).toBe('access-2');
  });

  it('does not clear the session when the grace retry also loses', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(problemResponse(401, 'refresh-rotated')));
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem(SESSION_HINT_KEY, '1');
    const auth = await loadAuth();

    await expect(auth.refreshSession()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe('1');
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
    localStorage.setItem(SESSION_HINT_KEY, '1');
    const auth = await loadAuth();

    await Promise.all([auth.refreshSession(), auth.refreshSession()]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('trendr.auth.refresh');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    delete (navigator as { locks?: unknown }).locks;
  });
});

describe('OAuth helpers (ADR-0034)', () => {
  it('forces a refresh for the callback page despite the missing hint', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(sessionResponse('access-oauth'));
    vi.stubGlobal('fetch', fetchMock);
    const auth = await loadAuth();

    await expect(auth.refreshSession({ force: true })).resolves.toMatchObject({
      email: USER.email,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe('1');
    expect(auth.getAccessToken()).toBe('access-oauth');
  });

  it('builds an API start URL with an encoded same-origin return path', async () => {
    const auth = await loadAuth();
    expect(auth.oauthStartUrl('google', '/items/42?tab=scores')).toBe(
      'http://localhost:4000/v1/auth/oauth/google/start?return_to=%2Fitems%2F42%3Ftab%3Dscores',
    );
    expect(auth.oauthStartUrl('github')).toBe('http://localhost:4000/v1/auth/oauth/github/start');
  });

  it('returns enabled providers and degrades to none on discovery failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ providers: [{ id: 'github', label: 'GitHub' }] }))
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    const auth = await loadAuth();

    await expect(auth.fetchOAuthProviders()).resolves.toEqual([{ id: 'github', label: 'GitHub' }]);
    await expect(auth.fetchOAuthProviders()).resolves.toEqual([]);
  });
});
