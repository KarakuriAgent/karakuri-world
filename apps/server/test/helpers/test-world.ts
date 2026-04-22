import { WorldEngine, type WorldEngineOptions } from '../../src/engine/world-engine.js';
import type { ServerConfig } from '../../src/types/data-model.js';
import { createTestConfig } from './test-map.js';
import { MockDiscordBot } from './mock-discord.js';

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<DeepPartial<U>>
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export function createTestWorld(options?: {
  config?: DeepPartial<ServerConfig>;
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
