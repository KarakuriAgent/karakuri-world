import type { Hono } from 'hono';
import { z } from 'zod';

import { agentNamePattern } from '../../domain/agent-validation.js';
import type { WorldEngine } from '../../engine/world-engine.js';
import { WorldError } from '../../types/api.js';
import type { ApiEnv } from '../context.js';
import { adminAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';


const registerAgentSchema = z.object({
  agent_name: z.string().min(2).max(32).regex(agentNamePattern),
  agent_label: z.string().min(1).max(100),
  discord_bot_id: z.string().min(1),
});

const fireServerEventSchema = z.object({
  description: z.string().trim().min(1),
});

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function registerAdminRoutes(
  app: Hono<ApiEnv>,
  engine: WorldEngine,
  options: { adminKey: string; publicBaseUrl: string },
): void {
  const publicBaseUrl = trimTrailingSlash(options.publicBaseUrl);

  app.post('/api/admin/agents', adminAuth(options.adminKey), validateBody(registerAgentSchema), async (c) => {
    const body = c.get('validatedBody') as z.infer<typeof registerAgentSchema>;
    const registration = engine.registerAgent(body);
    return c.json(
      {
        agent_id: registration.agent_id,
        api_key: registration.api_key,
        api_base_url: `${publicBaseUrl}/api`,
        mcp_endpoint: `${publicBaseUrl}/mcp`,
      },
      201,
    );
  });

  app.get('/api/admin/agents', adminAuth(options.adminKey), (c) => {
    return c.json({ agents: engine.listAgentSummaries() });
  });

  app.delete('/api/admin/agents/:agent_id', adminAuth(options.adminKey), async (c) => {
    const deleted = await engine.deleteAgent(c.req.param('agent_id'));
    if (!deleted) {
      throw new WorldError(404, 'not_found', 'Agent not found.');
    }

    return c.json({ status: 'ok' });
  });

  app.post('/api/admin/server-events/fire', adminAuth(options.adminKey), validateBody(fireServerEventSchema), (c) => {
    const body = c.get('validatedBody') as z.infer<typeof fireServerEventSchema>;
    return c.json(engine.fireServerEvent(body));
  });
}
