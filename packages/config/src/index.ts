import { loadEnv } from './env.js';

export {
  EnvSchema,
  McpEnvSchema,
  formatEnvError,
  loadEnv,
  loadMcpEnv,
  readEnv,
  readMcpEnv,
} from './env.js';
export type {
  Env,
  EnvReadFailure,
  EnvReadResult,
  EnvReadSuccess,
  McpEnv,
  McpEnvReadFailure,
  McpEnvReadResult,
  McpEnvReadSuccess,
} from './env.js';

// Validated at import time: any process importing `@trendr/config` fails fast
// with a readable message when a variable is missing or invalid (spec §14).
export const env = loadEnv();
