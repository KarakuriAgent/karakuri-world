import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';

import type { ServerConfig } from '../types/data-model.js';
import { serverConfigSchema } from './schema.js';
import { validateServerConfig } from './validation.js';

export function parseConfig(rawConfig: unknown): ServerConfig {
  const config = serverConfigSchema.parse(rawConfig) as ServerConfig;
  validateServerConfig(config);
  return config;
}

export async function loadConfig(configPath: string): Promise<ServerConfig> {
  const configText = await readFile(configPath, 'utf8');
  return parseConfig(yaml.load(configText));
}
