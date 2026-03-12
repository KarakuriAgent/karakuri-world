import type { MiddlewareHandler } from 'hono';

import type { WorldEngine } from '../../engine/world-engine.js';
import { WorldError, toErrorResponse } from '../../types/api.js';
import type { ApiEnv } from '../context.js';

export function requireJoined(engine: WorldEngine): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const agentId = c.get('agentId') as string | undefined;
    if (!agentId || !engine.state.isJoined(agentId)) {
      return c.json(toErrorResponse(new WorldError(403, 'not_joined', 'Agent is not joined.')), 403);
    }

    await next();
  };
}
