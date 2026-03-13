import { describe, expect, it } from 'vitest';

import { resolveRuntimeOptions } from '../../src/index.js';

describe('resolveRuntimeOptions', () => {
  it('defaults DATA_DIR to ./data', () => {
    const options = resolveRuntimeOptions({
      ADMIN_KEY: 'test-admin-key',
      DISCORD_TOKEN: 'test-token',
      DISCORD_GUILD_ID: 'test-guild',
    });

    expect(options).toMatchObject({
      adminKey: 'test-admin-key',
      configPath: './config/example.yaml',
      dataDir: './data',
      port: 3000,
      publicBaseUrl: 'http://127.0.0.1:3000',
      discordToken: 'test-token',
      discordGuildId: 'test-guild',
    });
  });

  it('uses DATA_DIR when provided', () => {
    const options = resolveRuntimeOptions({
      ADMIN_KEY: 'test-admin-key',
      DATA_DIR: './runtime-data',
      PORT: '4321',
      DISCORD_TOKEN: 'test-token',
      DISCORD_GUILD_ID: 'test-guild',
    });

    expect(options.dataDir).toBe('./runtime-data');
    expect(options.port).toBe(4321);
  });

  it('throws when DISCORD_TOKEN is missing', () => {
    expect(() =>
      resolveRuntimeOptions({
        ADMIN_KEY: 'test-admin-key',
        DISCORD_GUILD_ID: 'test-guild',
      }),
    ).toThrow('Missing required environment variable: DISCORD_TOKEN');
  });

  it('throws when DISCORD_GUILD_ID is missing', () => {
    expect(() =>
      resolveRuntimeOptions({
        ADMIN_KEY: 'test-admin-key',
        DISCORD_TOKEN: 'test-token',
      }),
    ).toThrow('Missing required environment variable: DISCORD_GUILD_ID');
  });
});
