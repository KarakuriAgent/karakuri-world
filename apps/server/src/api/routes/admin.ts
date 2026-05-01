import type { Hono } from 'hono';
import { z } from 'zod';

import type { WorldEngine } from '../../engine/world-engine.js';
import { WorldError } from '../../types/api.js';
import type { ApiEnv } from '../context.js';
import { adminAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';


const registerAgentSchema = z.object({
  discord_bot_id: z.string().min(1),
});

const descriptionSchema = z.object({
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
    const registration = await engine.registerAgent(body);
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

  app.post('/api/admin/server-announcements/fire', adminAuth(options.adminKey), validateBody(descriptionSchema), (c) => {
    const body = c.get('validatedBody') as z.infer<typeof descriptionSchema>;
    return c.json(engine.fireServerAnnouncement(body));
  });

  app.post('/api/admin/server-events', adminAuth(options.adminKey), validateBody(descriptionSchema), (c) => {
    const body = c.get('validatedBody') as z.infer<typeof descriptionSchema>;
    return c.json(engine.createServerEvent(body), 201);
  });

  app.get('/api/admin/server-events', adminAuth(options.adminKey), (c) => {
    return c.json(engine.listServerEvents(c.req.query('include_cleared') === 'true'));
  });

  app.delete('/api/admin/server-events/:event_id', adminAuth(options.adminKey), (c) => {
    const eventId = c.req.param('event_id');
    try {
      engine.clearServerEvent(eventId);
    } catch (error) {
      if (error instanceof WorldError) {
        if (error.code === 'not_found') {
          console.warn('server_event_not_found', { event_id: eventId });
        }
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      engine.reportError(`/api/admin/server-events DELETE で予期せぬエラー (event_id=${eventId}): ${message}`);
      throw error;
    }
    return c.body(null, 204);
  });
}
