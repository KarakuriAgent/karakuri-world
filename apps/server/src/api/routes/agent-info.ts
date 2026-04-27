import type { Hono } from 'hono';

import { requireInfoCommandReadyAgent } from '../../domain/agent-guards.js';
import type { WorldEngine } from '../../engine/world-engine.js';
import { createNotificationAcceptedResponse } from '../../types/api.js';
import type { ApiEnv } from '../context.js';
import { agentAuth } from '../middleware/auth.js';
import { requireLoggedIn } from '../middleware/logged-in.js';

export function registerAgentInfoRoutes(app: Hono<ApiEnv>, engine: WorldEngine): void {
  app.get('/api/agents/perception', agentAuth(engine), requireLoggedIn(engine), (c) => {
    const agentId = c.get('agentId') as string;
    requireInfoCommandReadyAgent(engine, agentId, 'get_perception');
    engine.state.addExcludedInfoCommand(agentId, 'get_perception');
    engine.emitEvent({ type: 'perception_requested', agent_id: agentId });
    return c.json(createNotificationAcceptedResponse());
  });

  app.get('/api/agents/map', agentAuth(engine), requireLoggedIn(engine), (c) => {
    const agentId = c.get('agentId') as string;
    requireInfoCommandReadyAgent(engine, agentId, 'get_map');
    engine.state.addExcludedInfoCommand(agentId, 'get_map');
    engine.emitEvent({ type: 'map_info_requested', agent_id: agentId });
    return c.json(createNotificationAcceptedResponse());
  });

  app.get('/api/agents/world-agents', agentAuth(engine), requireLoggedIn(engine), (c) => {
    const agentId = c.get('agentId') as string;
    requireInfoCommandReadyAgent(engine, agentId, 'get_world_agents');
    engine.state.addExcludedInfoCommand(agentId, 'get_world_agents');
    engine.emitEvent({ type: 'world_agents_info_requested', agent_id: agentId });
    return c.json(createNotificationAcceptedResponse());
  });
}
