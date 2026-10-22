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

/** Restore a session from the refresh cookie; concurrent callers share one request. */
export function refreshSession(): Promise<AuthUser | null> {
  refreshInFlight ??= doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefresh(): Promise<AuthUser | null> {
  try {
    const response = await post('/v1/auth/refresh');
    if (!response.ok) {
      accessToken = null;
      return null;
    }
    const session = AuthSessionSchema.parse(await response.json());
    accessToken = session.accessToken;
    return session.user;
  } catch {
    accessToken = null;
    return null;
  }
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
  let problem: unknown;
  try {
    const body: unknown = await response.json();
    const parsed = ProblemSchema.safeParse(body);
    problem = parsed.success ? parsed.data : body;
  } catch {
    problem = undefined;
  }
  throw new ApiError(
    `API request to ${path} failed with status ${response.status}`,
    response.status,
    problem,
  );
}

export type { AuthSession, AuthUser };
