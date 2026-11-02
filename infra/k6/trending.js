/* global __ENV */
import http from 'k6/http';
import { check } from 'k6';

/**
 * Spec §17.4 / task 10.4: ramp the Redis-backed trending path to 200 RPS and
 * hold it. Run against a deployed API, not a laptop:
 *
 *   BASE_URL=https://trendr.example.com k6 run infra/k6/trending.js
 *
 * The anonymous tier is 60 requests/minute per IP, so a single load generator
 * will be rate-limited long before 200 RPS. Use a dedicated API key whose
 * `rate_limit_per_min` was temporarily raised for the test (or a staging
 * instance with the limiter relaxed), pass it as API_KEY, and restore it
 * afterwards. A 429 is treated as a failed check, not as capacity.
 */

const BASE_URL = (__ENV.BASE_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const RATE = Number(__ENV.RATE ?? 200);
const HOLD = __ENV.HOLD ?? '2m';
const RAMP = __ENV.RAMP ?? '30s';
const API_KEY = __ENV.API_KEY;

if (!Number.isFinite(RATE) || RATE <= 0) {
  throw new Error('RATE must be a positive number');
}

const PATHS = [
  '/v1/trending?scope=all&window=24h&limit=50',
  '/v1/trending?scope=all&window=7d&limit=50',
  '/v1/trending?scope=all&window=30d&limit=50',
  '/v1/trending?scope=github&window=7d&limit=50',
  '/v1/trending?scope=npm&window=7d&limit=50',
  '/v1/trending?scope=all&window=7d&limit=50&topic=ai',
];

function headers() {
  const value = { accept: 'application/json' };
  if (API_KEY !== undefined && API_KEY.length > 0) {
    value['x-api-key'] = API_KEY;
  }
  return value;
}

export const options = {
  scenarios: {
    trending: {
      executor: 'ramping-arrival-rate',
      startRate: Math.max(1, Math.floor(RATE / 10)),
      timeUnit: '1s',
      preAllocatedVUs: Math.max(10, Math.ceil(RATE / 4)),
      maxVUs: Math.max(50, RATE * 2),
      stages: [
        { target: RATE, duration: RAMP },
        { target: RATE, duration: HOLD },
        { target: 0, duration: '15s' },
      ],
      gracefulStop: '15s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<50'],
    checks: ['rate>0.99'],
    dropped_iterations: ['count<1'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const response = http.get(`${BASE_URL}${PATHS[0]}`, {
    headers: headers(),
    tags: { name: 'GET /v1/trending' },
  });
  if (response.status === 429) {
    throw new Error(
      'rate limited during warmup: pass API_KEY with a raised budget, or load-test a staging instance with the limiter relaxed',
    );
  }
  if (response.status !== 200) {
    throw new Error(`warmup failed with status ${response.status} against ${BASE_URL}`);
  }
}

export default function () {
  const path = PATHS[Math.floor(Math.random() * PATHS.length)];
  const response = http.get(`${BASE_URL}${path}`, {
    headers: headers(),
    tags: { name: 'GET /v1/trending' },
  });
  check(response, {
    'status is 200': (r) => r.status === 200,
    'body has data': (r) => {
      try {
        return Array.isArray(r.json('data'));
      } catch {
        return false;
      }
    },
  });
}

export function handleSummary(data) {
  const duration = data.metrics.http_req_duration?.values ?? {};
  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    targetRps: RATE,
    hold: HOLD,
    ramp: RAMP,
    metrics: {
      requests: data.metrics.http_reqs?.values.count ?? 0,
      failedRate: data.metrics.http_req_failed?.values.rate ?? 0,
      p50: duration['p(50)'] ?? null,
      p95: duration['p(95)'] ?? null,
      p99: duration['p(99)'] ?? null,
      max: duration.max ?? null,
    },
  };
  const body = JSON.stringify(summary, null, 2);
  return {
    stdout: `${body}\n`,
    'k6-trending-summary.json': body,
  };
}
