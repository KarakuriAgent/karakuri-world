import type { Hono } from 'hono';

import { emitInfoRequest } from '../../domain/info-commands.js';
import type { WorldEngine } from '../../engine/world-engine.js';
import type { ApiEnv } from '../context.js';
import { agentAuth } from '../middleware/auth.js';
import { requireLoggedIn } from '../middleware/logged-in.js';

export function registerAgentInfoRoutes(app: Hono<ApiEnv>, engine: WorldEngine): void {
  app.get('/api/agents/perception', agentAuth(engine), requireLoggedIn(engine), (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(emitInfoRequest(engine, agentId, 'get_perception'));
  });

  app.get('/api/agents/map', agentAuth(engine), requireLoggedIn(engine), (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(emitInfoRequest(engine, agentId, 'get_map'));
  });

  app.get('/api/agents/world-agents', agentAuth(engine), requireLoggedIn(engine), (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(emitInfoRequest(engine, agentId, 'get_world_agents'));
  });

  app.get('/api/agents/status', agentAuth(engine), requireLoggedIn(engine), (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(emitInfoRequest(engine, agentId, 'get_status'));
  });

  app.get('/api/agents/nearby-agents', agentAuth(engine), requireLoggedIn(engine), (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(emitInfoRequest(engine, agentId, 'get_nearby_agents'));
  });

  app.get('/api/agents/active-conversations', agentAuth(engine), requireLoggedIn(engine), (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(emitInfoRequest(engine, agentId, 'get_active_conversations'));
  });
}
