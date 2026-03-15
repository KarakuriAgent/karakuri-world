import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MapConfig } from '../../src/types/data-model.js';
import { createApp } from '../../src/api/app.js';
import { createTestMapConfig } from '../helpers/test-map.js';
import { createTestWorld } from '../helpers/test-world.js';

const ADMIN_KEY = 'admin';
const CONFIG_PATH = './config/example.yaml';

type FetchableApp = {
  fetch: (request: Request) => Response | Promise<Response>;
};

async function requestJson(app: FetchableApp, path: string, init?: RequestInit): Promise<{ response: Response; data: any }> {
  const response = await app.fetch(new Request(`http://localhost${path}`, init));
  return {
    response,
    data: await response.json(),
  };
}

function createActionOnPathMap(): MapConfig {
  const map = createTestMapConfig();
  return {
    ...map,
    nodes: {
      ...map.nodes,
      '2-2': { type: 'npc', label: 'Courier', npc_id: 'npc-courier' },
    },
    npcs: [
      ...map.npcs,
      {
        npc_id: 'npc-courier',
        name: 'Courier',
        description: 'A messenger waiting beside the road.',
        node_id: '2-2',
        actions: [
          {
            action_id: 'ask-courier',
            name: 'Ask the courier',
            description: 'Ask the courier for the latest news.',
            duration_ms: 900,
            result_description: 'The courier shares the latest town gossip.',
          },
        ],
      },
    ],
  };
}

describe('movement integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reports intermediate positions and movement paths while an agent is traveling', async () => {
    const { engine } = createTestWorld({
      config: {
        spawn: { nodes: ['3-1'] },
        map: createActionOnPathMap(),
      },
    });
    const { app } = createApp(engine, {
      adminKey: ADMIN_KEY,
      configPath: CONFIG_PATH,
      publicBaseUrl: 'http://localhost:3000',
    });
    const alice = engine.registerAgent({ agent_name: 'alice', discord_bot_id: 'bot-alice' });
    await engine.joinAgent(alice.agent_id);

    const move = engine.move(alice.agent_id, { target_node_id: '1-1' });
    vi.advanceTimersByTime(1000);

    expect(engine.getPerception(alice.agent_id).current_node.node_id).toBe('2-1');
    expect(engine.getWorldAgents().agents).toEqual([
      expect.objectContaining({
        agent_id: alice.agent_id,
        node_id: '2-1',
        state: 'moving',
      }),
    ]);
    expect(engine.getAvailableActions(alice.agent_id).actions).toEqual([
      expect.objectContaining({
        action_id: 'ask-courier',
      }),
    ]);

    const snapshot = await requestJson(app, '/api/snapshot', {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(snapshot.response.status).toBe(200);
    expect(snapshot.data.agents).toEqual([
      expect.objectContaining({
        agent_id: alice.agent_id,
        node_id: '2-1',
        state: 'moving',
        movement: {
          from_node_id: '3-1',
          to_node_id: '1-1',
          path: ['2-1', '1-1'],
          arrives_at: move.arrives_at,
        },
      }),
    ]);
  });
});
