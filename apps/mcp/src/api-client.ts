import { z } from 'zod';

import type { ItemKind, LeaderboardScope, Metric, Source, Window } from '@trendr/core';

import {
  AliasesApiResponseSchema,
  CompareApiResponseSchema,
  HistoryApiResponseSchema,
  ItemDetailApiSchema,
  NewApiResponseSchema,
  ProblemSchema,
  SearchApiResponseSchema,
  TrendingApiResponseSchema,
  type AliasesApiResponse,
  type CompareApiResponse,
  type HistoryApiResponse,
  type ItemDetailApi,
  type NewApiResponse,
  type Problem,
  type SearchApiResponse,
  type TrendingApiResponse,
} from './schemas.js';

export interface TrendingRequest {
  source: LeaderboardScope;
  window: Window;
  lang?: string;
  topic?: string;
  kind?: ItemKind;
  limit: number;
}

export interface SearchRequest {
  q: string;
  source?: Source;
  kind?: ItemKind;
  limit: number;
}

export interface HistoryRequest {
  metric?: Metric;
  from?: string;
  to?: string;
  granularity: 'hour' | 'day';
}

export interface CompareRequest {
  ids: string[];
  window: Window;
  metric?: Metric;
}

export interface NewRequest {
  source: Source;
  kind?: ItemKind;
  days: number;
}

/** The REST boundary used by every MCP tool (keeps tools free of DB/Redis access). */
export interface ApiClient {
  trending(request: TrendingRequest): Promise<TrendingApiResponse>;
  search(request: SearchRequest): Promise<SearchApiResponse>;
  getItem(id: string): Promise<ItemDetailApi>;
  getHistory(id: string, request: HistoryRequest): Promise<HistoryApiResponse>;
  compare(request: CompareRequest): Promise<CompareApiResponse>;
  getNewItems(request: NewRequest): Promise<NewApiResponse>;
  getAliases(id: string): Promise<AliasesApiResponse>;
  resolveItemId(source: Source, externalId: string): Promise<string>;
}

export interface HttpApiClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Injection point for unit tests. */
  fetchImpl?: typeof fetch;
}

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem | undefined;

  constructor(status: number, message: string, problem?: Problem) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
  }

  static async fromResponse(response: Response): Promise<ApiError> {
    const raw = await response.text();
    let problem: Problem | undefined;
    if (raw) {
      try {
        const parsed = ProblemSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          problem = parsed.data;
        }
      } catch {
        // Non-JSON error bodies still get a useful status/message below.
      }
    }
    const title = problem?.title ?? response.statusText;
    const detail = problem?.detail ? `: ${problem.detail}` : '';
    return new ApiError(
      response.status,
      `Trendr API ${response.status} ${title}${detail}`,
      problem,
    );
  }
}

type QueryValue = string | number | undefined;

const DEFAULT_TIMEOUT_MS = 15_000;

/** Typed fetch client for the read-only API endpoints used by the MCP tools. */
export class HttpApiClient implements ApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey?.trim() ?? undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async trending(request: TrendingRequest): Promise<TrendingApiResponse> {
    return this.get('/v1/trending', TrendingApiResponseSchema, {
      scope: request.source,
      window: request.window,
      lang: request.lang,
      topic: request.topic,
      kind: request.kind,
      limit: request.limit,
    });
  }

  async search(request: SearchRequest): Promise<SearchApiResponse> {
    return this.get('/v1/search', SearchApiResponseSchema, {
      q: request.q,
      source: request.source,
      kind: request.kind,
      limit: request.limit,
    });
  }

  async getItem(id: string): Promise<ItemDetailApi> {
    return this.get(`/v1/items/${encodeURIComponent(id)}`, ItemDetailApiSchema);
  }

  async getHistory(id: string, request: HistoryRequest): Promise<HistoryApiResponse> {
    return this.get(`/v1/items/${encodeURIComponent(id)}/history`, HistoryApiResponseSchema, {
      metric: request.metric,
      from: request.from,
      to: request.to,
      granularity: request.granularity,
    });
  }

  async compare(request: CompareRequest): Promise<CompareApiResponse> {
    return this.get('/v1/compare', CompareApiResponseSchema, {
      ids: request.ids.join(','),
      window: request.window,
      metric: request.metric,
    });
  }

  async getNewItems(request: NewRequest): Promise<NewApiResponse> {
    return this.get('/v1/new', NewApiResponseSchema, {
      source: request.source,
      kind: request.kind,
      days: request.days,
    });
  }

  async getAliases(id: string): Promise<AliasesApiResponse> {
    return this.get(`/v1/items/${encodeURIComponent(id)}/aliases`, AliasesApiResponseSchema);
  }

  async resolveItemId(source: Source, externalId: string): Promise<string> {
    const url = this.buildUrl('/v1/items/lookup', { source, externalId });
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: this.headers(),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status !== 302) {
      throw await ApiError.fromResponse(response);
    }
    const location = response.headers.get('location');
    if (!location) {
      throw new ApiError(502, 'Trendr API lookup did not return a Location header');
    }
    const path = new URL(location, url).pathname;
    const match = /\/v1\/items\/(\d{1,19})\/?$/.exec(path);
    if (!match?.[1]) {
      throw new ApiError(502, `Trendr API lookup returned an unexpected location: ${location}`);
    }
    return match[1];
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }
    return headers;
  }

  private buildUrl(path: string, query: Record<string, QueryValue> = {}): URL {
    const url = new URL(path, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  private async get<T>(
    path: string,
    schema: z.ZodType<T>,
    query: Record<string, QueryValue> = {},
  ): Promise<T> {
    const response = await this.fetchImpl(this.buildUrl(path, query), {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw await ApiError.fromResponse(response);
    }
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      const details = parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Trendr API returned an invalid response for ${path}: ${details}`);
    }
    return parsed.data;
  }
}
