#!/usr/bin/env node
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { mcpEnv } from '@trendr/config/mcp';
import { createLogger } from '@trendr/logger';

import { HttpApiClient } from './api-client.js';
import { createMcpHttpServer, type McpHttpServerHandle } from './http.js';
import { createTrendrMcpServer } from './server.js';

const transportMode = mcpEnv.MCP_TRANSPORT;
const logger = createLogger({
  service: 'mcp',
  level: mcpEnv.LOG_LEVEL,
  env: mcpEnv.NODE_ENV,
  // stdio uses stdout for JSON-RPC; every log line must stay on stderr.
  ...(transportMode === 'stdio' ? { destination: process.stderr } : {}),
});

const apiKey = mcpEnv.MCP_API_KEY?.trim() ?? undefined;
const api = new HttpApiClient({
  baseUrl: mcpEnv.API_INTERNAL_URL,
  ...(apiKey ? { apiKey } : {}),
});

let stdioServer: McpServer | undefined;
let httpHandle: McpHttpServerHandle | undefined;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, 'mcp stopping');
  try {
    if (stdioServer) {
      await stdioServer.close();
    }
    if (httpHandle) {
      await httpHandle.close();
    }
    process.exit(0);
  } catch (error: unknown) {
    logger.error({ err: error }, 'mcp failed to stop');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  if (transportMode === 'stdio') {
    stdioServer = createTrendrMcpServer(api);
    await stdioServer.connect(new StdioServerTransport());
    if (!apiKey) {
      logger.warn('MCP_API_KEY is not set; API calls will use anonymous rate limits');
    }
    logger.info('mcp stdio transport ready');
  } else {
    httpHandle = createMcpHttpServer(api, {
      ...(mcpEnv.MCP_HTTP_AUTH_TOKENS ? { authTokens: mcpEnv.MCP_HTTP_AUTH_TOKENS } : {}),
    });
    await new Promise<void>((resolve, reject) => {
      httpHandle?.server.once('error', reject);
      httpHandle?.server.listen(mcpEnv.MCP_PORT, '0.0.0.0', () => {
        httpHandle?.server.off('error', reject);
        resolve();
      });
    });
    if (!apiKey) {
      logger.warn('MCP_API_KEY is not set; API calls will use anonymous rate limits');
    }
    if (!mcpEnv.MCP_HTTP_AUTH_TOKENS?.length) {
      logger.warn('MCP_HTTP_AUTH_TOKENS is not set; /mcp is unauthenticated');
    }
    logger.info(
      { port: mcpEnv.MCP_PORT, baseUrl: mcpEnv.API_INTERNAL_URL },
      'mcp Streamable HTTP transport ready',
    );
  }
} catch (error: unknown) {
  logger.error({ err: error }, 'mcp failed to start');
  process.exit(1);
}
