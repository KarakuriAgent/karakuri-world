import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorldEngine } from '../../../src/engine/world-engine.js';
import { formatActionSourceLine, getAvailableActionSourcesWithOptions } from '../../../src/domain/actions.js';
import { WorldError } from '../../../src/types/api.js';
import type { NodeId } from '../../../src/types/data-model.js';
import type { WorldEvent } from '../../../src/types/event.js';
import type { ActionTimer } from '../../../src/types/timer.js';
import { createTestMapConfig } from '../../helpers/test-map.js';
import { createTestWorld } from '../../helpers/test-world.js';

async function createLoggedInAgent(engine: WorldEngine, agentName = 'alice') {
  const agent = await engine.registerAgent({ discord_bot_id: `bot-${agentName}` });
  await engine.loginAgent(agent.agent_id);
  return agent;
}

function getAvailableActionIds(engine: WorldEngine, agentId: string): string[] {
  return getAvailableActionSourcesWithOptions(engine, agentId).map((source) => source.action.action_id);
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
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice', });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '2-4');

    expect(getAvailableActionSourcesWithOptions(engine, alice.agent_id)).toEqual([
      expect.objectContaining({
        type: 'building',
        id: 'building-workshop',
        name: 'Clockwork Workshop',
        action: expect.objectContaining({
          action_id: 'long-nap',
          name: 'Long nap',
          min_duration_minutes: 1,
          max_duration_minutes: 5,
        }),
      }),
      expect.objectContaining({
        type: 'building',
        id: 'building-workshop',
        name: 'Clockwork Workshop',
        action: expect.objectContaining({
          action_id: 'polish-gears',
          name: 'Gears polishing',
          duration_ms: 1500,
        }),
      }),
    ]);

    const response = engine.executeAction(alice.agent_id, { action_id: 'polish-gears' });
    expect(response.ok).toBe(true);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('in_action');

    vi.advanceTimersByTime(1500);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
  });

  it('executes a variable-duration action with the requested duration', async () => {
    const { engine } = createTestWorld();
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '2-4');

    const events: Array<{ type: string; duration_ms?: number }> = [];
    engine.eventBus.onAny((event) => events.push(event));

    const response = engine.executeAction(alice.agent_id, { action_id: 'long-nap', duration_minutes: 3 });
    expect(response.ok).toBe(true);

    const actionTimer = engine.timerManager.find(
      (timer): timer is ActionTimer => timer.type === 'action' && timer.agent_id === alice.agent_id,
    );
    expect(actionTimer).toMatchObject({
      action_id: 'long-nap',
      duration_ms: 180_000,
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'action_started',
        duration_ms: 180_000,
      }),
    );

    vi.advanceTimersByTime(179_999);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('in_action');
    vi.advanceTimersByTime(1);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
  });

  it('requires duration_minutes for variable-duration actions', async () => {
    const { engine } = createTestWorld();
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '2-4');

    expect(() => engine.executeAction(alice.agent_id, { action_id: 'long-nap' })).toThrowError(
      expect.objectContaining({
        code: 'invalid_request',
      }),
    );
  });

  it('rejects duration_minutes outside the configured range', async () => {
    const { engine } = createTestWorld();
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '2-4');

    expect(() => engine.executeAction(alice.agent_id, { action_id: 'long-nap', duration_minutes: 6 })).toThrowError(
      expect.objectContaining({
        code: 'invalid_request',
      }),
    );

    expect(() => engine.executeAction(alice.agent_id, { action_id: 'long-nap', duration_minutes: 0 })).toThrowError(
      expect.objectContaining({
        code: 'invalid_request',
      }),
    );
  });

  it('rejects non-integer duration_minutes', async () => {
    const { engine } = createTestWorld();
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '2-4');

    expect(() => engine.executeAction(alice.agent_id, { action_id: 'long-nap', duration_minutes: 2.5 })).toThrowError(
      expect.objectContaining({
        code: 'invalid_request',
      }),
    );
  });

  it('accepts duration_minutes at exact min and max boundaries', async () => {
    const { engine } = createTestWorld();
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '2-4');

    engine.executeAction(alice.agent_id, { action_id: 'long-nap', duration_minutes: 1 });
    let actionTimer = engine.timerManager.find(
      (timer): timer is ActionTimer => timer.type === 'action' && timer.agent_id === alice.agent_id,
    );
    expect(actionTimer?.duration_ms).toBe(60_000);

    vi.advanceTimersByTime(60_000);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');

    // Execute a different action to clear the cooldown on long-nap
    executeAndCompleteAction(engine, alice.agent_id, 'polish-gears');

    engine.executeAction(alice.agent_id, { action_id: 'long-nap', duration_minutes: 5 });
    actionTimer = engine.timerManager.find(
      (timer): timer is ActionTimer => timer.type === 'action' && timer.agent_id === alice.agent_id,
    );
    expect(actionTimer?.duration_ms).toBe(300_000);
  });

  it('ignores duration_minutes for fixed-duration actions', async () => {
    const { engine } = createTestWorld();
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '2-4');

    engine.executeAction(alice.agent_id, { action_id: 'polish-gears', duration_minutes: 5 });
    const actionTimer = engine.timerManager.find(
      (timer): timer is ActionTimer => timer.type === 'action' && timer.agent_id === alice.agent_id,
    );

    expect(actionTimer?.duration_ms).toBe(1500);
  });

  it('formats variable-duration actions in choice text', async () => {
    const { engine } = createTestWorld();
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '2-4');

    const source = getAvailableActionSourcesWithOptions(engine, alice.agent_id).find((candidate) => candidate.action.action_id === 'long-nap');
    expect(source).toBeDefined();
    expect(formatActionSourceLine(source!)).toContain('1〜5分, duration_minutes: 分数を指定');
  });

  it('supports NPC actions and rejects invalid/unavailable actions', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice', });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');

    expect(getAvailableActionSourcesWithOptions(engine, alice.agent_id)[0]?.action.action_id).toBe('greet-gatekeeper');
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

    expect(getAvailableActionIds(engine, alice.agent_id)).toEqual(['long-nap', 'polish-gears']);

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
    expect(engine.state.getLoggedIn(alice.agent_id)).toMatchObject({
      last_action_id: null,
      last_rejected_action_id: 'greet-gatekeeper',
    });
    expect(getAvailableActionIds(engine, alice.agent_id)).toEqual(['greet-gatekeeper']);
    expect(events.some((e) => e.type === 'action_rejected')).toBe(true);
  });

  it('rejects an action when the agent lacks required items', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'flower', name: '花束', description: '花', type: 'general' as const, stackable: true }],
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

    const response = engine.executeAction(alice.agent_id, { action_id: 'offer-flower' });
    expect(response.ok).toBe(true);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
    expect(engine.state.getLoggedIn(alice.agent_id)).toMatchObject({
      last_action_id: null,
      last_rejected_action_id: 'offer-flower',
    });
    expect(getAvailableActionIds(engine, alice.agent_id)).toEqual(['offer-flower']);
    expect(events.some((e) => e.type === 'action_rejected')).toBe(true);
  });

  it('keeps rejected actions visible at the domain layer (suppression lives in choices)', async () => {
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
                },
                {
                  action_id: 'expensive-greeting',
                  name: 'Expensive greeting',
                  description: 'Offer a costly greeting.',
                  duration_ms: 1200,
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

    expect(engine.executeAction(alice.agent_id, { action_id: 'expensive-greeting' }).ok).toBe(true);
    expect(engine.state.getLoggedIn(alice.agent_id)?.last_rejected_action_id).toBe('expensive-greeting');

    expect(getAvailableActionIds(engine, alice.agent_id)).toEqual(['expensive-greeting', 'greet-gatekeeper']);
    expect(
      getAvailableActionSourcesWithOptions(engine, alice.agent_id, {
        excluded_action_ids: ['expensive-greeting'],
      }).map((source) => source.action.action_id),
    ).toEqual(['greet-gatekeeper']);
  });

  it('deducts cost_money on action start and grants reward_money on completion', async () => {
    const { engine } = createTestWorld({
      config: {
        economy: { initial_money: 1000 },
        idle_reminder: { interval_ms: 60_000 },
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
          { item_id: 'wood', name: '木材', description: '木', type: 'general' as const, stackable: true },
          { item_id: 'chair', name: '椅子', description: '椅子', type: 'general' as const, stackable: false },
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

  it('recovers to idle when action completion persistence fails', async () => {
    let failPersist = false;
    const onRegistrationChanged = vi.fn(() => {
      if (failPersist) {
        throw new Error('persist failed');
      }
    });
    const { engine } = createTestWorld({
      config: {
        economy: { initial_money: 1000 },
        idle_reminder: { interval_ms: 60_000 },
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
                  reward_money: 500,
                },
              ],
            },
          ],
        },
      },
      engineOptions: { onRegistrationChanged },
    });
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '2-4');
    const reportErrorSpy = vi.spyOn(engine, 'reportError');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events: WorldEvent[] = [];
    engine.eventBus.onAny((event) => events.push(event));

    engine.executeAction(alice.agent_id, { action_id: 'work' });
    failPersist = true;

    vi.advanceTimersByTime(1000);

    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
    expect(engine.timerManager.find((timer) => timer.type === 'idle_reminder' && timer.agent_id === alice.agent_id)).toBeDefined();
    expect(engine.timerManager.find((timer) => timer.type === 'action' && timer.agent_id === alice.agent_id)).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'action_completed',
      agent_id: alice.agent_id,
      action_id: 'work',
    }));
    expect(reportErrorSpy).toHaveBeenCalledWith(expect.stringContaining(`agent_id=${alice.agent_id}`));
    expect(reportErrorSpy).toHaveBeenCalledWith(expect.stringContaining('action_id=work'));
  });

  it('continues action start when action persistence fails', async () => {
    let failPersist = false;
    const onRegistrationChanged = vi.fn(() => {
      if (failPersist) {
        throw new Error('persist failed');
      }
    });
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
                  action_id: 'craft-chair',
                  name: 'Craft chair',
                  description: 'Build a chair.',
                  duration_ms: 1000,
                  cost_money: 100,
                  required_items: [{ item_id: 'wood', quantity: 2 }],
                },
              ],
            },
          ],
        },
      },
      engineOptions: { onRegistrationChanged },
    });
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '2-4');
    engine.state.setItems(alice.agent_id, [{ item_id: 'wood', quantity: 3 }]);
    const reportErrorSpy = vi.spyOn(engine, 'reportError');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events: WorldEvent[] = [];
    engine.eventBus.onAny((event) => events.push(event));

    failPersist = true;
    const response = engine.executeAction(alice.agent_id, { action_id: 'craft-chair' });

    expect(response.ok).toBe(true);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('in_action');
    expect(engine.state.getLoggedIn(alice.agent_id)?.money).toBe(900);
    expect(engine.state.getLoggedIn(alice.agent_id)?.items).toEqual([{ item_id: 'wood', quantity: 1 }]);
    expect(engine.state.getById(alice.agent_id)?.money).toBe(1000);
    expect(engine.state.getById(alice.agent_id)?.items ?? []).toEqual([]);
    expect(engine.timerManager.find((timer) => timer.type === 'action' && timer.agent_id === alice.agent_id)).toBeDefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'action_started',
        agent_id: alice.agent_id,
        action_id: 'craft-chair',
        cost_money: 100,
        items_consumed: [{ item_id: 'wood', quantity: 2 }],
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`agent_id=${alice.agent_id}`));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('action_id=craft-chair'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cost_money=100'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('items_consumed=woodx2'));
    expect(reportErrorSpy).toHaveBeenCalledWith(expect.stringContaining(`agent_id=${alice.agent_id}`));
    expect(reportErrorSpy).toHaveBeenCalledWith(expect.stringContaining('action_id=craft-chair'));
    expect(reportErrorSpy).toHaveBeenCalledWith(expect.stringContaining('cost_money=100'));
    expect(reportErrorSpy).toHaveBeenCalledWith(expect.stringContaining('items_consumed=woodx2'));
    expect(reportErrorSpy).toHaveBeenCalledWith(expect.stringContaining('アクションは続行します'));
  });

  it('continues action start even when the error reporter throws', async () => {
    let failPersist = false;
    const onRegistrationChanged = vi.fn(() => {
      if (failPersist) {
        throw new Error('persist failed');
      }
    });
    const onError = vi.fn(() => {
      throw new Error('report failed');
    });
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
                  action_id: 'craft-chair',
                  name: 'Craft chair',
                  description: 'Build a chair.',
                  duration_ms: 1000,
                  cost_money: 100,
                  required_items: [{ item_id: 'wood', quantity: 2 }],
                },
              ],
            },
          ],
        },
      },
      engineOptions: { onRegistrationChanged, onError },
    });
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '2-4');
    engine.state.setItems(alice.agent_id, [{ item_id: 'wood', quantity: 3 }]);
    const reportErrorSpy = vi.spyOn(engine, 'reportError');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const events: WorldEvent[] = [];
    engine.eventBus.onAny((event) => events.push(event));

    failPersist = true;
    let response!: ReturnType<typeof engine.executeAction>;
    expect(() => {
      response = engine.executeAction(alice.agent_id, { action_id: 'craft-chair' });
    }).not.toThrow();

    expect(response.ok).toBe(true);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('in_action');
    expect(engine.timerManager.find((timer) => timer.type === 'action' && timer.agent_id === alice.agent_id)).toBeDefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'action_started',
        agent_id: alice.agent_id,
        action_id: 'craft-chair',
      }),
    );
    expect(warnSpy).toHaveBeenCalled();
    expect(reportErrorSpy).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('アクションは続行します'));
    expect(errorSpy).toHaveBeenCalledWith('World error reporter threw.', expect.any(Error));
  });

  it('shows actions with required_items even when the agent does not hold them', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'key', name: '鍵', description: '鍵', type: 'venue' as const, stackable: false }],
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

    expect(getAvailableActionIds(engine, alice.agent_id)).toContain('unlock-door');
  });

  it('keeps the cooldown when a server announcement window interrupts an action', async () => {
    const { engine } = createTestWorld();
    const alice = await createLoggedInAgent(engine);
    engine.state.setNode(alice.agent_id, '1-1');

    engine.executeAction(alice.agent_id, { action_id: 'greet-gatekeeper' });
    engine.fireServerAnnouncement('Dark clouds gather.');
    engine.executeWait(alice.agent_id, { duration: 1 });

    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('in_action');
    expect(engine.state.getLoggedIn(alice.agent_id)?.last_action_id).toBe('greet-gatekeeper');
    expect(getAvailableActionIds(engine, alice.agent_id)).toEqual([]);
  });
});
