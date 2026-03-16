import type { Hono } from 'hono';

import type { WorldEngine } from '../../engine/world-engine.js';
import type { ApiEnv } from '../context.js';
import { agentAuth } from '../middleware/auth.js';

export function registerAgentLifecycleRoutes(app: Hono<ApiEnv>, engine: WorldEngine): void {
  app.post('/api/agents/login', agentAuth(engine), async (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(await engine.loginAgent(agentId));
  });

  app.post('/api/agents/logout', agentAuth(engine), async (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(await engine.logoutAgent(agentId));
  });
}
