import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestWorld } from '../../helpers/test-world.js';

async function setupConversationWorld(options?: { max_turns?: number }) {
  const { engine } = createTestWorld({
    config: {
      conversation: {
        max_turns: options?.max_turns ?? 2,
        interval_ms: 500,
        accept_timeout_ms: 1000,
        turn_timeout_ms: 1000,
      },
    },
  });
  const alice = engine.registerAgent({ agent_name: 'alice', agent_label: 'alice', discord_bot_id: 'bot-alice', });
  const bob = engine.registerAgent({ agent_name: 'bob', agent_label: 'bob', discord_bot_id: 'bot-bob', });
  await engine.loginAgent(alice.agent_id);
  await engine.loginAgent(bob.agent_id);
  engine.state.setNode(bob.agent_id, '3-2');
  return { engine, alice, bob };
}

describe('conversation domain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('runs through accept, max turns, goodbye, and end', async () => {
    const { engine, alice, bob } = await setupConversationWorld({ max_turns: 2 });
    const messageEvents: Array<{ turn: number; message: string }> = [];
    const unsubscribe = engine.eventBus.onAny((event) => {
      if (event.type === 'conversation_message') {
        messageEvents.push({
          turn: event.turn,
          message: event.message,
        });
      }
    });

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    expect(engine.state.getLoggedIn(alice.agent_id)?.pending_conversation_id).toBe(started.conversation_id);

    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('in_conversation');
    expect(engine.state.getLoggedIn(bob.agent_id)?.state).toBe('in_conversation');

    expect(messageEvents).toEqual([
      {
        turn: 1,
        message: 'Hello Bob',
      },
      {
        turn: 2,
        message: 'Hello Alice',
      },
    ]);
    vi.advanceTimersByTime(500);

    const conversation = engine.state.conversations.get(started.conversation_id);
    expect(conversation?.status).toBe('closing');
    expect(conversation?.current_speaker_agent_id).toBe(alice.agent_id);

    expect(engine.speak(alice.agent_id, { message: 'Goodbye' })).toEqual({
      turn: 3,
    });
    expect(messageEvents).toEqual([
      {
        turn: 1,
        message: 'Hello Bob',
      },
      {
        turn: 2,
        message: 'Hello Alice',
      },
      {
        turn: 3,
        message: 'Goodbye',
      },
    ]);
    vi.advanceTimersByTime(500);

    expect(engine.state.conversations.get(started.conversation_id)).toBeNull();
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
    expect(engine.state.getLoggedIn(bob.agent_id)?.state).toBe('idle');
    unsubscribe();
  });

  it('handles rejection and accept timeout', async () => {
    const { engine, alice, bob } = await setupConversationWorld();

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Will you talk?',
    });
    engine.rejectConversation(bob.agent_id);
    expect(engine.state.conversations.get(started.conversation_id)).toBeNull();

    const timed = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Maybe later?',
    });
    vi.advanceTimersByTime(1000);
    expect(engine.state.conversations.get(timed.conversation_id)).toBeNull();
  });

  it('ends conversation by agent request', async () => {
    const { engine, alice, bob } = await setupConversationWorld({ max_turns: 10 });
    const endEvents: Array<{ reason: string }> = [];
    const unsubscribe = engine.eventBus.onAny((event) => {
      if (event.type === 'conversation_ended') {
        endEvents.push({ reason: event.reason });
      }
    });

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);

    engine.endConversation(alice.agent_id, { message: 'Goodbye Bob' });
    vi.advanceTimersByTime(500);

    const conversation = engine.state.conversations.get(started.conversation_id);
    expect(conversation?.status).toBe('closing');
    expect(conversation?.closing_reason).toBe('ended_by_agent');

    engine.speak(bob.agent_id, { message: 'Farewell Alice' });
    vi.advanceTimersByTime(500);

    expect(engine.state.conversations.get(started.conversation_id)).toBeNull();
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
    expect(engine.state.getLoggedIn(bob.agent_id)?.state).toBe('idle');
    expect(endEvents).toEqual([{ reason: 'ended_by_agent' }]);
    unsubscribe();
  });

  it('rejects endConversation when agent is idle', async () => {
    const { engine, alice } = await setupConversationWorld();

    expect(() => engine.endConversation(alice.agent_id, { message: 'bye' })).toThrow(
      expect.objectContaining({ code: 'state_conflict' }),
    );
  });

  it('rejects endConversation with empty message', async () => {
    const { engine, alice, bob } = await setupConversationWorld({ max_turns: 10 });
    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });
    vi.advanceTimersByTime(500);

    expect(() => engine.endConversation(alice.agent_id, { message: '   ' })).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });

  it('rejects endConversation when it is not the agent turn', async () => {
    const { engine, alice, bob } = await setupConversationWorld({ max_turns: 10 });
    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });
    vi.advanceTimersByTime(500);

    // It is Alice's turn, Bob should not be able to end
    expect(() => engine.endConversation(bob.agent_id, { message: 'bye' })).toThrow(
      expect.objectContaining({ code: 'not_your_turn' }),
    );
  });

  it('rejects endConversation on a closing conversation', async () => {
    const { engine, alice, bob } = await setupConversationWorld({ max_turns: 2 });
    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });
    // interval fires → max_turns reached → closing, Alice's turn
    vi.advanceTimersByTime(500);

    // conversation is now closing, endConversation only accepts 'active'
    expect(() => engine.endConversation(alice.agent_id, { message: 'bye' })).toThrow(
      expect.objectContaining({ code: 'conversation_not_found' }),
    );
  });

  it('ends with ended_by_agent reason when partner times out after end request', async () => {
    const { engine, alice, bob } = await setupConversationWorld({ max_turns: 10 });
    const endEvents: Array<{ reason: string }> = [];
    const unsubscribe = engine.eventBus.onAny((event) => {
      if (event.type === 'conversation_ended') {
        endEvents.push({ reason: event.reason });
      }
    });

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);

    engine.endConversation(alice.agent_id, { message: 'Goodbye Bob' });
    // interval fires → closing with ended_by_agent, Bob's turn
    vi.advanceTimersByTime(500);

    // Bob does not respond → turn timeout fires
    vi.advanceTimersByTime(1000);

    expect(engine.state.conversations.get(started.conversation_id)).toBeNull();
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
    expect(engine.state.getLoggedIn(bob.agent_id)?.state).toBe('idle');
    expect(endEvents).toEqual([{ reason: 'ended_by_agent' }]);
    unsubscribe();
  });

  it('ends when a turn times out', async () => {
    const { engine, alice, bob } = await setupConversationWorld({ max_turns: 4 });
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi there' });

    // accept creates an interval timer (500ms), which then creates a turn timer (1000ms)
    vi.advanceTimersByTime(500 + 1000);

    expect(engine.state.conversations.get(started.conversation_id)).toBeNull();
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
    expect(engine.state.getLoggedIn(bob.agent_id)?.state).toBe('idle');
  });
});
