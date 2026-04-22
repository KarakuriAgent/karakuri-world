import {
  PRIMARY_BRIDGE_NAME,
  UIBridgeDurableObject,
  type DurableObjectNamespaceLike,
  type RelayBindings,
} from './relay/bridge.js';
import { handleHistoryRequest } from './history/api.js';
import { parseHistoryCorsConfig, parseHistoryCorsConfigFallback } from './relay/env.js';

export { PRIMARY_BRIDGE_NAME, UIBridgeDurableObject };
export type RelayWorkerEnv = RelayBindings & {
  UI_BRIDGE: DurableObjectNamespaceLike;
};

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function authorizePublishRequest(request: Request, env: RelayWorkerEnv): Response | null {
  const expectedAuth = typeof env.SNAPSHOT_PUBLISH_AUTH_KEY === 'string' ? env.SNAPSHOT_PUBLISH_AUTH_KEY.trim() : '';

  if (!expectedAuth) {
    return jsonResponse(
      {
        error: {
          code: 'service_unavailable',
          message: 'Snapshot publish endpoints are disabled.',
        },
      },
      503,
    );
  }

  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${expectedAuth}`) {
    return jsonResponse(
      {
        error: {
          code: 'unauthorized',
          message: 'Invalid publish authorization.',
        },
      },
      401,
    );
  }

  return null;
}

export default {
  async fetch(request: Request, env: RelayWorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      return new Response(null, { status: 404 });
    }

    if (url.pathname === '/api/history') {
      try {
        return handleHistoryRequest(request, env.SNAPSHOT_BUCKET, parseHistoryCorsConfig(env));
      } catch (error) {
        return handleHistoryRequest(request, env.SNAPSHOT_BUCKET, parseHistoryCorsConfigFallback(env), error);
      }
    }

    if (url.pathname === '/api/publish-snapshot' || url.pathname === '/api/publish-agent-history') {
      if (request.method !== 'POST') {
        return new Response(null, {
          status: 405,
          headers: {
            allow: 'POST',
          },
        });
      }

      const authFailure = authorizePublishRequest(request, env);
      if (authFailure) {
        return authFailure;
      }
    }

    const id = env.UI_BRIDGE.idFromName(PRIMARY_BRIDGE_NAME);
    return env.UI_BRIDGE.get(id).fetch(request);
  },
};
