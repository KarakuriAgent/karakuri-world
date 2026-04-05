import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorldEngine } from '../../../src/engine/world-engine.js';
import { WorldError } from '../../../src/types/api.js';
import type { NodeId } from '../../../src/types/data-model.js';
import type { ActionTimer } from '../../../src/types/timer.js';
import { createTestMapConfig } from '../../helpers/test-map.js';
import { createTestWorld } from '../../helpers/test-world.js';

async function createLoggedInAgent(engine: WorldEngine, agentName = 'alice') {
  const agent = engine.registerAgent({ agent_name: agentName, agent_label: agentName, discord_bot_id: `bot-${agentName}` });
  await engine.loginAgent(agent.agent_id);
  return agent;
}

function getAvailableActionIds(engine: WorldEngine, agentId: string): string[] {
  return engine.getAvailableActions(agentId).actions.map((action) => action.action_id);
}

function executeAndCompleteAction(engine: WorldEngine, agentId: string, actionId: string): void {
  engine.executeAction(agentId, { action_id: actionId });
  const actionTimer = engine.timerManager.find(
    (timer): timer is ActionTimer => timer.type === 'action' && timer.agent_id === agentId,
  );
  if (!actionTimer) {
    throw new Error('Expected action timer to exist.');
  }
  vi.advanceTimersByTime(actionTimer.fires_at - Date.now());
}

function executeAndCompleteWait(engine: WorldEngine, agentId: string, duration: number = 1): void {
  const response = engine.executeWait(agentId, { duration });
  vi.advanceTimersByTime(response.completes_at - Date.now());
}

function moveAndArrive(engine: WorldEngine, agentId: string, targetNodeId: NodeId): void {
  const response = engine.move(agentId, { target_node_id: targetNodeId });
  vi.advanceTimersByTime(response.arrives_at - Date.now());
}

describe('actions domain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('lists and executes building actions', async () => {
    const { engine } = createTestWorld();
    const alice = engine.registerAgent({ agent_name: 'alice', agent_label: 'alice', discord_bot_id: 'bot-alice', });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '2-4');

    expect(engine.getAvailableActions(alice.agent_id).actions).toEqual([
      {
        action_id: 'polish-gears',
        name: 'Gears polishing',
        description: 'Carefully polish the workshop gears.',
        duration_ms: 1500,
        source: {
          type: 'building',
          id: 'building-workshop',
          name: 'Clockwork Workshop',
        },
      },
    ]);

    const response = engine.executeAction(alice.agent_id, { action_id: 'polish-gears' });
    expect(response.ok).toBe(true);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('in_action');

    vi.advanceTimersByTime(1500);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
  });

  it('supports NPC actions and rejects invalid/unavailable actions', async () => {
    const { engine } = createTestWorld();
    const alice = engine.registerAgent({ agent_name: 'alice', agent_label: 'alice', discord_bot_id: 'bot-alice', });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');

    expect(engine.getAvailableActions(alice.agent_id).actions[0]?.action_id).toBe('greet-gatekeeper');
    expect(() => engine.executeAction(alice.agent_id, { action_id: 'missing-action' })).toThrowError(WorldError);

    engine.state.setNode(alice.agent_id, '3-4');
    expect(() => engine.executeAction(alice.agent_id, { action_id: 'polish-gears' })).toThrowError(WorldError);
  });

  it('starts with no cooldown on login and resets it on re-login', async () => {
    const { engine } = createTestWorld();
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '1-1');

    expect(engine.state.getLoggedIn(alice.agent_id)?.last_action_id).toBeNull();
    expect(getAvailableActionIds(engine, alice.agent_id)).toEqual(['greet-gatekeeper']);

    executeAndCompleteAction(engine, alice.agent_id, 'greet-gatekeeper');
    expect(engine.state.getLoggedIn(alice.agent_id)?.last_action_id).toBe('greet-gatekeeper');

    await engine.logoutAgent(alice.agent_id);
    await engine.loginAgent(alice.agent_id);

    expect(engine.state.getLoggedIn(alice.agent_id)?.last_action_id).toBeNull();
    expect(getAvailableActionIds(engine, alice.agent_id)).toEqual(['greet-gatekeeper']);
  });

  it('blocks selecting the same action twice in a row', async () => {
    const { engine } = createTestWorld();
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '1-1');

    executeAndCompleteAction(engine, alice.agent_id, 'greet-gatekeeper');

    expect(engine.state.getLoggedIn(alice.agent_id)?.last_action_id).toBe('greet-gatekeeper');
    expect(getAvailableActionIds(engine, alice.agent_id)).toEqual([]);
    expect(() => engine.executeAction(alice.agent_id, { action_id: 'greet-gatekeeper' })).toThrowError(WorldError);
  });

  it('keeps the cooldown after waiting', async () => {
    const { engine } = createTestWorld();
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '1-1');

    executeAndCompleteAction(engine, alice.agent_id, 'greet-gatekeeper');
    executeAndCompleteWait(engine, alice.agent_id);

    expect(engine.state.getLoggedIn(alice.agent_id)?.last_action_id).toBe('greet-gatekeeper');
    expect(getAvailableActionIds(engine, alice.agent_id)).toEqual([]);
  });

  it('keeps the cooldown after moving away and back', async () => {
    const { engine } = createTestWorld();
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '1-1');

    executeAndCompleteAction(engine, alice.agent_id, 'greet-gatekeeper');
    moveAndArrive(engine, alice.agent_id, '3-1');
    moveAndArrive(engine, alice.agent_id, '1-1');

    expect(engine.state.getLoggedIn(alice.agent_id)?.last_action_id).toBe('greet-gatekeeper');
    expect(getAvailableActionIds(engine, alice.agent_id)).toEqual([]);
  });

  it('clears the previous cooldown when a different action starts', async () => {
    const { engine } = createTestWorld();
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '1-1');

    executeAndCompleteAction(engine, alice.agent_id, 'greet-gatekeeper');
    engine.state.setNode(alice.agent_id, '2-4');

    expect(getAvailableActionIds(engine, alice.agent_id)).toEqual(['polish-gears']);

    executeAndCompleteAction(engine, alice.agent_id, 'polish-gears');
    engine.state.setNode(alice.agent_id, '1-1');

    expect(engine.state.getLoggedIn(alice.agent_id)?.last_action_id).toBe('polish-gears');
    expect(getAvailableActionIds(engine, alice.agent_id)).toEqual(['greet-gatekeeper']);
  });

  it('clears the cooldown when an accepted conversation ends', async () => {
    const { engine } = createTestWorld();
    const alice = await createLoggedInAgent(engine);
    const bob = await createLoggedInAgent(engine, 'bob');
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-1');

    executeAndCompleteAction(engine, alice.agent_id, 'greet-gatekeeper');

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });
    // accept creates interval (500ms) → turn timer (4000ms) → total 4500ms for timeout
    vi.advanceTimersByTime(4500);

    expect(engine.state.conversations.get(started.conversation_id)).toBeNull();
    expect(engine.state.getLoggedIn(alice.agent_id)?.last_action_id).toBeNull();
    expect(getAvailableActionIds(engine, alice.agent_id)).toEqual(['greet-gatekeeper']);
  });

  it('does not clear the cooldown when a conversation is rejected or times out before acceptance', async () => {
    const { engine } = createTestWorld();
    const alice = await createLoggedInAgent(engine);
    const bob = await createLoggedInAgent(engine, 'bob');
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-1');

    executeAndCompleteAction(engine, alice.agent_id, 'greet-gatekeeper');

    const rejected = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'hello?',
    });
    engine.rejectConversation(bob.agent_id);

    expect(engine.state.getLoggedIn(alice.agent_id)?.last_action_id).toBe('greet-gatekeeper');
    expect(getAvailableActionIds(engine, alice.agent_id)).toEqual([]);

    const timedOut = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'maybe later?',
    });
    vi.advanceTimersByTime(3000);

    expect(engine.state.conversations.get(timedOut.conversation_id)).toBeNull();
    expect(engine.state.getLoggedIn(alice.agent_id)?.last_action_id).toBe('greet-gatekeeper');
    expect(getAvailableActionIds(engine, alice.agent_id)).toEqual([]);
  });

  it('rejects an action when the agent has insufficient money', async () => {
    const { engine } = createTestWorld({
      config: {
        economy: { initial_money: 100 },
        map: {
          ...createTestWorld().config.map,
          npcs: [
            {
              npc_id: 'npc-gatekeeper',
              name: 'Gatekeeper',
              description: 'Watches the town gate.',
              node_id: '1-2',
              actions: [
                {
                  action_id: 'greet-gatekeeper',
                  name: 'Greet the gatekeeper',
                  description: 'Offer a greeting.',
                  duration_ms: 1200,
                  result_description: 'A nod.',
                  cost_money: 500,
                },
              ],
            },
          ],
        },
      },
    });
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '1-1');

    const events: Array<{ type: string }> = [];
    engine.eventBus.onAny((event) => events.push(event));

    const response = engine.executeAction(alice.agent_id, { action_id: 'greet-gatekeeper' });
    expect(response.ok).toBe(true);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
    expect(engine.state.getLoggedIn(alice.agent_id)?.money).toBe(100);
    expect(events.some((e) => e.type === 'action_rejected')).toBe(true);
  });

  it('rejects an action when the agent lacks required items', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'flower', name: '花束', description: '花', stackable: true }],
        map: {
          ...createTestWorld().config.map,
          npcs: [
            {
              npc_id: 'npc-gatekeeper',
              name: 'Gatekeeper',
              description: 'Watches the town gate.',
              node_id: '1-2',
              actions: [
                {
                  action_id: 'offer-flower',
                  name: 'Offer a flower',
                  description: 'Give flowers.',
                  duration_ms: 600,
                  result_description: 'Accepted.',
                  required_items: [{ item_id: 'flower', quantity: 1 }],
                },
              ],
            },
          ],
        },
      },
    });
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '1-1');

    const events: Array<{ type: string }> = [];
    engine.eventBus.onAny((event) => events.push(event));

    expect(() => engine.executeAction(alice.agent_id, { action_id: 'offer-flower' })).toThrow(WorldError);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
  });

  it('deducts cost_money on action start and grants reward_money on completion', async () => {
    const { engine } = createTestWorld({
      config: {
        economy: { initial_money: 1000 },
        map: {
          ...createTestWorld().config.map,
          buildings: [
            {
              building_id: 'building-workshop',
              name: 'Workshop',
              description: 'A workshop.',
              wall_nodes: ['1-3', '1-4', '1-5', '2-3', '2-5'],
              interior_nodes: ['2-4'],
              door_nodes: ['3-4'],
              actions: [
                {
                  action_id: 'work',
                  name: 'Work',
                  description: 'Do work.',
                  duration_ms: 1000,
                  result_description: 'Done.',
                  cost_money: 200,
                  reward_money: 500,
                },
              ],
            },
          ],
        },
      },
    });
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '2-4');

    engine.executeAction(alice.agent_id, { action_id: 'work' });
    expect(engine.state.getLoggedIn(alice.agent_id)?.money).toBe(800);

    vi.advanceTimersByTime(1000);
    expect(engine.state.getLoggedIn(alice.agent_id)?.money).toBe(1300);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
  });

  it('consumes required_items on start and grants reward_items on completion', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [
          { item_id: 'wood', name: '木材', description: '木', stackable: true },
          { item_id: 'chair', name: '椅子', description: '椅子', stackable: false },
        ],
        map: {
          ...createTestWorld().config.map,
          buildings: [
            {
              building_id: 'building-workshop',
              name: 'Workshop',
              description: 'A workshop.',
              wall_nodes: ['1-3', '1-4', '1-5', '2-3', '2-5'],
              interior_nodes: ['2-4'],
              door_nodes: ['3-4'],
              actions: [
                {
                  action_id: 'craft-chair',
                  name: 'Craft chair',
                  description: 'Build a chair.',
                  duration_ms: 1000,
                  result_description: 'Built.',
                  required_items: [{ item_id: 'wood', quantity: 2 }],
                  reward_items: [{ item_id: 'chair', quantity: 1 }],
                },
              ],
            },
          ],
        },
      },
    });
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '2-4');
    engine.state.setItems(alice.agent_id, [{ item_id: 'wood', quantity: 3 }]);

    engine.executeAction(alice.agent_id, { action_id: 'craft-chair' });
    expect(engine.state.getLoggedIn(alice.agent_id)?.items).toEqual([{ item_id: 'wood', quantity: 1 }]);

    vi.advanceTimersByTime(1000);
    expect(engine.state.getLoggedIn(alice.agent_id)?.items).toEqual([
      { item_id: 'chair', quantity: 1 },
      { item_id: 'wood', quantity: 1 },
    ]);
  });

  it('filters out actions whose required_items the agent does not hold', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'key', name: '鍵', description: '鍵', stackable: false }],
        map: {
          ...createTestMapConfig(),
          buildings: [
            {
              ...createTestMapConfig().buildings[0],
              actions: [
                ...createTestMapConfig().buildings[0].actions,
                {
                  action_id: 'unlock-door',
                  name: 'Unlock door',
                  description: 'Unlock the door with a key.',
                  duration_ms: 500,
                  result_description: 'The door is now unlocked.',
                  required_items: [{ item_id: 'key', quantity: 1 }],
                },
              ],
            },
          ],
        },
      },
    });
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '2-4');

    expect(getAvailableActionIds(engine, alice.agent_id)).not.toContain('unlock-door');

    engine.state.setItems(alice.agent_id, [{ item_id: 'key', quantity: 1 }]);
    expect(getAvailableActionIds(engine, alice.agent_id)).toContain('unlock-door');
  });

  it('keeps the cooldown when a server event window interrupts an action', async () => {
    const { engine } = createTestWorld();
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '1-1');

    engine.executeAction(alice.agent_id, { action_id: 'greet-gatekeeper' });
    engine.fireServerEvent('Dark clouds gather.');
    engine.executeWait(alice.agent_id, { duration: 1 });

    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('in_action');
    expect(engine.state.getLoggedIn(alice.agent_id)?.last_action_id).toBe('greet-gatekeeper');
    expect(getAvailableActionIds(engine, alice.agent_id)).toEqual([]);
  });
});
