import { loadEnv } from './env.js';

export { EnvSchema, formatEnvError, loadEnv, readEnv } from './env.js';
export type { Env, EnvReadFailure, EnvReadResult, EnvReadSuccess } from './env.js';

// Validated at import time: any process importing `@trendr/config` fails fast
// with a readable message when a variable is missing or invalid (spec §14).
export const env = loadEnv();
