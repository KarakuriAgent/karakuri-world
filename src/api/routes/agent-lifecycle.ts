import type { Hono } from 'hono';

import type { WorldEngine } from '../../engine/world-engine.js';
import type { ApiEnv } from '../context.js';
import { agentAuth } from '../middleware/auth.js';

export function registerAgentLifecycleRoutes(app: Hono<ApiEnv>, engine: WorldEngine): void {
  app.post('/api/agents/join', agentAuth(engine), async (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(await engine.joinAgent(agentId));
  });

  app.post('/api/agents/leave', agentAuth(engine), async (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(await engine.leaveAgent(agentId));
  });
}
