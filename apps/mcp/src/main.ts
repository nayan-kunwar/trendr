import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { env } from '@trendr/config';
import { createLogger } from '@trendr/logger';

const logger = createLogger({ service: 'mcp', level: env.LOG_LEVEL });

// @trendr/mcp — read-only MCP server (spec §12) arrives in Phase 8. Until then
// the stub keeps the compose service up: the HTTP transport answers 404 on
// every path, the stdio transport just keeps the process alive.
const server: Server | null =
  env.MCP_TRANSPORT === 'http'
    ? createServer((_request, response) => {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'not-found', name: 'trendr-mcp', status: 'stub' }));
      })
    : null;

if (server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.MCP_PORT, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info({ port: env.MCP_PORT }, 'mcp stub listening (the real server arrives in Phase 8)');
} else {
  logger.info(
    { transport: env.MCP_TRANSPORT },
    'mcp stdio stub (the real server arrives in Phase 8)',
  );
  process.stdin.resume();
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, 'mcp stopping');
  try {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
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
