import type { Hono } from 'hono';

import type { WorldEngine } from '../../engine/world-engine.js';
import type { ApiEnv } from '../context.js';
import { adminAuth } from '../middleware/auth.js';

export function registerUiRoutes(app: Hono<ApiEnv>, engine: WorldEngine, options: { adminKey: string }): void {
  app.get('/api/snapshot', adminAuth(options.adminKey), (c) => {
    return c.json(engine.getSnapshot());
  });
}
