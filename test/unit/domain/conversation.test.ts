import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestWorld } from '../../helpers/test-world.js';

async function setupConversationWorld(options?: { max_turns?: number }) {
  const { engine } = createTestWorld({
    withDiscord: false,
    config: {
      conversation: {
        max_turns: options?.max_turns ?? 2,
        interval_ms: 500,
        accept_timeout_ms: 1000,
        turn_timeout_ms: 1000,
      },
    },
  });
  const alice = engine.registerAgent({ agent_name: 'alice' });
  const bob = engine.registerAgent({ agent_name: 'bob' });
  await engine.joinAgent(alice.agent_id);
  await engine.joinAgent(bob.agent_id);
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
    expect(engine.state.getJoined(alice.agent_id)?.pending_conversation_id).toBe(started.conversation_id);

    engine.acceptConversation(bob.agent_id, { conversation_id: started.conversation_id });
    expect(engine.state.getJoined(alice.agent_id)?.state).toBe('in_conversation');
    expect(engine.state.getJoined(bob.agent_id)?.state).toBe('in_conversation');

    expect(
      engine.speak(bob.agent_id, { conversation_id: started.conversation_id, message: 'Hello Alice' }),
    ).toEqual({ turn: 2 });
    expect(messageEvents).toEqual([
      {
        turn: 2,
        message: 'Hello Alice',
      },
    ]);
    vi.advanceTimersByTime(500);

    const conversation = engine.state.conversations.get(started.conversation_id);
    expect(conversation?.status).toBe('closing');
    expect(conversation?.current_speaker_agent_id).toBe(alice.agent_id);

    expect(engine.speak(alice.agent_id, { conversation_id: started.conversation_id, message: 'Goodbye' })).toEqual({
      turn: 3,
    });
    expect(messageEvents).toEqual([
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
    expect(engine.state.getJoined(alice.agent_id)?.state).toBe('idle');
    expect(engine.state.getJoined(bob.agent_id)?.state).toBe('idle');
    unsubscribe();
  });

  it('handles rejection and accept timeout', async () => {
    const { engine, alice, bob } = await setupConversationWorld();

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Will you talk?',
    });
    engine.rejectConversation(bob.agent_id, { conversation_id: started.conversation_id });
    expect(engine.state.conversations.get(started.conversation_id)).toBeNull();

    const timed = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Maybe later?',
    });
    vi.advanceTimersByTime(1000);
    expect(engine.state.conversations.get(timed.conversation_id)).toBeNull();
  });

  it('ends when a turn times out', async () => {
    const { engine, alice, bob } = await setupConversationWorld({ max_turns: 4 });
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { conversation_id: started.conversation_id });

    vi.advanceTimersByTime(1000);

    expect(engine.state.conversations.get(started.conversation_id)).toBeNull();
    expect(engine.state.getJoined(alice.agent_id)?.state).toBe('idle');
    expect(engine.state.getJoined(bob.agent_id)?.state).toBe('idle');
  });
});
