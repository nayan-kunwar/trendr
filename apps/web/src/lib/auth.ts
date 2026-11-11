import { ApiError, apiBaseUrl } from './api';
import { ProblemSchema } from './schemas';
import {
  AuthMessageSchema,
  AuthSessionSchema,
  AuthUserSchema,
  OAuthProvidersSchema,
  type AuthSession,
  type AuthUser,
  type OAuthProviderInfo,
} from './auth-schemas';

/**
 * Access tokens deliberately live in a module variable, never localStorage:
 * a reload restores the session through the httpOnly `dt_refresh` cookie, so
 * XSS cannot exfiltrate a long-lived credential (spec §10.5).
 *
 * H-3 adds one non-sensitive localStorage hint (`trendr.hasSession`) so
 * anonymous page loads do not call `/v1/auth/refresh` at all.
 */
let accessToken: string | null = null;
let refreshInFlight: Promise<AuthUser | null> | null = null;

const SESSION_HINT_KEY = 'trendr.hasSession';
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
  setSessionHint(true);
  return session.user;
}

/**
 * Restore a session from the refresh cookie. Concurrent callers, including
 * other tabs when Web Locks is available, share one refresh (H-2). Anonymous
 * visitors with no session hint never send the request (H-3) unless `force` is
 * set — the OAuth callback page needs one refresh even though the hint is
 * absent because the session was just created on the API origin.
 */
export function refreshSession(options: { force?: boolean } = {}): Promise<AuthUser | null> {
  if (options.force !== true && !hasSessionHint()) return Promise.resolve(null);
  refreshInFlight ??= withRefreshLock(doRefreshWithRetry)
    .catch(() => null)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

/** Providers enabled on this deployment; discovery failures hide the buttons. */
export async function fetchOAuthProviders(): Promise<OAuthProviderInfo[]> {
  try {
    const response = await fetch(`${apiBaseUrl()}/v1/auth/oauth/providers`, {
      headers: { accept: 'application/json' },
      credentials: 'include',
      cache: 'no-store',
    });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    const parsed = OAuthProvidersSchema.safeParse(body);
    return parsed.success ? parsed.data.providers : [];
  } catch {
    return [];
  }
}

/**
 * Absolute API URL for a full-page authorization navigation. The state cookie
 * is set by the API response, so this must be a top-level navigation rather
 * than a fetch.
 */
export function oauthStartUrl(provider: OAuthProviderInfo['id'], returnTo?: string): string {
  const params = new URLSearchParams();
  if (returnTo !== undefined && returnTo.length > 0) params.set('return_to', returnTo);
  const query = params.toString();
  return `${apiBaseUrl()}/v1/auth/oauth/${provider}/start${query.length > 0 ? `?${query}` : ''}`;
}

type RefreshAttempt =
  | { kind: 'session'; session: AuthSession }
  | { kind: 'rotated' }
  | { kind: 'invalid' }
  | { kind: 'transient' };

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
    return { kind: 'transient' };
  }

  if (response.ok) {
    try {
      const session = AuthSessionSchema.parse(await response.json());
      accessToken = session.accessToken;
      setSessionHint(true);
      return { kind: 'session', session };
    } catch {
      // A malformed success response must not destroy a working session.
      return { kind: 'transient' };
    }
  }

  const problem = await readProblem(response);
  if (response.status === 401 && isRefreshRotated(problem)) {
    return { kind: 'rotated' };
  }
  if (response.status === 429 || response.status >= 500) {
    return { kind: 'transient' };
  }
  if (response.status === 401) {
    accessToken = null;
    setSessionHint(false);
    return { kind: 'invalid' };
  }
  return { kind: 'transient' };
}

export async function signOut(): Promise<void> {
  accessToken = null;
  setSessionHint(false);
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
  setSessionHint(false);
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

function hasSessionHint(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SESSION_HINT_KEY) === '1';
  } catch {
    // Private/storage-disabled contexts cannot keep the hint; attempt refresh.
    return true;
  }
}

function setSessionHint(active: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (active) window.localStorage.setItem(SESSION_HINT_KEY, '1');
    else window.localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    // Storage is an optimization, never a correctness requirement.
  }
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

export type { AuthSession, AuthUser, OAuthProviderInfo };
