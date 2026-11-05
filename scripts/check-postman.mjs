#!/usr/bin/env node
/**
 * Guard the hand-authored Postman collection against the generated OpenAPI
 * document (spec §10.5). The collection is the client-side workflow; this
 * script keeps it honest:
 *
 *   - every OpenAPI operation (method + path) appears at least once;
 *   - no request points at a path or method the API does not expose;
 *   - the collection is valid Postman v2.1 JSON.
 *
 * Path parameter names are normalised (`:id`, `{id}` and `{{itemId}}` all
 * become `{}`), because the collection uses collection variables instead of
 * Postman path variables. Mailpit and the hidden `/openapi.json` route are
 * infrastructure, not API surface, and are skipped.
 *
 * Run from the repository root: `node scripts/check-postman.mjs`.
 */
import { readFile } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url);
const COLLECTION_PATH = 'docs/postman/Trendr.postman_collection.json';
const OPENAPI_PATH = 'apps/api/openapi.json';

/** Infrastructure requests that are not part of the OpenAPI path map. */
const META_PATHS = new Set(['/openapi.json']);
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

const readJson = async (path) => JSON.parse(await readFile(new URL(path, ROOT), 'utf8'));

/** `{id}` and `{{itemId}}` both describe one path-parameter slot. */
const normalizePath = (path) => path.replace(/\{\{[^}]*\}\}|\{[^}]*\}/g, '{}');

const collection = await readJson(COLLECTION_PATH);
const openapi = await readJson(OPENAPI_PATH);

const failures = [];

if (
  collection.info?.schema !== 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
) {
  failures.push(`collection schema is not Postman v2.1: ${String(collection.info?.schema)}`);
}
if (!Array.isArray(collection.item)) {
  failures.push('collection has no item array');
}

/** @type {Map<string, string>} normalized operation key -> OpenAPI path */
const spec = new Map();
for (const [path, operations] of Object.entries(openapi.paths ?? {})) {
  for (const method of Object.keys(operations)) {
    if (!HTTP_METHODS.has(method)) continue;
    spec.set(`${method.toUpperCase()} ${normalizePath(path)}`, path);
  }
}

/** @type {Map<string, number>} */
const seen = new Map();
const unknown = [];
let requestCount = 0;

/**
 * @param {unknown[]} items
 * @param {string} folderName
 */
function walk(items, folderName) {
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = /** @type {{ name?: unknown, item?: unknown, request?: unknown }} */ (item);

    if (Array.isArray(entry.item)) {
      walk(entry.item, typeof entry.name === 'string' ? entry.name : folderName);
      continue;
    }
    if (typeof entry.request !== 'object' || entry.request === null) continue;

    const request = /** @type {{ method?: unknown, url?: { raw?: unknown } }} */ (entry.request);
    const raw = typeof request.url?.raw === 'string' ? request.url.raw : '';
    const name = typeof entry.name === 'string' ? entry.name : '(unnamed)';
    requestCount += 1;

    if (!raw.startsWith('{{baseUrl}}')) continue; // Mailpit and other non-API hosts.

    const method = typeof request.method === 'string' ? request.method.toUpperCase() : 'GET';
    const path = raw.split('?')[0].replace('{{baseUrl}}', '');
    if (META_PATHS.has(path)) continue;

    const key = `${method} ${normalizePath(path)}`;
    if (!spec.has(key)) {
      unknown.push(`${folderName} / ${name}: ${method} ${path}`);
      continue;
    }
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
}

walk(collection.item ?? [], '');

const missing = [...spec.keys()].filter((key) => !seen.has(key));

if (missing.length > 0) {
  failures.push(
    `${missing.length} OpenAPI operation(s) missing from the collection:\n` +
      missing.map((key) => `  - ${key} (${spec.get(key)})`).join('\n'),
  );
}
if (unknown.length > 0) {
  failures.push(
    `${unknown.length} collection request(s) target an unknown path:\n` +
      unknown.map((line) => `  - ${line}`).join('\n'),
  );
}

if (failures.length > 0) {
  console.error(`Postman collection check failed:\n${failures.join('\n')}`);
  process.exit(1);
}

console.log(
  `Postman collection: ${spec.size}/${spec.size} OpenAPI operations covered, ` +
    `${requestCount} requests, 0 unknown paths.`,
);
