/**
 * Phase 6 web smoke test. Run against a server with the API reachable:
 *
 *   WEB_SMOKE_URL=http://localhost:3000 API_URL=http://localhost:4000 \
 *     pnpm --filter @trendr/web smoke
 *
 * It intentionally uses only Node built-ins so it also works inside the Docker
 * network after `docker compose up`.
 */
const web = (process.env.WEB_SMOKE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const api = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
let failures = 0;

function png(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((byte, index) => bytes[index] === byte);
}

async function request(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  return response;
}

async function page(name, path, markers) {
  const url = `${web}${path}`;
  try {
    const response = await request(url);
    const text = await response.text();
    const missing = markers.filter((marker) => !text.includes(marker));
    if (response.status !== 200 || missing.length > 0) {
      failures += 1;
      console.error(
        `FAIL ${name}: HTTP ${response.status}${missing.length > 0 ? `; missing ${missing.join(', ')}` : ''}`,
      );
      return;
    }
    console.log(`PASS ${name} (${response.status})`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function json(path) {
  const response = await request(`${api}${path}`);
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return response.json();
}

function slugify(value) {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug.length > 0 ? slug : 'item';
}

async function main() {
  const board = await json('/v1/trending?scope=all&window=7d&limit=10');
  const first = board.data[0];
  const second = board.data[1];
  if (first === undefined || second === undefined) {
    throw new Error('The combined 7d board has fewer than two items; seed and score first.');
  }

  await page('search', '/search?q=open-webui', ['Search the index', 'open-webui']);
  await page('new', '/new?days=7', ['New in the last']);
  await page('topics index', '/topics', ['Browse by topic']);
  await page('topic board', '/topics/mcp', ['projects']);
  await page('compare', `/compare?ids=${first.item.id},${second.item.id}&window=7d`, [
    'Metric trajectories',
    'Current standing',
  ]);

  const item = first.item;
  await page('item', `/item/${item.id}/${slugify(item.displayName)}`, [
    'Why this score',
    'Score history',
    'application/ld+json',
  ]);

  const ogUrl = `${web}/item/${item.id}/${slugify(item.displayName)}/opengraph-image`;
  try {
    const response = await request(ogUrl);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const type = response.headers.get('content-type') ?? '';
    if (response.status !== 200 || !type.startsWith('image/png') || !png(bytes)) {
      throw new Error(`HTTP ${response.status}, ${type}, ${bytes.length} bytes`);
    }
    console.log(`PASS item OG image (${bytes.length} bytes PNG)`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL item OG image: ${error instanceof Error ? error.message : String(error)}`);
  }

  await page('sitemap', '/sitemap.xml', ['<urlset', '<loc>']);
  await page('robots', '/robots.txt', ['Sitemap:', 'Disallow: /search']);

  if (failures > 0) {
    console.error(`\n${failures} smoke check(s) failed against ${web}`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll web smoke checks passed against ${web}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
