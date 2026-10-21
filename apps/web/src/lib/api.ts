import type { ZodType } from 'zod';

import { ProblemSchema, type TrendingResponse } from './schemas';

const DEFAULT_API_URL = 'http://localhost:4000';

export type ApiFetchInit = RequestInit & {
  next?: { revalidate?: number | false; tags?: string[] };
};

export class ApiError extends Error {
  readonly status: number;
  readonly problem: unknown;

  constructor(message: string, status: number, problem?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
  }
}

/** Server-side calls use the Docker service name; browser calls use the public URL. */
export function apiBaseUrl(): string {
  if (typeof window !== 'undefined') return publicApiBaseUrl();
  return (
    process.env.API_INTERNAL_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    DEFAULT_API_URL
  ).replace(/\/$/, '');
}

export function publicApiBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_URL).replace(/\/$/, '');
}

export type QueryValue = string | number | boolean | null | undefined;

export function buildQuery(values: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query.length > 0 ? `?${query}` : '';
}

export async function apiFetch<T>(
  path: string,
  schema: ZodType<T>,
  init: ApiFetchInit = {},
): Promise<T> {
  const url = path.startsWith('http') ? path : `${apiBaseUrl()}${path}`;
  const headers = new Headers(init.headers);
  if (!headers.has('accept')) headers.set('accept', 'application/json');

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (error) {
    throw new ApiError(
      `Could not reach the API at ${url}`,
      statusFromNetworkError(error),
      undefined,
    );
  }

  if (!response.ok) {
    let problem: unknown;
    try {
      const body: unknown = await response.json();
      const parsed = ProblemSchema.safeParse(body);
      problem = parsed.success ? parsed.data : body;
    } catch {
      problem = undefined;
    }
    throw new ApiError(
      `API request failed with status ${response.status}`,
      response.status,
      problem,
    );
  }

  const body: unknown = await response.json();
  return schema.parse(body);
}

function statusFromNetworkError(error: unknown): number {
  // Next's dynamic-render error is not an HTTP status; 503 keeps the UI honest.
  if (error instanceof Error) return 503;
  return 503;
}

/** Server components render a friendly empty state instead of crashing when the API is down. */
export async function safeApiFetch<T>(
  path: string,
  schema: ZodType<T>,
  init: ApiFetchInit = {},
): Promise<T | null> {
  try {
    return await apiFetch(path, schema, init);
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(
        `[web] ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  }
}

export function leaderboardPath(input: {
  scope: string;
  window: string;
  lang?: string | undefined;
  topic?: string | undefined;
  kind?: string | undefined;
  newOnly?: boolean | undefined;
  minCurrent?: number | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}): string {
  return `/v1/trending${buildQuery({
    scope: input.scope,
    window: input.window,
    lang: input.lang,
    topic: input.topic,
    kind: input.kind,
    newOnly: input.newOnly === true ? 'true' : undefined,
    minCurrent: input.minCurrent,
    limit: input.limit,
    cursor: input.cursor,
  })}`;
}

export function streamUrl(scope: string, window: string): string {
  return `${publicApiBaseUrl()}/v1/stream/leaderboard${buildQuery({ scope, window })}`;
}

export function latestUpdatedAt(board: TrendingResponse | null): string | null {
  return board?.computedAt ?? null;
}
