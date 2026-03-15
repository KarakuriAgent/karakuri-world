import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfigFromFile, saveConfigToFile } from '../../../src/config/index.js';
import { createTestConfig } from '../../helpers/test-map.js';

describe('config file I/O', () => {
  it('loads a config saved as YAML', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'karakuri-world-config-'));
    const configPath = join(tempDir, 'config.yaml');
    const config = createTestConfig();

    try {
      await saveConfigToFile(configPath, config);

      await expect(loadConfigFromFile(configPath)).resolves.toEqual(config);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('overwrites the config file without leaving temporary files behind', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'karakuri-world-config-'));
    const configPath = join(tempDir, 'config.yaml');
    const config = createTestConfig();
    const nextConfig = createTestConfig();
    nextConfig.world.name = 'Updated Test World';

    try {
      await saveConfigToFile(configPath, config);
      await saveConfigToFile(configPath, nextConfig);

      await expect(loadConfigFromFile(configPath)).resolves.toEqual(nextConfig);
      await expect(readdir(tempDir)).resolves.toEqual(['config.yaml']);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
