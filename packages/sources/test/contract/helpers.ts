import { z } from 'zod';

/**
 * Spec §16 contract-test boundary. Contract tests are the only tests that call
 * real upstreams, so they read the CI-provided token environment directly and
 * are gated by `CONTRACT=1` (the root Vitest config keeps this project out of
 * `pnpm test` and `pnpm test:int`).
 */
const ContractEnvSchema = z.object({
  CONTRACT: z.string().optional(),
  GITHUB_TOKENS: z.string().optional(),
  HF_TOKEN: z.string().optional(),
  HTTP_USER_AGENT: z.string().default('Trendr/1.0 (+https://github.com/nayankunwar/trendr)'),
});

const contractEnv = ContractEnvSchema.parse(process.env);

export const CONTRACT_ENABLED = contractEnv.CONTRACT === '1';
const hfToken = contractEnv.HF_TOKEN?.trim() ?? '';
export const HF_TOKEN = hfToken === '' ? null : hfToken;

const githubTokens = (contractEnv.GITHUB_TOKENS ?? '')
  .split(',')
  .map((token) => token.trim())
  .filter((token) => token !== '');

export const GITHUB_TOKEN = githubTokens[0] ?? null;
export const USER_AGENT = contractEnv.HTTP_USER_AGENT;

/** GitHub's authenticated endpoints are required in CI; fail clearly if unset. */
export function requireGithubToken(): string {
  if (GITHUB_TOKEN === null) {
    throw new Error('CONTRACT=1 requires GITHUB_TOKENS for the GitHub contract probes');
  }
  return GITHUB_TOKEN;
}

export interface ContractRequest {
  token?: string | null;
  accept?: string;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: unknown;
}

export interface ContractResponse {
  status: number;
  headers: Headers;
  text: string;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(response: Response): number {
  const retryAfter = Number(response.headers.get('retry-after') ?? Number.NaN);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(10_000, retryAfter * 1_000);
  }
  return 2_000;
}

/**
 * Fetch one live endpoint with a 30 s timeout and two bounded retries for
 * transient 429/5xx responses. Error messages contain only method + origin +
 * pathname, never query strings (some queries could echo a token by accident).
 */
export async function contractFetch(
  url: string,
  request: ContractRequest = {},
): Promise<ContractResponse> {
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: request.accept ?? 'application/json',
    ...request.headers,
  };
  if (request.token !== undefined && request.token !== null) {
    headers.authorization = `Bearer ${request.token}`;
  }
  const init: RequestInit = {
    method: request.method ?? 'GET',
    headers,
    signal: AbortSignal.timeout(30_000),
  };
  if (request.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(request.body);
  }

  const parsedUrl = new URL(url);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(parsedUrl, init);
    if (response.ok) {
      return { status: response.status, headers: response.headers, text: await response.text() };
    }
    if (attempt < MAX_ATTEMPTS - 1 && RETRYABLE_STATUS.has(response.status)) {
      await sleep(retryDelayMs(response));
      continue;
    }
    throw new Error(
      `contract request failed: ${init.method} ${parsedUrl.origin}${parsedUrl.pathname} -> ${response.status}`,
    );
  }
  throw new Error('contract request exhausted retries');
}

/** JSON boundary for a schema parse; never treat the body as typed truth. */
export function contractJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}
