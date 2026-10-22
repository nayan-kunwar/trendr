# 0018 — MCP runtime boundary and stateless Streamable HTTP

- Status: Accepted
- Date: 2026-10-22
- Phase: 8 (8.1)
- Source: TRENDR_SPEC.md §11, §18 tasks 8.1–8.3

## Context

Phase 8 adds a read-only MCP server in `apps/mcp`. The frozen spec pins the v1 SDK line
(`^1.32`) and requires both stdio and Streamable HTTP. Two boundary problems surfaced while
designing the implementation:

1. The root `@trendr/config` export validates the full API/worker environment at import time.
   A standalone Claude Desktop or Cursor process only has `MCP_*` and `API_INTERNAL_URL`, so
   reusing that export would make the documented client configuration fail.
2. The SDK's stateless Streamable HTTP mode requires a fresh `McpServer` and transport per
   request because there is no session state to resume. It also returns 405 for GET/DELETE,
   and its TypeScript declarations are not fully compatible with
   `exactOptionalPropertyTypes`.

## Decision

1. Use `@modelcontextprotocol/sdk@1.32.1`, the current v1 release. Its peer range accepts
   Zod 4 (`^3.25 || ^4.0`), so no `zod/v3` shim is needed. SDK v2 is out of scope for the frozen
   spec.
2. Add the `@trendr/config/mcp` subpath. It validates only `NODE_ENV`, `LOG_LEVEL`,
   `API_INTERNAL_URL`, `MCP_TRANSPORT`, `MCP_PORT`, `MCP_API_KEY` and
   `MCP_HTTP_AUTH_TOKENS`, without requiring `DATABASE_URL`, JWT secrets or worker credentials.
3. MCP tools call only the public API through `ApiClient`; the process has no database or Redis
   dependency. `MCP_API_KEY` is optional and forwarded as `X-API-Key` when present.
4. HTTP transport is stateless: `POST /mcp` creates a per-request server/transport pair and
   closes it with the response. `GET`/`DELETE /mcp` return 405. `GET /healthz` is an
   unauthenticated health endpoint. Optional static bearer auth is enforced from
   `MCP_HTTP_AUTH_TOKENS`.
5. stdio mode sends every log line to stderr so stdout carries only JSON-RPC.

## Consequences

- The MCP package can be launched from a local checkout with only its own environment variables.
- The Compose service keeps its in-network `http://api:4000` base while the same binary supports
  a host-side stdio client.
- No API contract changes were required; response schemas are mirrored in `apps/mcp/src/schemas.ts`
  and validated at the boundary.
- Optional §11 resources and the `weekly_briefing` prompt are deferred; Phase 8's acceptance
  covers the five required tools.
- The MCP package remains private. `npx @trendr/mcp` becomes usable only after publishing; the
  README documents the compiled `node dist/main.js` path for now.
