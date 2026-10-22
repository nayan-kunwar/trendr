/**
 * Spec §14.5/§9.2 — verify a locally running `docker compose --profile obs`
 * stack: Prometheus has loaded the alert rules and both scrape targets are up;
 * Grafana provisioned the Trendr Overview dashboard.
 *
 *   node scripts/obs-smoke.mjs
 */
const PROMETHEUS = (process.env.PROMETHEUS_URL ?? 'http://localhost:9090').replace(/\/$/, '');
const GRAFANA = (process.env.GRAFANA_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.OBS_SMOKE_TIMEOUT_MS ?? 90_000);

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function waitFor(label, check) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result !== false) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${label} did not become ready: ${lastError?.message ?? 'timeout'}`);
}

const rules = await waitFor('prometheus alert rules', async () => {
  const body = await getJson(`${PROMETHEUS}/api/v1/rules?type=alert`);
  const groups = body.data?.groups ?? [];
  const alerts = groups.flatMap((group) => group.rules ?? []);
  return alerts.length >= 6 ? alerts : false;
});
console.log(`prometheus: ${rules.length} alert rules loaded`);

await waitFor('prometheus scrape targets', async () => {
  const body = await getJson(`${PROMETHEUS}/api/v1/targets?state=active`);
  const active = body.data?.activeTargets ?? [];
  const jobs = new Map(active.map((target) => [target.labels?.job, target.health]));
  if (jobs.size < 2) return false;
  const unhealthy = [...jobs].filter(([, health]) => health !== 'up');
  if (unhealthy.length > 0) return false;
  return jobs;
});

const dashboard = await waitFor('grafana dashboard', async () => {
  const body = await getJson(
    `${GRAFANA}/api/search?query=${encodeURIComponent('Trendr Overview')}&type=dash-db`,
  );
  return Array.isArray(body) && body.some((item) => item.uid === 'trendr-overview') ? body : false;
});
console.log(`grafana: ${dashboard.length} dashboards visible (trendr-overview provisioned)`);
console.log('observability smoke passed');
