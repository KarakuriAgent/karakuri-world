import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';

import type { WorldEngine } from '../engine/world-engine.js';
import { WorldError, toErrorResponse } from '../types/api.js';
import type { ApiEnv } from './context.js';
import { adminAuth } from './middleware/auth.js';
import { registerAdminConfigRoutes } from './routes/admin-config.js';
import { registerAdminEditorRoutes } from './routes/admin-editor.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAgentActionRoutes } from './routes/agent-actions.js';
import { registerAgentConversationRoutes } from './routes/agent-conversation.js';
import { registerAgentInfoRoutes } from './routes/agent-info.js';
import { registerAgentLifecycleRoutes } from './routes/agent-lifecycle.js';
import { registerAgentServerEventRoutes } from './routes/agent-server-event.js';
import { registerUiRoutes } from './routes/ui.js';
import { WebSocketManager } from './websocket.js';

export interface AppOptions {
  adminKey: string;
  configPath: string;
  publicBaseUrl: string;
}

export function createApp(engine: WorldEngine, options: AppOptions) {
  const app = new Hono<ApiEnv>();
  const websocketManager = new WebSocketManager(engine);
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.onError((error, c) => {
    if (error instanceof WorldError) {
      return c.json(toErrorResponse(error), { status: error.status as 400 | 401 | 403 | 404 | 409 | 500 | 501 });
    }

    console.error(error);
    return c.json(toErrorResponse(new WorldError(500, 'state_conflict', 'Internal server error.')), { status: 500 });
  });

  registerAdminRoutes(app, engine, options);
  registerAdminConfigRoutes(app, { adminKey: options.adminKey, configPath: options.configPath });
  registerAdminEditorRoutes(app);
  registerAgentLifecycleRoutes(app, engine);
  registerAgentActionRoutes(app, engine);
  registerAgentConversationRoutes(app, engine);
  registerAgentInfoRoutes(app, engine);
  registerAgentServerEventRoutes(app, engine);
  registerUiRoutes(app, engine, { adminKey: options.adminKey });

  app.get(
    '/ws',
    adminAuth(options.adminKey),
    upgradeWebSocket(() => ({
      onOpen: (_event, ws) => {
        websocketManager.handleOpen(ws);
      },
      onClose: (_event, ws) => {
        websocketManager.handleClose(ws);
      },
      onError: (_event, ws) => {
        websocketManager.handleClose(ws);
      },
    })),
  );

  return {
    app,
    injectWebSocket,
    websocketManager,
  };
}
