import type { Hono } from 'hono';
import { z } from 'zod';

import type { WorldEngine } from '../../engine/world-engine.js';
import type { ApiEnv } from '../context.js';
import { agentAuth } from '../middleware/auth.js';
import { requireLoggedIn } from '../middleware/logged-in.js';
import { validateBody } from '../middleware/validate.js';
import { transferIdSchema, transferRequestSchema } from '../schemas/transfer.js';

export function registerAgentTransferRoutes(app: Hono<ApiEnv>, engine: WorldEngine): void {
  app.post('/api/agents/transfer', agentAuth(engine), requireLoggedIn(engine), validateBody(transferRequestSchema), (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(engine.startTransfer(agentId, c.get('validatedBody') as z.infer<typeof transferRequestSchema>));
  });

  app.post('/api/agents/transfer/accept', agentAuth(engine), requireLoggedIn(engine), validateBody(transferIdSchema), (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(engine.acceptTransfer(agentId, c.get('validatedBody') as z.infer<typeof transferIdSchema>));
  });

  app.post('/api/agents/transfer/reject', agentAuth(engine), requireLoggedIn(engine), validateBody(transferIdSchema), (c) => {
    const agentId = c.get('agentId') as string;
    return c.json(engine.rejectTransfer(agentId, c.get('validatedBody') as z.infer<typeof transferIdSchema>));
  });
}
