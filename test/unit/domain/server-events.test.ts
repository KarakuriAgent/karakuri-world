import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestWorld } from '../../helpers/test-world.js';
import { WorldError } from '../../../src/types/api.js';

function expectWorldError(error: unknown, code: WorldError['code'], status: number): void {
  expect(error).toBeInstanceOf(WorldError);
  expect(error).toMatchObject({ code, status });
}

describe('server event domain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('fires events with runtime descriptions and clears stored events when there are no pending agents', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);

    const fired = engine.fireServerEvent('Dark clouds gather.');

    expect(fired.server_event_id).toMatch(/^server-event-/);
    expect(engine.getSnapshot().server_events).toEqual([]);
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBe(fired.server_event_id);
  });

  it('delays delivery while moving and keeps the event window open through arrival', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '3-1');
    const eventTypes: string[] = [];
    const unsubscribe = engine.eventBus.onAny((event) => {
      eventTypes.push(event.type);
    });

    engine.move(alice.agent_id, { target_node_id: '3-4' });
    const fired = engine.fireServerEvent('Dark clouds gather.');

    expect(engine.getSnapshot().server_events).toEqual([
      expect.objectContaining({
        server_event_id: fired.server_event_id,
        description: 'Dark clouds gather.',
        pending_agent_ids: [alice.agent_id],
      }),
    ]);
    expect(engine.state.getLoggedIn(alice.agent_id)?.pending_server_event_ids).toEqual([fired.server_event_id]);
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBeNull();

    vi.advanceTimersByTime(3000);

    expect(engine.state.getLoggedIn(alice.agent_id)?.pending_server_event_ids).toEqual([]);
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBe(fired.server_event_id);
    expect(engine.getSnapshot().server_events).toEqual([]);
    expect(eventTypes.slice(-2)).toEqual(['server_event_fired', 'movement_completed']);

    unsubscribe();
  });

  it('delivers delayed server events in fire order after movement completes', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '3-1');

    const delayedDescriptions: string[] = [];
    const unsubscribe = engine.eventBus.onAny((event) => {
      if (event.type === 'server_event_fired' && event.delayed) {
        delayedDescriptions.push(event.description);
      }
    });

    engine.move(alice.agent_id, { target_node_id: '3-4' });
    engine.fireServerEvent('First delayed event.');
    engine.fireServerEvent('Second delayed event.');

    vi.advanceTimersByTime(3000);

    expect(delayedDescriptions).toEqual(['First delayed event.', 'Second delayed event.']);

    unsubscribe();
  });

  it('clears the active server event when the next completion notification arrives', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');

    const fired = engine.fireServerEvent('Dark clouds gather.');
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBe(fired.server_event_id);

    engine.executeAction(alice.agent_id, { action_id: 'greet-gatekeeper' });

    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBeNull();
  });

  it.each([
    {
      title: 'action completion',
      prepare: (engine: ReturnType<typeof createTestWorld>['engine'], agentId: string) => {
        engine.state.setNode(agentId, '1-1');
        engine.executeAction(agentId, { action_id: 'greet-gatekeeper' });
      },
      complete: () => {
        vi.advanceTimersByTime(1200);
      },
    },
    {
      title: 'wait completion',
      prepare: (engine: ReturnType<typeof createTestWorld>['engine'], agentId: string) => {
        engine.executeWait(agentId, { duration: 1 });
      },
      complete: () => {
        vi.advanceTimersByTime(600000);
      },
    },
    {
      title: 'idle reminder',
      prepare: () => {},
      complete: () => {
        vi.advanceTimersByTime(1000);
      },
      config: {
        idle_reminder: {
          interval_ms: 1000,
        },
      },
    },
  ])('keeps the server-event window open after $title fires until delivery clears it', async ({ prepare, complete, config }) => {
    const { engine } = createTestWorld({ config });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);

    prepare(engine, alice.agent_id);
    const fired = engine.fireServerEvent('Dark clouds gather.');
    complete();

    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBe(fired.server_event_id);
  });

  it('interrupts an in-action agent when they start a new command during the event window', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');

    engine.executeAction(alice.agent_id, { action_id: 'greet-gatekeeper' });
    const fired = engine.fireServerEvent('Dark clouds gather.');
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBe(fired.server_event_id);

    engine.executeWait(alice.agent_id, { duration: 1 });

    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('in_action');
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBeNull();
    expect(engine.state.getLoggedIn(alice.agent_id)?.last_action_id).toBe('greet-gatekeeper');
  });

  it.each([
    {
      title: 'move',
      execute: (engine: ReturnType<typeof createTestWorld>['engine'], agentId: string) =>
        engine.move(agentId, { target_node_id: '1-1' }),
      code: 'same_node' as const,
      status: 400,
    },
    {
      title: 'action',
      execute: (engine: ReturnType<typeof createTestWorld>['engine'], agentId: string) =>
        engine.executeAction(agentId, { action_id: 'missing-action' }),
      code: 'action_not_found' as const,
      status: 400,
    },
    {
      title: 'wait',
      execute: (engine: ReturnType<typeof createTestWorld>['engine'], agentId: string) =>
        engine.executeWait(agentId, { duration: 0 }),
      code: 'invalid_request' as const,
      status: 400,
    },
  ])('does not interrupt the current action when an invalid $title replacement is rejected', async ({ execute, code, status }) => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');

    engine.executeAction(alice.agent_id, { action_id: 'greet-gatekeeper' });
    const fired = engine.fireServerEvent('Dark clouds gather.');

    try {
      execute(engine, alice.agent_id);
      throw new Error('Expected replacement command to fail.');
    } catch (error) {
      expectWorldError(error, code, status);
    }

    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('in_action');
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBe(fired.server_event_id);
    expect(
      engine.timerManager.find((timer) => timer.type === 'action' && timer.agent_id === alice.agent_id),
    ).not.toBeNull();
  });

  it('moves a conversation to closing and frees the acting agent during the event window', async () => {
    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 4,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });

    const fired = engine.fireServerEvent('Dark clouds gather.');
    expect(engine.state.getLoggedIn(bob.agent_id)?.active_server_event_id).toBe(fired.server_event_id);

    engine.executeWait(bob.agent_id, { duration: 1 });

    const conversation = engine.state.conversations.get(started.conversation_id);
    expect(conversation?.status).toBe('closing');
    expect(conversation?.current_speaker_agent_id).toBe(alice.agent_id);
    expect(engine.state.getLoggedIn(bob.agent_id)?.state).toBe('in_action');
    expect(engine.state.getLoggedIn(bob.agent_id)?.active_server_event_id).toBeNull();
  });

  it('detaches the interrupting participant instead of the prompted speaker in group conversations', async () => {
    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 6,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    const carol = await engine.registerAgent({ discord_bot_id: 'bot-carol' });
    const dave = await engine.registerAgent({ discord_bot_id: 'bot-dave' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await engine.loginAgent(carol.agent_id);
    await engine.loginAgent(dave.agent_id);
    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');
    engine.state.setNode(carol.agent_id, '3-2');
    engine.state.setNode(dave.agent_id, '3-2');

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Mind if I join?',
    });
    engine.joinConversation(dave.agent_id, {
      conversation_id: started.conversation_id,
      message: 'I am here too.',
    });

    engine.fireServerEvent('Dark clouds gather.');
    engine.executeWait(dave.agent_id, { duration: 1 });

    const conversation = engine.state.conversations.get(started.conversation_id);
    expect(conversation?.status).toBe('closing');
    expect(conversation?.current_speaker_agent_id).toBe(alice.agent_id);
    expect(conversation?.participant_agent_ids).toEqual([alice.agent_id, bob.agent_id, carol.agent_id]);
    expect(engine.state.getLoggedIn(dave.agent_id)?.current_conversation_id).toBeNull();
    expect(engine.state.getLoggedIn(dave.agent_id)?.state).toBe('in_action');
  });

  it('starts server-event closing from the paused resume speaker successor during inactive checks', async () => {
    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 10,
          inactive_check_turns: 2,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    const carol = await engine.registerAgent({ discord_bot_id: 'bot-carol' });
    const dave = await engine.registerAgent({ discord_bot_id: 'bot-dave' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await engine.loginAgent(carol.agent_id);
    await engine.loginAgent(dave.agent_id);
    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');
    engine.state.setNode(carol.agent_id, '3-2');
    engine.state.setNode(dave.agent_id, '3-2');

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Mind if I join?',
    });
    engine.joinConversation(dave.agent_id, {
      conversation_id: started.conversation_id,
      message: 'I am here too.',
    });

    engine.speak(alice.agent_id, {
      message: 'Bob, over to you.',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);
    engine.speak(bob.agent_id, {
      message: 'Alice, please continue.',
      next_speaker_agent_id: alice.agent_id,
    });
    vi.advanceTimersByTime(500);

    expect(engine.state.conversations.get(started.conversation_id)).toEqual(expect.objectContaining({
      current_speaker_agent_id: bob.agent_id,
      resume_speaker_agent_id: alice.agent_id,
      inactive_check_pending_agent_ids: [carol.agent_id, dave.agent_id],
    }));

    const fired = engine.fireServerEvent('Dark clouds gather.');
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBe(fired.server_event_id);

    engine.executeWait(alice.agent_id, { duration: 1 });

    const conversation = engine.state.conversations.get(started.conversation_id);
    expect(conversation).toEqual(expect.objectContaining({
      status: 'closing',
      current_speaker_agent_id: carol.agent_id,
      participant_agent_ids: [bob.agent_id, carol.agent_id, dave.agent_id],
      closing_reason: 'server_event',
    }));
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('in_action');
  });

  it('keeps the server-event window open for in-conversation agents until a follow-up notification can clear it', async () => {
    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 4,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');

    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });

    const fired = engine.fireServerEvent('Dark clouds gather.');

    vi.advanceTimersByTime(500);

    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBe(fired.server_event_id);
    expect(engine.state.getLoggedIn(bob.agent_id)?.active_server_event_id).toBe(fired.server_event_id);
  });

  it.each([
    ['initiator', 'alice'],
    ['target', 'bob'],
  ] as const)(
    'cancels a pending conversation with server_event semantics when the %s interrupts during the event window',
    async (_role, interrupterName) => {
      const { engine } = createTestWorld();
      const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
      const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
      await engine.loginAgent(alice.agent_id);
      await engine.loginAgent(bob.agent_id);
      engine.state.setNode(alice.agent_id, '3-1');
      engine.state.setNode(bob.agent_id, '3-2');

      const rejectedEvents: Array<{ reason: string; initiator: string; target: string }> = [];
      const unsubscribe = engine.eventBus.onAny((event) => {
        if (event.type === 'conversation_rejected') {
          rejectedEvents.push({
            reason: event.reason,
            initiator: event.initiator_agent_id,
            target: event.target_agent_id,
          });
        }
      });

      const started = engine.startConversation(alice.agent_id, {
        target_agent_id: bob.agent_id,
        message: 'Hello',
      });
      engine.fireServerEvent('Dark clouds gather.');

      const interrupterId = interrupterName === 'alice' ? alice.agent_id : bob.agent_id;
      engine.executeWait(interrupterId, { duration: 1 });

      expect(engine.state.conversations.get(started.conversation_id)).toBeNull();
      expect(engine.state.getLoggedIn(alice.agent_id)?.pending_conversation_id).toBeNull();
      expect(engine.state.getLoggedIn(bob.agent_id)?.pending_conversation_id).toBeNull();
      expect(rejectedEvents).toEqual([
        {
          reason: 'server_event',
          initiator: alice.agent_id,
          target: bob.agent_id,
        },
      ]);

      unsubscribe();
    },
  );

  it('clears a stale pending conversation reference after a server-event interruption ends the conversation', async () => {
    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 4,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });
    engine.state.setPendingConversation(bob.agent_id, started.conversation_id);

    engine.fireServerEvent('Dark clouds gather.');
    engine.move(bob.agent_id, { target_node_id: '3-3' });

    expect(engine.state.getLoggedIn(bob.agent_id)?.pending_conversation_id).toBeNull();

    vi.advanceTimersByTime(1000);

    expect(engine.state.getLoggedIn(bob.agent_id)?.pending_conversation_id).toBeNull();
    expect(() => engine.move(bob.agent_id, { target_node_id: '3-4' })).not.toThrow();
  });

  it('removes later interrupters even when the conversation is already closing during the event window', async () => {
    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 4,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');

    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });

    // Advance to max_turns to put conversation into closing (turns: start=1, accept=2, speak=3, speak=4)
    vi.advanceTimersByTime(500);
    engine.speak(alice.agent_id, { message: 'Turn 3' });
    vi.advanceTimersByTime(500);
    engine.speak(bob.agent_id, { message: 'Turn 4' });
    vi.advanceTimersByTime(500);

    // Alice is now the farewell speaker in a closing conversation
    const conversationId = engine.state.getLoggedIn(alice.agent_id)?.current_conversation_id;
    expect(conversationId).not.toBeNull();
    const conversation = engine.state.conversations.get(conversationId!);
    expect(conversation?.status).toBe('closing');
    const originalSpeaker = conversation?.current_speaker_agent_id;

    // Fire server event and have bob (not the farewell speaker) try to interrupt
    engine.fireServerEvent('Dark clouds gather.');
    expect(engine.state.getLoggedIn(bob.agent_id)?.active_server_event_id).not.toBeNull();

    engine.executeWait(bob.agent_id, { duration: 1 });

    // Bob should be removed cleanly even though the conversation was already closing.
    expect(engine.state.conversations.get(conversationId!)).toBeNull();
    expect(originalSpeaker).toBe(alice.agent_id);
    expect(engine.state.getLoggedIn(bob.agent_id)?.current_conversation_id).toBeNull();
    expect(engine.state.getLoggedIn(alice.agent_id)?.current_conversation_id).toBeNull();
    expect(engine.state.getLoggedIn(bob.agent_id)?.state).toBe('in_action');
  });

  it('ends a closing conversation when the farewell speaker interrupts during the event window', async () => {
    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 4,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');

    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });

    vi.advanceTimersByTime(500);
    engine.speak(alice.agent_id, { message: 'Turn 3' });
    vi.advanceTimersByTime(500);
    engine.speak(bob.agent_id, { message: 'Turn 4' });
    vi.advanceTimersByTime(500);

    const conversationId = engine.state.getLoggedIn(alice.agent_id)?.current_conversation_id;
    expect(engine.state.conversations.get(conversationId!)?.current_speaker_agent_id).toBe(alice.agent_id);

    engine.fireServerEvent('Dark clouds gather.');
    engine.executeWait(alice.agent_id, { duration: 1 });

    expect(engine.state.conversations.get(conversationId!)).toBeNull();
    expect(engine.state.getLoggedIn(alice.agent_id)?.current_conversation_id).toBeNull();
    expect(engine.state.getLoggedIn(bob.agent_id)?.current_conversation_id).toBeNull();
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('in_action');
  });

  it('does not prematurely clear the server event window when accept timeout fires on an already-resolved conversation', async () => {
    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 4,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');

    // Start a conversation and immediately accept it
    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });

    // Fire a server event — both agents get the window
    const fired = engine.fireServerEvent('Dark clouds gather.');
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBe(fired.server_event_id);
    expect(engine.state.getLoggedIn(bob.agent_id)?.active_server_event_id).toBe(fired.server_event_id);

    // Let the accept timeout fire (conversation is already accepted, so it's a no-op)
    vi.advanceTimersByTime(1000);

    // Server event window should still be active for both agents
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBe(fired.server_event_id);
    expect(engine.state.getLoggedIn(bob.agent_id)?.active_server_event_id).toBe(fired.server_event_id);
  });

  it('does not reset an agent that already joined a newer conversation before the interrupted one finishes closing', async () => {
    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 4,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    const charlie = await engine.registerAgent({ discord_bot_id: 'bot-charlie' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await engine.loginAgent(charlie.agent_id);
    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');
    engine.state.setNode(charlie.agent_id, '3-3');

    const original = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });

    engine.fireServerEvent('Dark clouds gather.');
    engine.executeWait(bob.agent_id, { duration: 1 });

    const replacement = engine.startConversation(charlie.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Need a quick word',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Sure' });

    engine.speak(alice.agent_id, { message: 'We can continue later' });
    vi.advanceTimersByTime(500);

    expect(engine.state.conversations.get(original.conversation_id)).toBeNull();
    expect(engine.state.conversations.get(replacement.conversation_id)?.status).toBe('active');
    expect(engine.state.getLoggedIn(bob.agent_id)?.state).toBe('in_conversation');
    expect(engine.state.getLoggedIn(charlie.agent_id)?.state).toBe('in_conversation');
  });
});
