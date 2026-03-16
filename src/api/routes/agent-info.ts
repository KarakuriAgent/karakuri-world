import type { Hono } from 'hono';

import type { WorldEngine } from '../../engine/world-engine.js';
import type { ApiEnv } from '../context.js';
import { agentAuth } from '../middleware/auth.js';
import { requireLoggedIn } from '../middleware/logged-in.js';

export function registerAgentInfoRoutes(app: Hono<ApiEnv>, engine: WorldEngine): void {
  app.get('/api/agents/perception', agentAuth(engine), requireLoggedIn(engine), (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(engine.getPerception(agentId));
  });

  app.get('/api/agents/map', agentAuth(engine), requireLoggedIn(engine), (c) => {
    return c.json(engine.getMap());
  });

  app.get('/api/agents/world-agents', agentAuth(engine), requireLoggedIn(engine), (c) => {
    return c.json(engine.getWorldAgents());
  });
}
