import type { Hono } from 'hono';
import { z } from 'zod';

import type { WorldEngine } from '../../engine/world-engine.js';
import type { ApiEnv } from '../context.js';
import { agentAuth } from '../middleware/auth.js';
import { requireJoined } from '../middleware/joined.js';
import { validateBody } from '../middleware/validate.js';

const moveSchema = z.object({
  direction: z.enum(['north', 'south', 'east', 'west']),
});

const actionSchema = z.object({
  action_id: z.string().min(1),
});

export function registerAgentActionRoutes(app: Hono<ApiEnv>, engine: WorldEngine): void {
  app.get('/api/agents/actions', agentAuth(engine), requireJoined(engine), (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(engine.getAvailableActions(agentId));
  });

  app.post('/api/agents/move', agentAuth(engine), requireJoined(engine), validateBody(moveSchema), (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(engine.move(agentId, c.get('validatedBody') as z.infer<typeof moveSchema>));
  });

  app.post('/api/agents/action', agentAuth(engine), requireJoined(engine), validateBody(actionSchema), (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(engine.executeAction(agentId, c.get('validatedBody') as z.infer<typeof actionSchema>));
  });
}
