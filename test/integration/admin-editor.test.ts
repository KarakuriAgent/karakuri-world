import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createTestWorld } from '../helpers/test-world.js';

const CONFIG_PATH = './config/example.yaml';

type FetchableApp = {
  fetch: (request: Request) => Response | Promise<Response>;
};

async function requestText(app: FetchableApp, path: string) {
  const response = await app.fetch(new Request(`http://localhost${path}`));
  return {
    response,
    text: await response.text(),
  };
}

describe('admin editor routes', () => {
  it('serves editor assets', async () => {
    const { engine } = createTestWorld();
    const { app } = createApp(engine, {
      adminKey: 'admin',
      configPath: CONFIG_PATH,
      publicBaseUrl: 'http://localhost:3000',
    });

    const index = await requestText(app, '/admin/editor');
    expect(index.response.status).toBe(200);
    expect(index.text).toContain('Karakuri World Map Editor');

    const script = await requestText(app, '/admin/editor/editor.js');
    expect(script.response.status).toBe(200);
    expect(script.text).toContain('loadConfig');

    const stylesheet = await requestText(app, '/admin/editor/editor.css');
    expect(stylesheet.response.status).toBe(200);
    expect(stylesheet.text).toContain('.app');
  });

  it('rejects unknown or traversal asset paths', async () => {
    const { engine } = createTestWorld();
    const { app } = createApp(engine, {
      adminKey: 'admin',
      configPath: CONFIG_PATH,
      publicBaseUrl: 'http://localhost:3000',
    });

    const missing = await requestText(app, '/admin/editor/unknown.js');
    expect(missing.response.status).toBe(404);

    const traversal = await requestText(app, '/admin/editor/..%2fconfig.yaml');
    expect(traversal.response.status).toBe(404);
  });
});
