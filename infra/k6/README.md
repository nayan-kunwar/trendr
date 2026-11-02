# k6 trending load test

Spec §17.4 / task 10.4. `trending.js` ramps `/v1/trending` to 200 requests/second
and holds it, then asserts:

- `http_req_duration{p95} < 50 ms`
- `http_req_failed < 1%`
- at least 99% of checks pass
- no dropped iterations (the generator sustained the target arrival rate)

Run it against a deployed API, not a laptop:

```bash
BASE_URL=https://trendr.example.com k6 run infra/k6/trending.js
```

## Rate limits

The public anonymous tier is **60 requests/minute per IP**, so one load
generator is throttled long before 200 RPS. For a meaningful run, create a
dedicated API key and temporarily raise its budget:

```sql
UPDATE api_keys SET rate_limit_per_min = 1000000 WHERE prefix = '<test-key-prefix>';
```

Then pass the key and restore the original value afterwards:

```bash
BASE_URL=https://trendr.example.com \
API_KEY=dt_live_... \
k6 run infra/k6/trending.js
```

Alternatively, run against a staging instance whose limiter is deliberately
relaxed. Do not lower the production anonymous limit for the test. A 429 is a
failed check in this script, so a throttled run cannot be mistaken for capacity.

Useful overrides: `RATE` (default `200`), `RAMP` (default `30s`), `HOLD`
(default `2m`).

```bash
BASE_URL=https://trendr.example.com RATE=300 HOLD=5m k6 run infra/k6/trending.js
```

## Recording results

The script writes `k6-trending-summary.json` in the working directory and prints
the same summary. Record the run in the table below (and summarize it in the
root README once the first deployed run exists):

| Date       | Target                                 | RPS | p50    | p95     | p99     | Errors | API CPU | API memory | Notes                                                                             |
| ---------- | -------------------------------------- | --- | ------ | ------- | ------- | ------ | ------- | ---------- | --------------------------------------------------------------------------------- |
| 2026-11-02 | Local Compose (`api:4000`, seeded key) | 50  | 6.4 ms | 14.0 ms | 22.5 ms | 0%     | n/a     | n/a        | 2,150 requests, 10 s ramp + 30 s hold, no dropped iterations; local baseline only |

The local baseline validates the script and the Redis path, but it is **not** the
task 10.4 acceptance result. The acceptance run must target the deployed VPS
(or Render API) at 200 RPS and record the host's CPU/memory.

Also capture the API container's CPU/memory (`docker stats` on the VPS, or
Render metrics) and the rate-limit headers (`RateLimit-Limit`,
`RateLimit-Remaining`, `RateLimit-Reset`) during the run. If p95 misses the
threshold, profile the SQL/Redis path before changing code and record the
bottleneck and follow-up plan.
