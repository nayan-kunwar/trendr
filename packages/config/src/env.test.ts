import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { readEnv, readMcpEnv } from './env.js';

const envModuleUrl = new URL('./env.ts', import.meta.url).href;

const MINIMAL_VALID = {
  DATABASE_URL: 'postgres://trendr:trendr@localhost:5432/trendr',
  REDIS_URL: 'redis://localhost:6379',
  API_PUBLIC_URL: 'http://localhost:4000',
  WEB_PUBLIC_URL: 'http://localhost:3000',
  CORS_ORIGINS: 'http://localhost:3000',
  JWT_SECRET: 'j'.repeat(32),
  API_KEY_PEPPER: 'p'.repeat(32),
  UNSUBSCRIBE_SECRET: 'u'.repeat(32),
  METRICS_TOKEN: 'm'.repeat(16),
} as const;

const REQUIRED_KEYS: readonly string[] = Object.keys(MINIMAL_VALID);

/**
 * Boots `env.ts` in a fresh Node process (type stripping) with the given
 * environment, so `loadEnv`'s process-exit behaviour is exercised for real.
 */
function bootWith(envOverrides: Record<string, string>, removeKeys: readonly string[] = []) {
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !removeKeys.includes(key)),
  );
  const code = [
    `import(${JSON.stringify(envModuleUrl)})`,
    '  .then((module) => module.loadEnv())',
    '  .catch((error) => { process.stderr.write(String(error)); process.exit(2); });',
  ].join('\n');
  return spawnSync(process.execPath, ['-e', code], {
    env: { ...childEnv, ...envOverrides },
    encoding: 'utf8',
  });
}

describe('@trendr/config env schema', () => {
  it('reports readable errors instead of throwing', () => {
    const result = readEnv({});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.message).toContain('Invalid environment configuration');
    expect(result.message).toContain('DATABASE_URL');
    expect(result.message).toContain('METRICS_TOKEN');
  });

  it('applies defaults for a minimal valid environment', () => {
    const result = readEnv({ ...MINIMAL_VALID });
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.env.NODE_ENV).toBe('development');
    expect(result.env.LOG_LEVEL).toBe('info');
    expect(result.env.API_PORT).toBe(4000);
    expect(result.env.API_INTERNAL_URL).toBe('http://api:4000');
    expect(result.env.TRUST_PROXY).toBe(false);
    expect(result.env.ADMIN_EMAILS).toEqual([]);
    expect(result.env.CORS_ORIGINS).toEqual(['http://localhost:3000']);
    expect(result.env.COOKIE_SAME_SITE).toBe('lax');
    expect(result.env.WORKER_ROLES).toEqual(['scheduler', 'ingest', 'scoring', 'notify']);
    expect(result.env.WORKER_METRICS_PORT).toBe(9464);
    expect(result.env.SNAPSHOT_RETENTION_MONTHS).toBe(3);
    expect(result.env.EMAIL_PROVIDER).toBe('smtp');
    expect(result.env.GITHUB_TOKENS).toBeUndefined();
  });

  it('enforces cross-field rules (resend requires an api key)', () => {
    const result = readEnv({ ...MINIMAL_VALID, EMAIL_PROVIDER: 'resend' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.message).toContain('RESEND_API_KEY');
  });

  it('allows SameSite=None only where cookies are Secure', () => {
    const production = readEnv({
      ...MINIMAL_VALID,
      NODE_ENV: 'production',
      COOKIE_SAME_SITE: 'none',
      GITHUB_TOKENS: 'ghp_test',
    });
    expect(production.ok).toBe(true);
    if (production.ok) {
      expect(production.env.COOKIE_SAME_SITE).toBe('none');
    }

    const development = readEnv({ ...MINIMAL_VALID, COOKIE_SAME_SITE: 'none' });
    expect(development.ok).toBe(false);
    if (!development.ok) {
      expect(development.message).toContain('COOKIE_SAME_SITE');
      expect(development.message).toContain('NODE_ENV=production');
    }

    const strict = readEnv({ ...MINIMAL_VALID, COOKIE_SAME_SITE: 'strict' });
    expect(strict.ok).toBe(true);
  });

  it('exits with a readable message when required vars are missing', () => {
    const child = bootWith({}, REQUIRED_KEYS);
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('Invalid environment configuration');
    expect(child.stderr).toContain('DATABASE_URL');
    expect(child.stderr).toContain('REDIS_URL');
  });

  it('exits with a readable message on invalid values', () => {
    const child = bootWith({ DATABASE_URL: 'not-a-url' }, REQUIRED_KEYS);
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('Invalid environment configuration');
    expect(child.stderr).toContain('DATABASE_URL');
  });
});

describe('MCP-only environment', () => {
  it('validates without API/worker secrets', () => {
    const result = readMcpEnv({
      MCP_TRANSPORT: 'stdio',
      API_INTERNAL_URL: 'http://localhost:4000',
      MCP_API_KEY: 'dt_live_test',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.env.MCP_TRANSPORT).toBe('stdio');
    expect(result.env.MCP_PORT).toBe(4100);
    expect(result.env.MCP_API_KEY).toBe('dt_live_test');
    expect(result.env.MCP_HTTP_AUTH_TOKENS).toBeUndefined();
  });

  it('parses HTTP auth tokens and rejects an invalid port', () => {
    const valid = readMcpEnv({
      MCP_HTTP_AUTH_TOKENS: 'one, two',
      MCP_PORT: '4200',
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.env.MCP_HTTP_AUTH_TOKENS).toEqual(['one', 'two']);
      expect(valid.env.MCP_PORT).toBe(4200);
    }

    const invalid = readMcpEnv({ MCP_PORT: 'not-a-port' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.message).toContain('MCP_PORT');
    }
  });
});
