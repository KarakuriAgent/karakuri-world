import type { Hono } from 'hono';
import { z } from 'zod';

import type { WorldEngine } from '../../engine/world-engine.js';
import type { ApiEnv } from '../context.js';
import { agentAuth } from '../middleware/auth.js';
import { requireJoined } from '../middleware/joined.js';
import { validateBody } from '../middleware/validate.js';

const selectSchema = z.object({
  server_event_id: z.string().min(1),
  choice_id: z.string().min(1),
});

export function registerAgentServerEventRoutes(app: Hono<ApiEnv>, engine: WorldEngine): void {
  app.post(
    '/api/agents/server-event/select',
    agentAuth(engine),
    requireJoined(engine),
    validateBody(selectSchema),
    (c) => {
      const agentId = c.get('agentId') as string;
      return c.json(engine.selectServerEvent(agentId, c.get('validatedBody') as z.infer<typeof selectSchema>));
    },
  );
}
