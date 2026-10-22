/**
 * Phase 7 auth smoke against a running Compose stack:
 * API -> Mailpit -> magic link -> JWT -> refresh rotation -> logout.
 *
 *   API_URL=http://localhost:4000 WEB_URL=http://localhost:3000 \
 *   MAILPIT_URL=http://localhost:8025 node scripts/auth-smoke.mjs
 */
const api = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const web = (process.env.WEB_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const mailpit = (process.env.MAILPIT_URL ?? 'http://localhost:8025').replace(/\/$/, '');
const email = `smoke-${Date.now()}@example.test`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function apiPost(path, body, headers = {}) {
  return fetch(`${api}${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      // Spec §15: cookie-authenticated writes must carry the CSRF header, like
      // the browser client does; refresh/logout would otherwise 403.
      'x-requested-with': 'trendr',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
}

async function userRequest(method, path, token, body) {
  return fetch(`${api}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
}

async function waitForMessage() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${mailpit}/api/v1/messages?limit=50`, {
      signal: AbortSignal.timeout(10_000),
    });
    assert(response.ok, `Mailpit list -> HTTP ${response.status}`);
    const body = await response.json();
    const match = body.messages?.find((message) =>
      message.To?.some((recipient) => recipient.Address?.toLowerCase() === email),
    );
    if (match !== undefined) {
      const detail = await fetch(`${mailpit}/api/v1/message/${match.ID}`, {
        signal: AbortSignal.timeout(10_000),
      });
      assert(detail.ok, `Mailpit detail -> HTTP ${detail.status}`);
      return detail.json();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no magic-link email arrived for ${email}`);
}

function cookieFrom(response) {
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie');
  assert(setCookie, 'verify did not set a refresh cookie');
  const pair = setCookie.split(';', 1)[0];
  assert(pair.startsWith('dt_refresh='), `unexpected refresh cookie: ${pair}`);
  return pair;
}

async function main() {
  const loginPage = await fetch(`${web}/login`, { signal: AbortSignal.timeout(20_000) });
  const loginHtml = await loginPage.text();
  assert(loginPage.ok && loginHtml.includes('Sign in to Trendr'), 'login page did not render');

  const issued = await apiPost('/v1/auth/magic-link', { email });
  assert(issued.status === 202, `magic-link -> HTTP ${issued.status}`);

  const message = await waitForMessage();
  const token = /\/auth\/verify\?token=([A-Za-z0-9_-]+)/.exec(message.Text ?? '')?.[1];
  assert(token, 'magic-link email had no token');

  const verified = await apiPost('/v1/auth/verify', { token });
  assert(verified.status === 200, `verify -> HTTP ${verified.status}`);
  const session = await verified.json();
  assert(session.user?.email === email, 'verify returned the wrong user');
  const cookie = cookieFrom(verified);

  const me = await fetch(`${api}/v1/me`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  assert(me.ok, `/v1/me -> HTTP ${me.status}`);

  for (const page of ['/dashboard', '/settings', '/account']) {
    const rendered = await fetch(`${web}${page}`, { signal: AbortSignal.timeout(20_000) });
    assert(rendered.ok, `${page} -> HTTP ${rendered.status}`);
  }

  const watchlist = await userRequest('POST', '/v1/me/watchlists', session.accessToken, {
    name: 'Smoke watchlist',
  });
  assert(watchlist.status === 201, `create watchlist -> HTTP ${watchlist.status}`);
  const watchlistBody = await watchlist.json();
  const watchlists = await userRequest('GET', '/v1/me/watchlists', session.accessToken);
  assert(watchlists.status === 200, `list watchlists -> HTTP ${watchlists.status}`);
  assert(
    (await watchlists.json()).watchlists?.some((row) => row.id === watchlistBody.id),
    'created watchlist missing from list',
  );

  const digest = await userRequest('PUT', '/v1/me/digest', session.accessToken, {
    sources: ['github'],
    topics: [],
    includeWatchlist: true,
    dayOfWeek: 1,
    enabled: true,
  });
  assert(digest.status === 200, `update digest -> HTTP ${digest.status}`);

  const alert = await userRequest('POST', '/v1/me/alerts', session.accessToken, {
    params: { type: 'rank_entered', topN: 10, scope: 'all' },
  });
  assert(alert.status === 201, `create alert -> HTTP ${alert.status}`);
  const alertBody = await alert.json();
  const alerts = await userRequest('GET', '/v1/me/alerts', session.accessToken);
  assert(alerts.status === 200, `list alerts -> HTTP ${alerts.status}`);
  assert(
    (await alerts.json()).alerts?.some((row) => row.id === alertBody.id),
    'created alert missing from list',
  );

  const createdKey = await userRequest('POST', '/v1/me/api-keys', session.accessToken, {
    name: 'Smoke key',
    expiresInDays: 1,
  });
  assert(createdKey.status === 201, `create API key -> HTTP ${createdKey.status}`);
  const keyBody = await createdKey.json();
  assert(keyBody.key?.startsWith('dt_live_'), 'API key reveal missing');
  const keyAuth = await fetch(`${api}/v1/trending?scope=all&window=24h&limit=1`, {
    headers: { 'x-api-key': keyBody.key },
    signal: AbortSignal.timeout(20_000),
  });
  assert(keyAuth.ok, `API key auth -> HTTP ${keyAuth.status}`);
  const keys = await userRequest('GET', '/v1/me/api-keys', session.accessToken);
  assert(keys.status === 200, `list API keys -> HTTP ${keys.status}`);
  assert(
    (await keys.json()).apiKeys?.some((row) => row.id === keyBody.apiKey?.id),
    'created API key missing from list',
  );
  const revoked = await userRequest(
    'DELETE',
    `/v1/me/api-keys/${keyBody.apiKey.id}`,
    session.accessToken,
  );
  assert(revoked.status === 204, `revoke API key -> HTTP ${revoked.status}`);

  const rotated = await apiPost('/v1/auth/refresh', undefined, { cookie });
  assert(rotated.status === 200, `refresh -> HTTP ${rotated.status}`);
  const rotatedCookie = cookieFrom(rotated);
  assert(rotatedCookie !== cookie, 'refresh did not rotate the token');

  const logout = await apiPost('/v1/auth/logout', undefined, { cookie: rotatedCookie });
  assert(logout.status === 204, `logout -> HTTP ${logout.status}`);

  const afterLogout = await apiPost('/v1/auth/refresh', undefined, {
    cookie: rotatedCookie,
  });
  assert(afterLogout.status === 401, `refresh after logout -> HTTP ${afterLogout.status}`);

  console.log(`PASS auth smoke for ${email}`);
}

main().catch((error) => {
  console.error(`FAIL auth smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
