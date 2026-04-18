import {
  PRIMARY_BRIDGE_NAME,
  UIBridgeDurableObject,
  type DurableObjectNamespaceLike,
  type RelayBindings,
} from './relay/bridge.js';
import { handleHistoryRequest } from './history/api.js';
import { parseHistoryCorsConfig, parseHistoryCorsConfigFallback, parseHistoryRetentionDays } from './relay/env.js';
import { createConsoleRelayObservability } from './relay/observability.js';
import { runHistoryRetention } from './relay/retention.js';

export { PRIMARY_BRIDGE_NAME, UIBridgeDurableObject };
export type RelayWorkerEnv = RelayBindings & {
  UI_BRIDGE: DurableObjectNamespaceLike;
};

export default {
  async fetch(request: Request, env: RelayWorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/history') {
      try {
        return handleHistoryRequest(request, env.HISTORY_DB, parseHistoryCorsConfig(env));
      } catch (error) {
        return handleHistoryRequest(request, env.HISTORY_DB, parseHistoryCorsConfigFallback(env), error);
      }
    }

    const id = env.UI_BRIDGE.idFromName(PRIMARY_BRIDGE_NAME);
    return env.UI_BRIDGE.get(id).fetch(request);
  },
  async scheduled(_event: unknown, env: RelayWorkerEnv): Promise<void> {
    const now = () => Date.now();
    const observability = createConsoleRelayObservability(now);

    try {
      await runHistoryRetention(env.HISTORY_DB, parseHistoryRetentionDays(env), now, observability);
    } catch (error) {
      if (error instanceof Error && error.message === 'HISTORY_DB is required for relay history retention') {
        throw error;
      }

      if (error instanceof Error && /HISTORY_RETENTION_DAYS/.test(error.message)) {
        observability.counter('relay.d1.retention_run_total', { result: 'failure' });
        observability.log('error', 'relay history retention failed', {
          error: error.message,
        });
      }

      throw error;
    }
  },
};
