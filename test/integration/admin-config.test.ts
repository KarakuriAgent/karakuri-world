import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { loadConfigFromFile, saveConfigToFile } from '../../src/config/index.js';
import { createTestConfig } from '../helpers/test-map.js';
import { createTestWorld } from '../helpers/test-world.js';

const ADMIN_KEY = 'test-admin-key';
const PUBLIC_BASE_URL = 'http://localhost:3000';

type FetchableApp = {
  fetch: (request: Request) => Response | Promise<Response>;
};

async function requestJson(
  app: FetchableApp,
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; data: any }> {
  const headers = new Headers(init.headers ?? {});
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers,
    }),
  );
  return {
    response,
    data: await response.json(),
  };
}

async function createAdminConfigApp() {
  const tempDir = await mkdtemp(join(tmpdir(), 'karakuri-world-admin-config-'));
  const configPath = join(tempDir, 'config.yaml');
  await saveConfigToFile(configPath, createTestConfig());

  const { engine } = createTestWorld();
  const { app } = createApp(engine, {
    adminKey: ADMIN_KEY,
    configPath,
    publicBaseUrl: PUBLIC_BASE_URL,
  });

  return {
    app,
    configPath,
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

describe('admin config routes', () => {
  it('reads, validates, and updates the config file', async () => {
    const runtime = await createAdminConfigApp();

    try {
      const loaded = await requestJson(runtime.app, '/api/admin/config', {
        headers: { 'X-Admin-Key': ADMIN_KEY },
      });
      expect(loaded.response.status).toBe(200);
      expect(loaded.data.config.world.name).toBe('Karakuri Test World');

      const validate = await requestJson(runtime.app, '/api/admin/config/validate', {
        method: 'POST',
        headers: { 'X-Admin-Key': ADMIN_KEY },
        body: JSON.stringify({ config: loaded.data.config }),
      });
      expect(validate.response.status).toBe(200);
      expect(validate.data).toEqual({ valid: true });

      const updatedConfig = {
        ...loaded.data.config,
        world: {
          ...loaded.data.config.world,
          name: 'Edited World',
        },
      };
      const updated = await requestJson(runtime.app, '/api/admin/config', {
        method: 'PUT',
        headers: { 'X-Admin-Key': ADMIN_KEY },
        body: JSON.stringify({ config: updatedConfig }),
      });
      expect(updated.response.status).toBe(200);
      expect(updated.data).toEqual({ status: 'ok' });

      await expect(loadConfigFromFile(runtime.configPath)).resolves.toMatchObject({
        world: { name: 'Edited World' },
      });
    } finally {
      await runtime.cleanup();
    }
  });

  it('returns 401 and validation_error responses when appropriate', async () => {
    const runtime = await createAdminConfigApp();

    try {
      const unauthorized = await requestJson(runtime.app, '/api/admin/config');
      expect(unauthorized.response.status).toBe(401);
      expect(unauthorized.data.error).toBe('unauthorized');

      const invalidConfig = createTestConfig();
      const wallNode = invalidConfig.map.nodes['1-3'];
      if (!wallNode) {
        throw new Error('Expected test wall node to exist.');
      }
      delete wallNode.building_id;

      const invalidUpdate = await requestJson(runtime.app, '/api/admin/config', {
        method: 'PUT',
        headers: { 'X-Admin-Key': ADMIN_KEY },
        body: JSON.stringify({ config: invalidConfig }),
      });
      expect(invalidUpdate.response.status).toBe(400);
      expect(invalidUpdate.data.error).toBe('validation_error');
      expect(invalidUpdate.data.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'map.nodes.1-3.building_id',
          }),
        ]),
      );
    } finally {
      await runtime.cleanup();
    }
  });
});
