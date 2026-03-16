import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCurrentMovementPosition } from '../../../src/domain/movement.js';
import { WorldError } from '../../../src/types/api.js';
import type { MovementTimer } from '../../../src/types/timer.js';
import type { MapConfig } from '../../../src/types/data-model.js';
import { createTestMapConfig } from '../../helpers/test-map.js';
import { createTestWorld } from '../../helpers/test-world.js';

function expectWorldError(error: unknown, code: WorldError['code'], status: number): void {
  expect(error).toBeInstanceOf(WorldError);
  expect(error).toMatchObject({ code, status });
}

const isolatedMap = {
  rows: 3,
  cols: 3,
  nodes: {
    '1-2': { type: 'wall' },
    '2-1': { type: 'wall' },
    '2-3': { type: 'wall' },
    '3-2': { type: 'wall' },
  },
  buildings: [],
  npcs: [],
} satisfies MapConfig;

describe('movement domain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts multi-step movement and completes it after path-length duration', async () => {
    const { engine } = createTestWorld({

      config: {
        spawn: { nodes: ['3-1'] },
      },
    });
    const alice = engine.registerAgent({ agent_name: 'alice', discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);

    const response = engine.move(alice.agent_id, { target_node_id: '2-4' });
    expect(response).toEqual({
      from_node_id: '3-1',
      to_node_id: '2-4',
      arrives_at: Date.now() + 4000,
    });
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('moving');

    const movementTimer = engine.timerManager.find(
      (timer): timer is MovementTimer => timer.type === 'movement' && timer.agent_id === alice.agent_id,
    );
    expect(movementTimer).toMatchObject({
      from_node_id: '3-1',
      to_node_id: '2-4',
      path: ['3-2', '3-3', '3-4', '2-4'],
      fires_at: Date.now() + 4000,
    });

    vi.advanceTimersByTime(4000);

    expect(engine.state.getLoggedIn(alice.agent_id)).toMatchObject({
      node_id: response.to_node_id,
      state: 'idle',
    });
  });

  it('rejects same-node and unreachable moves', async () => {
    const { engine } = createTestWorld({

      config: {
        spawn: { nodes: ['1-1'] },
        map: isolatedMap,
      },
    });
    const alice = engine.registerAgent({ agent_name: 'alice', discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);

    try {
      engine.move(alice.agent_id, { target_node_id: '1-1' });
      throw new Error('Expected same_node error.');
    } catch (error) {
      expectWorldError(error, 'same_node', 400);
    }

    try {
      engine.move(alice.agent_id, { target_node_id: '2-2' });
      throw new Error('Expected no_path error.');
    } catch (error) {
      expectWorldError(error, 'no_path', 400);
    }
  });

  it('tracks in-flight positions and uses them when leaving mid-move', async () => {
    const { engine } = createTestWorld({

      config: {
        spawn: { nodes: ['3-1'] },
      },
    });
    const alice = engine.registerAgent({ agent_name: 'alice', discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);

    const events: Array<{ type: string; node_id?: string }> = [];
    const unsubscribe = engine.eventBus.onAny((event) => {
      events.push(event);
    });

    engine.move(alice.agent_id, { target_node_id: '2-4' });
    vi.advanceTimersByTime(2000);

    await engine.logoutAgent(alice.agent_id);
    unsubscribe();

    expect(events.find((event) => event.type === 'agent_logged_out')).toMatchObject({
      type: 'agent_logged_out',
      node_id: '3-3',
    });
  });

  it('computes current movement positions from timer data', () => {
    const timer = {
      timer_id: 'timer-1',
      type: 'movement',
      agent_ids: ['agent-1'],
      created_at: 0,
      fires_at: 4000,
      agent_id: 'agent-1',
      from_node_id: '3-1',
      to_node_id: '2-4',
      path: ['3-2', '3-3', '3-4', '2-4'],
    } satisfies MovementTimer;

    expect(getCurrentMovementPosition(timer, 1000, 0)).toBe('3-1');
    expect(getCurrentMovementPosition(timer, 1000, 2500)).toBe('3-3');
    expect(getCurrentMovementPosition(timer, 1000, 4000)).toBe('2-4');
  });

  it('rejects impassable moves and moves while a conversation is pending', async () => {
    const { engine } = createTestWorld();
    const alice = engine.registerAgent({ agent_name: 'alice', discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');

    expect(() => engine.move(alice.agent_id, { target_node_id: '1-2' })).toThrowError(WorldError);

    engine.state.setPendingConversation(alice.agent_id, 'conversation-1');
    expect(() => engine.move(alice.agent_id, { target_node_id: '2-1' })).toThrowError(WorldError);
  });
});
