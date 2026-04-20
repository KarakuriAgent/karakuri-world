import { describe, expect, it } from 'vitest';

import { resolveRuntimeOptions } from '../../src/index.js';

const baseEnv = {
  ADMIN_KEY: 'test-admin-key',
  SNAPSHOT_PUBLISH_BASE_URL: 'https://relay.example.com',
  SNAPSHOT_PUBLISH_AUTH_KEY: 'publish-key',
  DISCORD_TOKEN: 'test-token',
  DISCORD_GUILD_ID: 'test-guild',
} as const;

describe('resolveRuntimeOptions', () => {
  it('defaults DATA_DIR to ./data', () => {
    const options = resolveRuntimeOptions(baseEnv);

    expect(options).toMatchObject({
      adminKey: 'test-admin-key',
      configPath: './config/example.yaml',
      dataDir: './data',
      port: 3000,
      publicBaseUrl: 'http://127.0.0.1:3000',
      snapshotPublishBaseUrl: 'https://relay.example.com',
      snapshotPublishAuthKey: 'publish-key',
      discordToken: 'test-token',
      discordGuildId: 'test-guild',
      statusBoardDebounceMs: 3000,
    });
  });

  it('uses DATA_DIR when provided', () => {
    const options = resolveRuntimeOptions({
      ...baseEnv,
      DATA_DIR: './runtime-data',
      PORT: '4321',
    });

    expect(options.dataDir).toBe('./runtime-data');
    expect(options.port).toBe(4321);
  });

  it('uses STATUS_BOARD_DEBOUNCE_MS when provided', () => {
    const options = resolveRuntimeOptions({
      ...baseEnv,
      STATUS_BOARD_DEBOUNCE_MS: '1500',
    });

    expect(options.statusBoardDebounceMs).toBe(1500);
  });

  it('throws when STATUS_BOARD_DEBOUNCE_MS is invalid', () => {
    expect(() =>
      resolveRuntimeOptions({
        ...baseEnv,
        STATUS_BOARD_DEBOUNCE_MS: '-1',
      }),
    ).toThrow('Invalid STATUS_BOARD_DEBOUNCE_MS value: -1');
  });

  it('throws when DISCORD_TOKEN is missing', () => {
    expect(() =>
      resolveRuntimeOptions({
        ADMIN_KEY: 'test-admin-key',
        SNAPSHOT_PUBLISH_BASE_URL: 'https://relay.example.com',
        SNAPSHOT_PUBLISH_AUTH_KEY: 'publish-key',
        DISCORD_GUILD_ID: 'test-guild',
      }),
    ).toThrow('Missing required environment variable: DISCORD_TOKEN');
  });

  it('throws when DISCORD_GUILD_ID is missing', () => {
    expect(() =>
      resolveRuntimeOptions({
        ADMIN_KEY: 'test-admin-key',
        SNAPSHOT_PUBLISH_BASE_URL: 'https://relay.example.com',
        SNAPSHOT_PUBLISH_AUTH_KEY: 'publish-key',
        DISCORD_TOKEN: 'test-token',
      }),
    ).toThrow('Missing required environment variable: DISCORD_GUILD_ID');
  });

  it('throws when SNAPSHOT_PUBLISH_AUTH_KEY is missing', () => {
    expect(() =>
      resolveRuntimeOptions({
        ADMIN_KEY: 'test-admin-key',
        SNAPSHOT_PUBLISH_BASE_URL: 'https://relay.example.com',
        DISCORD_TOKEN: 'test-token',
        DISCORD_GUILD_ID: 'test-guild',
      }),
    ).toThrow('Missing required environment variable: SNAPSHOT_PUBLISH_AUTH_KEY');
  });
});
