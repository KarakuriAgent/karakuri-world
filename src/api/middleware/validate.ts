import type { MiddlewareHandler } from 'hono';
import type { ZodTypeAny } from 'zod';

import { WorldError, toErrorResponse } from '../../types/api.js';
import type { ApiEnv } from '../context.js';

export function validateBody<TSchema extends ZodTypeAny>(schema: TSchema): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(toErrorResponse(new WorldError(400, 'invalid_request', 'Request body must be valid JSON.')), 400);
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      return c.json(
        toErrorResponse(
          new WorldError(400, 'invalid_request', 'Request validation failed.', parsed.error.flatten()),
        ),
        400,
      );
    }

    c.set('validatedBody', parsed.data);
    await next();
  };
}
