import { Hono } from 'hono';

import type { WorldEngine } from '../engine/world-engine.js';
import { WorldError, toErrorResponse } from '../types/api.js';
import type { ApiEnv } from './context.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAgentActionRoutes } from './routes/agent-actions.js';
import { registerAgentConversationRoutes } from './routes/agent-conversation.js';
import { registerAgentInfoRoutes } from './routes/agent-info.js';
import { registerAgentLifecycleRoutes } from './routes/agent-lifecycle.js';
import { registerAgentTransferRoutes } from './routes/agent-transfer.js';
import { getShutdownErrorResponse, isRequestAllowedDuringShutdown } from './shutdown.js';

export interface AppOptions {
  adminKey: string;
  publicBaseUrl: string;
  isShuttingDown?: () => boolean;
}

export function createApp(engine: WorldEngine, options: AppOptions) {
  const app = new Hono<ApiEnv>();

  app.onError((error, c) => {
    if (error instanceof WorldError) {
      return c.json(toErrorResponse(error), { status: error.status as 400 | 401 | 403 | 404 | 409 | 500 | 501 | 503 });
    }

    // 未捕捉の例外は Sentry / 通知系へ届けるために engine.reportError も呼ぶ。
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    console.error(error);
    try {
      engine.reportError(`Unhandled error in API: ${c.req.method} ${c.req.path}: ${message}`);
    } catch (reportError) {
      console.error('engine.reportError threw.', reportError);
    }
    return c.json(toErrorResponse(new WorldError(500, 'state_conflict', 'Internal server error.')), { status: 500 });
  });

  app.use('*', async (c, next) => {
    if (options.isShuttingDown?.() && !isRequestAllowedDuringShutdown(c.req.method, c.req.path)) {
      return c.json(getShutdownErrorResponse(), { status: 503 });
    }

    await next();
  });

  registerAdminRoutes(app, engine, options);
  registerAgentLifecycleRoutes(app, engine);
  registerAgentActionRoutes(app, engine);
  registerAgentTransferRoutes(app, engine);
  registerAgentConversationRoutes(app, engine);
  registerAgentInfoRoutes(app, engine);

  app.get('/health', (c) => {
    const snapshotPublisher = engine.getSnapshotPublisherStats();
    const status = snapshotPublisher && (snapshotPublisher.state === 'retrying' || snapshotPublisher.state === 'failed')
      ? 'degraded'
      : 'ok';

    return c.json({
      status,
      ...(snapshotPublisher ? { snapshot_publisher: snapshotPublisher } : {}),
    });
  });

  return {
    app,
  };
}
