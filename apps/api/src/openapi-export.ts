import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

import { buildApp } from './app.js';

/**
 * Exports the OpenAPI document to `apps/api/openapi.json` (spec §10.5). CI
 * runs this through `pnpm --filter @trendr/api openapi:export` and fails when
 * the committed file drifts, so the document always matches the routes.
 *
 * The output is formatted with the repo Prettier config because lint-staged
 * reformats `*.json` on every commit — an unformatted export would fail the CI
 * staleness check. `format()` does **not** resolve a config from `filepath`
 * (Prettier 3), so the config is resolved explicitly; otherwise the export
 * would silently use the default `printWidth: 80` and drift from what
 * lint-staged writes with the repo's `printWidth: 100`.
 */
const app = await buildApp({ rateLimit: false });
await app.ready();
const document = app.swagger();
const target = fileURLToPath(new URL('../openapi.json', import.meta.url));
const config = await resolveConfig(target);
const source = await format(JSON.stringify(document), { ...(config ?? {}), filepath: target });
await writeFile(target, source, 'utf8');
await app.close();
console.log(`openapi.json written (${Object.keys(document.paths ?? {}).length} paths)`);
