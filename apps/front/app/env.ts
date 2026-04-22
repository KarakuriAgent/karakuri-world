import { readEnv, type AppEnv } from './env-contract.js';

export type { AppEnv } from './env-contract.js';

export function getEnv(): AppEnv {
  return readEnv(import.meta.env as Record<string, string | undefined>);
}
