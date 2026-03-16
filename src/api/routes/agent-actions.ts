import type { Hono } from 'hono';
import { z } from 'zod';

import type { WorldEngine } from '../../engine/world-engine.js';
import type { NodeId } from '../../types/data-model.js';
import type { ApiEnv } from '../context.js';
import { agentAuth } from '../middleware/auth.js';
import { requireLoggedIn } from '../middleware/logged-in.js';
import { validateBody } from '../middleware/validate.js';

const moveSchema = z.object({
  target_node_id: z.custom<NodeId>((value): value is NodeId => typeof value === 'string' && /^\d+-\d+$/.test(value)),
});

const actionSchema = z.object({
  action_id: z.string().min(1),
});

const waitSchema = z.object({
  duration_ms: z.number().int().min(1).max(3600000),
});

export function registerAgentActionRoutes(app: Hono<ApiEnv>, engine: WorldEngine): void {
  app.get('/api/agents/actions', agentAuth(engine), requireLoggedIn(engine), (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(engine.getAvailableActions(agentId));
  });

  app.post('/api/agents/move', agentAuth(engine), requireLoggedIn(engine), validateBody(moveSchema), (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(engine.move(agentId, c.get('validatedBody') as z.infer<typeof moveSchema>));
  });

  app.post('/api/agents/action', agentAuth(engine), requireLoggedIn(engine), validateBody(actionSchema), (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(engine.executeAction(agentId, c.get('validatedBody') as z.infer<typeof actionSchema>));
  });

  app.post('/api/agents/wait', agentAuth(engine), requireLoggedIn(engine), validateBody(waitSchema), (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(engine.executeWait(agentId, c.get('validatedBody') as z.infer<typeof waitSchema>));
  });
}
