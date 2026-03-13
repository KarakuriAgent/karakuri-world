import { WorldEngine, type WorldEngineOptions } from '../../src/engine/world-engine.js';
import type { ServerConfig } from '../../src/types/data-model.js';
import { createTestConfig } from './test-map.js';
import { MockDiscordBot } from './mock-discord.js';

export function createTestWorld(options?: {
  config?: Partial<ServerConfig>;
  engineOptions?: WorldEngineOptions;
}): {
  config: ServerConfig;
  discordBot: MockDiscordBot;
  engine: WorldEngine;
} {
  const config = createTestConfig(options?.config);
  const discordBot = new MockDiscordBot();
  const engine = new WorldEngine(config, discordBot, options?.engineOptions);

  return {
    config,
    discordBot,
    engine,
  };
}
