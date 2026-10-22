/**
 * Phase 8 MCP smoke against a running Compose stack:
 * initialize -> tools/list -> get_trending.
 *
 *   MCP_URL=http://localhost:4100/mcp node scripts/mcp-smoke.mjs
 *
 * No SDK installation is required; this intentionally exercises the raw
 * Streamable HTTP boundary used by Inspector and remote clients.
 */
const url = process.env.MCP_URL ?? 'http://localhost:4100/mcp';
const authToken = process.env.MCP_AUTH_TOKEN;
let nextId = 1;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readRpcResponse(response) {
  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text();
  if (!raw.trim()) return undefined;
  if (contentType.includes('text/event-stream')) {
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .find(Boolean);
    assert(data, 'SSE response did not contain a data event');
    return JSON.parse(data);
  }
  return JSON.parse(raw);
}

async function rpc(method, params, id) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(authToken === undefined ? {} : { authorization: `Bearer ${authToken}` }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      ...(id === undefined ? {} : { id }),
      method,
      ...(params === undefined ? {} : { params }),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${method} -> HTTP ${response.status}: ${body}`);
  }
  if (id === undefined) return undefined;
  const payload = await readRpcResponse(response);
  assert(payload !== undefined, `${method} returned an empty body`);
  if (payload.error !== undefined) {
    throw new Error(`${method} -> ${JSON.stringify(payload.error)}`);
  }
  return payload.result;
}

try {
  await rpc(
    'initialize',
    {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'trendr-compose-smoke', version: '1.0.0' },
    },
    nextId,
  );
  nextId += 1;
  await rpc('notifications/initialized');

  const listed = await rpc('tools/list', {}, nextId);
  nextId += 1;
  const names = listed.tools.map((tool) => tool.name).sort();
  const expected = [
    'compare_items',
    'get_item_history',
    'get_trending',
    'search_items',
    'whats_new_in_mcp',
  ];
  assert(
    JSON.stringify(names) === JSON.stringify(expected),
    `Unexpected MCP tools: ${names.join(', ')}`,
  );
  for (const tool of listed.tools) {
    assert(tool.inputSchema?.type === 'object', `${tool.name} has no input schema`);
    assert(tool.outputSchema?.type === 'object', `${tool.name} has no output schema`);
    assert(tool.annotations?.readOnlyHint === true, `${tool.name} is not marked read-only`);
  }

  const call = await rpc(
    'tools/call',
    { name: 'get_trending', arguments: { source: 'all', window: '7d', limit: 3 } },
    nextId,
  );
  assert(call.isError !== true, `get_trending failed: ${JSON.stringify(call.content)}`);
  assert(
    Array.isArray(call.structuredContent?.items) && call.structuredContent.items.length > 0,
    'get_trending returned no items (seed and score the stack first)',
  );
  console.log(
    `MCP smoke passed: ${names.join(', ')}; get_trending returned ${call.structuredContent.items.length} items`,
  );
} catch (error) {
  console.error(`MCP smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
