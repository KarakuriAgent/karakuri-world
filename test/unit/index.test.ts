import { describe, expect, it } from 'vitest';

import { resolveRuntimeOptions } from '../../src/index.js';

describe('resolveRuntimeOptions', () => {
  it('defaults DATA_DIR to ./data', () => {
    const options = resolveRuntimeOptions({
      ADMIN_KEY: 'test-admin-key',
    });

    expect(options).toMatchObject({
      adminKey: 'test-admin-key',
      configPath: './config/example.yaml',
      dataDir: './data',
      port: 3000,
      publicBaseUrl: 'http://127.0.0.1:3000',
    });
  });

  it('uses DATA_DIR when provided', () => {
    const options = resolveRuntimeOptions({
      ADMIN_KEY: 'test-admin-key',
      DATA_DIR: './runtime-data',
      PORT: '4321',
    });

    expect(options.dataDir).toBe('./runtime-data');
    expect(options.port).toBe(4321);
  });
});
