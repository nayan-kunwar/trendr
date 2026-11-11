import { z } from 'zod';

const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
);
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
/** Optional credentials: an empty env var (Render, Compose) means "not configured". */
const optionalCredential = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value.length === 0 ? undefined : value));

/**
 * The single source of truth for environment configuration (spec §15).
 * Every process validates its env at boot; see `loadEnv` below.
 */
const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: z.url(),
  API_PORT: z.coerce.number().int().default(4000),
  API_PUBLIC_URL: z.url(),
  API_INTERNAL_URL: z.url().default('http://api:4000'),
  WEB_PUBLIC_URL: z.url(),
  CORS_ORIGINS: csv,
  TRUST_PROXY: bool.prefault('false'),
  // M-12: only the VPS nginx overwrites CF-Connecting-IP. On Render,
  // TRUST_PROXY is true for X-Forwarded-For but this header is caller data.
  TRUST_CF_CONNECTING_IP: bool.prefault('false'),
  JWT_SECRET: z.string().min(32),
  // L-6: bounded lifetimes. The spec's 900 s / 30 d stay the defaults, but a
  // mistyped value can no longer issue a 5-year JWT or a 10-minute refresh.
  JWT_ACCESS_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  // `none` is only valid with Secure cookies, which the API sets in production.
  // Default `lax` covers the single-origin VPS topology and same-site custom
  // subdomains; split-origin deployments on unrelated sites need `none`.
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  API_KEY_PEPPER: z.string().min(32),
  UNSUBSCRIBE_SECRET: z.string().min(32),
  METRICS_TOKEN: z.string().min(16),
  ADMIN_EMAILS: csv.prefault(''),
  // ADR-0034: a provider is enabled only when both halves are configured.
  // Callback URLs derive from API_PUBLIC_URL, so no separate env var exists.
  GOOGLE_CLIENT_ID: optionalCredential,
  GOOGLE_CLIENT_SECRET: optionalCredential,
  GITHUB_CLIENT_ID: optionalCredential,
  GITHUB_CLIENT_SECRET: optionalCredential,
  GITHUB_TOKENS: csv.optional(), // required when WORKER_ROLES includes ingest
  GITHUB_RESERVE: z.coerce.number().int().default(200),
  HF_TOKEN: z.string().optional(),
  HF_RATE_PER_5MIN: z.coerce.number().int().default(1000),
  HF_INCLUDE_DATASETS: bool.prefault('false'),
  HF_INCLUDE_SPACES: bool.prefault('false'),
  HTTP_USER_AGENT: z.string().default('Trendr/1.0 (+https://github.com/nayan-kunwar/trendr)'),
  WORKER_ROLES: csv.prefault('scheduler,ingest,scoring,notify'),
  WORKER_CONCURRENCY_INGEST: z.coerce.number().int().default(4),
  WORKER_METRICS_PORT: z.coerce.number().int().default(9464),
  SCHEDULER_ENABLED: bool.prefault('true'),
  TRACKED_MAX_GITHUB: z.coerce.number().int().default(50000),
  TRACKED_MAX_NPM: z.coerce.number().int().default(10000),
  TRACKED_MAX_PYPI: z.coerce.number().int().default(2000),
  TRACKED_MAX_HUGGINGFACE: z.coerce.number().int().default(13000),
  TRACKED_HOT_MAX_GITHUB: z.coerce.number().int().default(2000),
  TRACKED_HOT_MAX_HUGGINGFACE: z.coerce.number().int().default(1000),
  NPM_MIN_WEEKLY_DOWNLOADS: z.coerce.number().int().default(200),
  PYPI_MIN_WEEKLY_DOWNLOADS: z.coerce.number().int().default(500),
  BACKFILL_GITHUB_MAX_PAGES: z.coerce.number().int().default(50),
  BACKFILL_GITHUB_PER_HOUR: z.coerce.number().int().default(200),
  FANOUT_BATCH_ITEMS: z.coerce.number().int().default(500),
  LB_MAX_SIZE: z.coerce.number().int().default(1000),
  ALL_BOARD_MAX_SHARE: z.coerce.number().min(0.1).max(1).default(0.4),
  SNAPSHOT_RETENTION_MONTHS: z.coerce.number().int().min(1).default(3),
  SCORES_HOURLY_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).default(48), // every scoring run kept this long
  SCORES_DAILY_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(365), // then last run per UTC day
  TIMESCALE_ENABLED: bool.prefault('false'),
  EMAIL_PROVIDER: z.enum(['resend', 'smtp', 'log']).default('smtp'),
  RESEND_API_KEY: z.string().optional(),
  SMTP_URL: z.string().default('smtp://mailpit:1025'),
  EMAIL_FROM: z.string().default('Trendr <digest@localhost>'),
  TURNSTILE_SECRET: z.string().optional(),
  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('http'),
  MCP_PORT: z.coerce.number().int().default(4100),
  MCP_API_KEY: z.string().optional(),
  MCP_HTTP_AUTH_TOKENS: csv.optional(),
  OTEL_ENABLED: bool.prefault('false'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  CLOUDFLARE_ZONE_ID: z.string().optional(),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
});

/** M-7: values that are obviously development defaults, not real secrets. */
const PLACEHOLDER_SECRET =
  /(change[-_ ]?me|replace[-_ ]?me|placeholder|example|your[-_ ]|^test$|^dev$|^secret$|^password$)/i;

export const EnvSchema = baseEnvSchema.superRefine((e, ctx) => {
  if (e.COOKIE_SAME_SITE === 'none' && e.NODE_ENV !== 'production') {
    ctx.addIssue({
      code: 'custom',
      path: ['COOKIE_SAME_SITE'],
      message: 'none requires NODE_ENV=production because SameSite=None needs Secure cookies',
    });
  }
  if (e.EMAIL_PROVIDER === 'resend' && !e.RESEND_API_KEY) {
    ctx.addIssue({ code: 'custom', path: ['RESEND_API_KEY'], message: 'required for resend' });
  }
  // ADR-0034: half-configured OAuth is a boot error, not a silently hidden
  // button. Both halves or neither.
  const oauthPairs = [
    ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET],
    ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', e.GITHUB_CLIENT_ID, e.GITHUB_CLIENT_SECRET],
  ] as const;
  for (const [idKey, secretKey, id, secret] of oauthPairs) {
    if ((id === undefined) !== (secret === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [id === undefined ? idKey : secretKey],
        message: `must be set together with ${id === undefined ? secretKey : idKey}`,
      });
    }
  }
  if (
    e.WORKER_ROLES.includes('ingest') &&
    !e.GITHUB_TOKENS?.length &&
    e.NODE_ENV === 'production'
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['GITHUB_TOKENS'],
      message: 'required for ingest in production',
    });
  }

  // M-7: a production boot must not look healthy while it is unusable.
  if (e.NODE_ENV === 'production') {
    const secrets = [
      ['JWT_SECRET', e.JWT_SECRET],
      ['API_KEY_PEPPER', e.API_KEY_PEPPER],
      ['UNSUBSCRIBE_SECRET', e.UNSUBSCRIBE_SECRET],
      ['METRICS_TOKEN', e.METRICS_TOKEN],
    ] as const;
    for (const [key, value] of secrets) {
      if (PLACEHOLDER_SECRET.test(value)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'must be a real secret in production, not a placeholder',
        });
      }
    }

    for (const [key, value] of [
      ['API_PUBLIC_URL', e.API_PUBLIC_URL],
      ['WEB_PUBLIC_URL', e.WEB_PUBLIC_URL],
    ] as const) {
      if (!value.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'must use https in production',
        });
      }
    }
    if (e.CORS_ORIGINS.some((origin) => !origin.startsWith('https://'))) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'every origin must use https in production',
      });
    }

    if (e.EMAIL_PROVIDER === 'log') {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_PROVIDER'],
        message: 'log is a development provider; configure resend or smtp in production',
      });
    }
    if (
      e.EMAIL_PROVIDER === 'smtp' &&
      /(^|\/\/)(mailpit|localhost|127\.0\.0\.1)([:/]|$)/.test(e.SMTP_URL)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_URL'],
        message: 'must point at a real SMTP host in production, not mailpit/localhost',
      });
    }
  }
});

/**
 * `@trendr/mcp` runs standalone (Claude Desktop/Cursor) and must not require
 * the API/worker secrets or database URLs. Only the MCP process env is parsed
 * when importing the `@trendr/config/mcp` subpath.
 */
export const McpEnvSchema = baseEnvSchema.pick({
  NODE_ENV: true,
  LOG_LEVEL: true,
  API_INTERNAL_URL: true,
  MCP_TRANSPORT: true,
  MCP_PORT: true,
  MCP_API_KEY: true,
  MCP_HTTP_AUTH_TOKENS: true,
});

export type Env = z.infer<typeof EnvSchema>;
export type McpEnv = z.infer<typeof McpEnvSchema>;

export interface EnvReadSuccess {
  ok: true;
  env: Env;
}

export interface EnvReadFailure {
  ok: false;
  message: string;
}

export type EnvReadResult = EnvReadSuccess | EnvReadFailure;

export interface McpEnvReadSuccess {
  ok: true;
  env: McpEnv;
}

export interface McpEnvReadFailure {
  ok: false;
  message: string;
}

export type McpEnvReadResult = McpEnvReadSuccess | McpEnvReadFailure;

/** Human-readable multi-line report of every validation problem. */
export function formatEnvError(error: z.ZodError): string {
  const problems = error.issues.map(
    (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  return ['Invalid environment configuration (compare with .env.example):', ...problems].join('\n');
}

/** Parse without side effects — used by tests and tools. */
export function readEnv(source: NodeJS.ProcessEnv = process.env): EnvReadResult {
  const parsed = EnvSchema.safeParse(source);
  return parsed.success
    ? { ok: true, env: parsed.data }
    : { ok: false, message: formatEnvError(parsed.error) };
}

/** Parse the MCP-only environment without requiring unrelated service secrets. */
export function readMcpEnv(source: NodeJS.ProcessEnv = process.env): McpEnvReadResult {
  const parsed = McpEnvSchema.safeParse(source);
  return parsed.success
    ? { ok: true, env: parsed.data }
    : { ok: false, message: formatEnvError(parsed.error) };
}

/**
 * Boot-time validation for the standalone MCP process. Uses the same readable
 * failure behaviour as `loadEnv`, but only validates the MCP subset.
 */
export function loadMcpEnv(source: NodeJS.ProcessEnv = process.env): McpEnv {
  const result = readMcpEnv(source);
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    process.exit(1);
  }
  return result.env;
}

/**
 * Boot-time validation (spec §14): every process that imports `@trendr/config`
 * exits with a readable message instead of crashing with a stack trace.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = readEnv(source);
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    process.exit(1);
  }
  return result.env;
}
