import type { MiddlewareHandler } from 'hono';

import type { ApiEnv } from '../context.js';
import type { WorldEngine } from '../../engine/world-engine.js';
import { WorldError, toErrorResponse } from '../../types/api.js';

export function agentAuth(engine: WorldEngine): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const authorization = c.req.header('Authorization');
    if (!authorization?.startsWith('Bearer ')) {
      return c.json(toErrorResponse(new WorldError(401, 'unauthorized', 'Missing bearer token.')), 401);
    }

    const apiKey = authorization.slice('Bearer '.length);
    const registration = engine.getAgentByApiKey(apiKey);
    if (!registration) {
      return c.json(toErrorResponse(new WorldError(401, 'unauthorized', 'Invalid bearer token.')), 401);
    }

    c.set('agentId', registration.agent_id);
    c.set('agentRegistration', registration);
    await next();
  };
}

export function adminAuth(adminKey: string): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const header = c.req.header('X-Admin-Key');
    if (!header || header !== adminKey) {
      return c.json(toErrorResponse(new WorldError(401, 'unauthorized', 'Invalid admin key.')), 401);
    }

    await next();
  };
}
