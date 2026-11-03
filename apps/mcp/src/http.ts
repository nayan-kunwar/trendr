import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { ApiClient } from './api-client.js';
import { createTrendrMcpServer } from './server.js';

export interface McpHttpServerOptions {
  /** Static bearer tokens; empty means unauthenticated (development default). */
  authTokens?: readonly string[];
}

export interface McpHttpServerHandle {
  server: Server;
  close(): Promise<void>;
}

interface ActivePair {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function sendRpcError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32000, message },
  });
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isAuthorized(request: IncomingMessage, tokens: readonly string[]): boolean {
  if (tokens.length === 0) {
    return true;
  }
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return false;
  }
  const provided = header.slice('Bearer '.length);
  return tokens.some((token) => constantTimeEquals(provided, token));
}

/**
 * Stateless Streamable HTTP transport (spec §11.2): each POST gets its own
 * McpServer/transport pair because there is no session state to preserve. GET
 * and DELETE therefore have no meaning and return 405, mirroring the SDK's
 * stateless example.
 */
export function createMcpHttpServer(
  api: ApiClient,
  options: McpHttpServerOptions = {},
): McpHttpServerHandle {
  const tokens = options.authTokens ?? [];
  const active = new Set<ActivePair>();
  let closing = false;

  const httpServer = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      sendRpcError(response, 500, error instanceof Error ? error.message : 'Internal server error');
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      if (request.method !== 'GET') {
        response.setHeader('allow', 'GET');
        sendRpcError(response, 405, 'Method not allowed');
        return;
      }
      sendJson(response, 200, { status: 'ok', name: 'trendr-mcp' });
      return;
    }

    if (url.pathname !== '/mcp') {
      sendRpcError(response, 404, 'Not found');
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      sendRpcError(
        response,
        405,
        'Method not allowed (stateless Streamable HTTP accepts POST only)',
      );
      return;
    }
    if (!isAuthorized(request, tokens)) {
      response.setHeader('www-authenticate', 'Bearer realm="trendr-mcp"');
      sendRpcError(response, 401, 'Unauthorized');
      return;
    }
    if (closing) {
      sendRpcError(response, 503, 'Server is shutting down');
      return;
    }

    const server = createTrendrMcpServer(api);
    // Omitting sessionIdGenerator is the SDK's stateless mode (undefined).
    const transport = new StreamableHTTPServerTransport();
    const pair = { server, transport };
    active.add(pair);

    response.once('close', () => {
      active.delete(pair);
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });

    await server.connect(transport);
    await transport.handleRequest(request, response);
  }

  return {
    server: httpServer,
    async close(): Promise<void> {
      if (closing) {
        return;
      }
      closing = true;
      await Promise.all(
        [...active].map(({ transport }) => transport.close().catch(() => undefined)),
      );
      active.clear();
      if (httpServer.listening) {
        await new Promise<void>((resolve, reject) => {
          httpServer.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      }
    },
  };
}
