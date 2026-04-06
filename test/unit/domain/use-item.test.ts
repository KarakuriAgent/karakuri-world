import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorldEngine } from '../../../src/engine/world-engine.js';
import type { WorldEvent } from '../../../src/types/event.js';
import { createTestWorld } from '../../helpers/test-world.js';

async function createLoggedInAgent(engine: WorldEngine, agentName = 'alice') {
  const agent = engine.registerAgent({ agent_name: agentName, agent_label: agentName, discord_bot_id: `bot-${agentName}` });
  await engine.loginAgent(agent.agent_id);
  return agent;
}

describe('use-item domain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects venue item use without consuming and emits venue_rejected with hints', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [
          { item_id: 'ticket', name: 'チケット', description: 'テスト用チケット', type: 'venue' as const, stackable: false },
        ],
        map: {
          ...createTestWorld().config.map,
          buildings: [
            {
              ...createTestWorld().config.map.buildings[0],
              actions: [
                ...createTestWorld().config.map.buildings[0].actions,
                {
                  action_id: 'use-ticket',
                  name: 'Use ticket',
                  description: 'Use the ticket.',
                  duration_ms: 500,
                  required_items: [{ item_id: 'ticket', quantity: 1 }],
                },
              ],
            },
          ],
        },
      },
    });
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '2-4');
    engine.state.setItems(alice.agent_id, [{ item_id: 'ticket', quantity: 1 }]);

    const events: WorldEvent[] = [];
    engine.eventBus.onAny((event) => events.push(event));

    const response = engine.useItem(alice.agent_id, { item_id: 'ticket' });
    expect(response.ok).toBe(true);

    const rejected = events.find((e) => e.type === 'item_use_venue_rejected');
    expect(rejected).toBeDefined();
    if (rejected?.type === 'item_use_venue_rejected') {
      expect(rejected.venue_hints.length).toBeGreaterThan(0);
      expect(rejected.venue_hints[0]).toContain('Clockwork Workshop');
    }

    // Item is NOT consumed
    expect(engine.state.getLoggedIn(alice.agent_id)?.items).toEqual([{ item_id: 'ticket', quantity: 1 }]);
    // Agent remains idle
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
    // No started event
    expect(events.some((e) => e.type === 'item_use_started')).toBe(false);
  });

  it('consumes general/food/drink items and emits completed with item_type', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [
          { item_id: 'bread', name: 'パン', description: '焼きたて', type: 'food' as const, stackable: true, max_stack: 5 },
        ],
      },
    });
    const alice = await createLoggedInAgent(engine);
    engine.state.setItems(alice.agent_id, [{ item_id: 'bread', quantity: 2 }]);

    const events: WorldEvent[] = [];
    engine.eventBus.onAny((event) => events.push(event));

    engine.useItem(alice.agent_id, { item_id: 'bread' });
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('in_action');

    vi.advanceTimersByTime(600000);

    const completed = events.find((e) => e.type === 'item_use_completed');
    expect(completed).toBeDefined();
    if (completed?.type === 'item_use_completed') {
      expect(completed.item_type).toBe('food');
    }

    // Item consumed
    expect(engine.state.getLoggedIn(alice.agent_id)?.items).toEqual([{ item_id: 'bread', quantity: 1 }]);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
  });

  it('resolves venue hints from multiple buildings and NPCs', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [
          { item_id: 'pass', name: 'パス', description: 'テスト用パス', type: 'venue' as const, stackable: false },
        ],
        map: {
          ...createTestWorld().config.map,
          buildings: [
            {
              ...createTestWorld().config.map.buildings[0],
              actions: [
                ...createTestWorld().config.map.buildings[0].actions,
                {
                  action_id: 'enter-workshop',
                  name: 'Enter workshop',
                  description: 'Enter with pass.',
                  duration_ms: 500,
                  required_items: [{ item_id: 'pass', quantity: 1 }],
                },
              ],
            },
          ],
          npcs: [
            {
              ...createTestWorld().config.map.npcs[0],
              actions: [
                ...createTestWorld().config.map.npcs[0].actions,
                {
                  action_id: 'show-pass-to-gatekeeper',
                  name: 'Show pass',
                  description: 'Show pass to gatekeeper.',
                  duration_ms: 500,
                  required_items: [{ item_id: 'pass', quantity: 1 }],
                },
              ],
            },
          ],
        },
      },
    });
    const alice = await createLoggedInAgent(engine);
    engine.state.setItems(alice.agent_id, [{ item_id: 'pass', quantity: 1 }]);

    const events: WorldEvent[] = [];
    engine.eventBus.onAny((event) => events.push(event));

    engine.useItem(alice.agent_id, { item_id: 'pass' });

    const rejected = events.find((e) => e.type === 'item_use_venue_rejected');
    expect(rejected).toBeDefined();
    if (rejected?.type === 'item_use_venue_rejected') {
      expect(rejected.venue_hints).toHaveLength(2);
      expect(rejected.venue_hints[0]).toContain('Clockwork Workshop');
      expect(rejected.venue_hints[1]).toContain('Gatekeeper');
    }
  });
});
