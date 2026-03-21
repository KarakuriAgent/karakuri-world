import { WorldEngine, type WorldEngineOptions } from '../../src/engine/world-engine.js';
import type { ServerConfig } from '../../src/types/data-model.js';
import { createTestConfig } from './test-map.js';
import { MockDiscordBot } from './mock-discord.js';

export function createTestWorld(options?: {
  config?: Partial<ServerConfig>;
  dataDir?: string;
  engineOptions?: WorldEngineOptions;
}): {
  config: ServerConfig;
  discordBot: MockDiscordBot;
  engine: WorldEngine;
} {
  const config = createTestConfig(options?.config);
  const discordBot = new MockDiscordBot();
  const engineOptions: WorldEngineOptions | undefined = options?.engineOptions || options?.dataDir
    ? {
        ...options?.engineOptions,
        ...(options?.dataDir ? { dataDir: options.dataDir } : {}),
      }
    : undefined;
  const engine = new WorldEngine(config, discordBot, engineOptions);

  return {
    config,
    discordBot,
    engine,
  };
}
