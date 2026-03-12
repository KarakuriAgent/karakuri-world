import type { Hono } from 'hono';
import { z } from 'zod';

import type { WorldEngine } from '../../engine/world-engine.js';
import type { ApiEnv } from '../context.js';
import { agentAuth } from '../middleware/auth.js';
import { requireJoined } from '../middleware/joined.js';
import { validateBody } from '../middleware/validate.js';

const startConversationSchema = z.object({
  target_agent_id: z.string().min(1),
  message: z.string().min(1),
});

const conversationIdSchema = z.object({
  conversation_id: z.string().min(1),
});

const speakSchema = z.object({
  conversation_id: z.string().min(1),
  message: z.string().min(1),
});

export function registerAgentConversationRoutes(app: Hono<ApiEnv>, engine: WorldEngine): void {
  app.post(
    '/api/agents/conversation/start',
    agentAuth(engine),
    requireJoined(engine),
    validateBody(startConversationSchema),
    (c) => {
      const agentId = c.get('agentId') as string;
      return c.json(engine.startConversation(agentId, c.get('validatedBody') as z.infer<typeof startConversationSchema>));
    },
  );

  app.post(
    '/api/agents/conversation/accept',
    agentAuth(engine),
    requireJoined(engine),
    validateBody(conversationIdSchema),
    (c) => {
      const agentId = c.get('agentId') as string;
      return c.json(engine.acceptConversation(agentId, c.get('validatedBody') as z.infer<typeof conversationIdSchema>));
    },
  );

  app.post(
    '/api/agents/conversation/reject',
    agentAuth(engine),
    requireJoined(engine),
    validateBody(conversationIdSchema),
    (c) => {
      const agentId = c.get('agentId') as string;
      return c.json(engine.rejectConversation(agentId, c.get('validatedBody') as z.infer<typeof conversationIdSchema>));
    },
  );

  app.post(
    '/api/agents/conversation/speak',
    agentAuth(engine),
    requireJoined(engine),
    validateBody(speakSchema),
    (c) => {
      const agentId = c.get('agentId') as string;
      return c.json(engine.speak(agentId, c.get('validatedBody') as z.infer<typeof speakSchema>));
    },
  );
}
