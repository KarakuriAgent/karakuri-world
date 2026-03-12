import type { Hono } from 'hono';

import type { WorldEngine } from '../../engine/world-engine.js';
import type { ApiEnv } from '../context.js';

export function registerUiRoutes(app: Hono<ApiEnv>, engine: WorldEngine): void {
  app.get('/api/snapshot', (c) => {
    return c.json(engine.getSnapshot());
  });
}
