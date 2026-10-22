import { loadMcpEnv } from './env.js';

export { McpEnvSchema, readMcpEnv } from './env.js';
export const mcpEnv = loadMcpEnv();

export type { McpEnv, McpEnvReadFailure, McpEnvReadResult, McpEnvReadSuccess } from './env.js';
