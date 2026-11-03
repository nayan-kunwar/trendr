import { ApiError, apiBaseUrl } from './api';
import { ProblemSchema } from './schemas';
import {
  AuthMessageSchema,
  AuthSessionSchema,
  AuthUserSchema,
  type AuthSession,
  type AuthUser,
} from './auth-schemas';

/**
 * Access tokens deliberately live in a module variable, never localStorage:
 * a reload restores the session through the httpOnly `dt_refresh` cookie, so
 * XSS cannot exfiltrate a long-lived credential (spec §10.5).
 */
let accessToken: string | null = null;
let refreshInFlight: Promise<AuthUser | null> | null = null;

const REFRESH_LOCK_NAME = 'trendr.auth.refresh';
const REFRESH_CHANNEL_NAME = 'trendr.auth.refresh';
const REFRESH_RETRY_DELAY_MS = 150;

export function getAccessToken(): string | null {
  return accessToken;
}

export function requestMagicLink(email: string): Promise<void> {
  return publicJson('/v1/auth/magic-link', { email }, AuthMessageSchema).then(() => undefined);
}

export async function verifyMagicLink(token: string): Promise<AuthUser> {
  const session = await publicJson('/v1/auth/verify', { token }, AuthSessionSchema);
  accessToken = session.accessToken;
  return session.user;
}

/**
 * Restore a session from the refresh cookie. Concurrent callers, including
 * other tabs when Web Locks is available, share one refresh (H-2).
 */
export function refreshSession(): Promise<AuthUser | null> {
  refreshInFlight ??= withRefreshLock(doRefreshWithRetry)
    .catch(() => null)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

type RefreshAttempt =
  { kind: 'session'; session: AuthSession } | { kind: 'rotated' } | { kind: 'failed' };

/** Retry once when another tab won the rotation race (H-2). */
async function doRefreshWithRetry(): Promise<AuthUser | null> {
  let attempt = await doRefresh();
  if (attempt.kind === 'rotated') {
    await delay(REFRESH_RETRY_DELAY_MS);
    attempt = await doRefresh();
  }
  return attempt.kind === 'session' ? attempt.session.user : null;
}

async function doRefresh(): Promise<RefreshAttempt> {
  let response: Response;
  try {
    response = await post('/v1/auth/refresh');
  } catch {
    accessToken = null;
    return { kind: 'failed' };
  }

  if (response.ok) {
    try {
      const session = AuthSessionSchema.parse(await response.json());
      accessToken = session.accessToken;
      return { kind: 'session', session };
    } catch {
      accessToken = null;
      return { kind: 'failed' };
    }
  }

  const problem = await readProblem(response);
  if (response.status === 401 && isRefreshRotated(problem)) {
    // Do not clear the token: another tab already holds the successor cookie.
    return { kind: 'rotated' };
  }
  accessToken = null;
  return { kind: 'failed' };
}

export async function signOut(): Promise<void> {
  accessToken = null;
  try {
    await post('/v1/auth/logout');
  } catch {
    // The cookie may already be gone or the API unreachable; local state is cleared.
  }
}

export async function authFetch<T>(
  path: string,
  schema: { parse: (value: unknown) => T },
  init: RequestInit = {},
): Promise<T> {
  const response = await authorizedFetch(path, init);
  return parseJson(path, response, schema);
}

export async function authFetchVoid(path: string, init: RequestInit = {}): Promise<void> {
  const response = await authorizedFetch(path, init);
  if (!response.ok) {
    await throwProblem(path, response);
  }
}

async function authorizedFetch(path: string, init: RequestInit): Promise<Response> {
  if (accessToken === null) {
    await refreshSession();
  }

  let response = await request(path, init);

  if (response.status === 401 && accessToken !== null) {
    const user = await refreshSession();
    if (user !== null) response = await request(path, init);
  }
  return response;
}

function request(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  // §15 CSRF defence: cookie-authenticated writes must carry this header.
  headers.set('x-requested-with', 'trendr');
  if (accessToken !== null) headers.set('authorization', `Bearer ${accessToken}`);
  return fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });
}

export function updateProfile(displayName: string | null): Promise<AuthUser> {
  return authFetch('/v1/me', AuthUserSchema, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
}

export async function deleteAccount(): Promise<void> {
  await authFetchVoid('/v1/me', { method: 'DELETE' });
  accessToken = null;
}

export function authErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const problem = ProblemSchema.safeParse(error.problem);
    if (problem.success && problem.data.detail !== undefined) return problem.data.detail;
    if (error.status === 429) return 'Too many requests. Please wait a minute and try again.';
    if (error.status === 401) return 'That link is invalid or has expired. Request a new one.';
  }
  return fallback;
}

async function publicJson<T>(
  path: string,
  body: unknown,
  schema: { parse: (value: unknown) => T },
): Promise<T> {
  const response = await post(path, body);
  return parseJson(path, response, schema);
}

function post(path: string, body?: unknown): Promise<Response> {
  return fetch(`${apiBaseUrl()}${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'x-requested-with': 'trendr',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: 'include',
    cache: 'no-store',
  });
}

async function parseJson<T>(
  path: string,
  response: Response,
  schema: { parse: (value: unknown) => T },
): Promise<T> {
  if (!response.ok) {
    await throwProblem(path, response);
  }
  const body: unknown = await response.json();
  return schema.parse(body);
}

async function throwProblem(path: string, response: Response): Promise<never> {
  const problem = await readProblem(response);
  throw new ApiError(
    `API request to ${path} failed with status ${response.status}`,
    response.status,
    problem,
  );
}

async function readProblem(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json();
    const parsed = ProblemSchema.safeParse(body);
    return parsed.success ? parsed.data : body;
  } catch {
    return undefined;
  }
}

function isRefreshRotated(problem: unknown): boolean {
  const parsed = ProblemSchema.safeParse(problem);
  return parsed.success && parsed.data.type.endsWith('/refresh-rotated');
}

/**
 * Cross-tab refresh serialization. Web Locks is the primary mechanism; the
 * BroadcastChannel path is a best-effort fallback for older browsers, where
 * the typed `refresh-rotated` retry still protects the session (H-2).
 */
async function withRefreshLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks !== undefined) {
    return locks.request(REFRESH_LOCK_NAME, run);
  }
  return withBroadcastRefreshLock(run);
}

async function withBroadcastRefreshLock<T>(run: () => Promise<T>): Promise<T> {
  if (typeof BroadcastChannel === 'undefined') return run();

  const channel = new BroadcastChannel(REFRESH_CHANNEL_NAME);
  const state = { anotherTabStarted: false };
  channel.onmessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      typeof data === 'object' &&
      data !== null &&
      'type' in data &&
      data.type === 'refresh-start'
    ) {
      state.anotherTabStarted = true;
    }
  };
  channel.postMessage({ type: 'refresh-start' });

  try {
    await delay(50);
    // Give the first tab time to write the rotated cookie before we consume it.
    if (state.anotherTabStarted) await delay(500);
    return await run();
  } finally {
    channel.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export type { AuthSession, AuthUser };
