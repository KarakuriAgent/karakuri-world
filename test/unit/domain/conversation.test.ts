import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginClosingConversation,
  detachParticipantFromClosingConversation,
} from '../../../src/domain/conversation.js';
import type { WorldEvent } from '../../../src/types/event.js';
import { createTestWorld } from '../../helpers/test-world.js';

async function setupConversationWorld(options?: { max_turns?: number; inactive_check_turns?: number }) {
  const { engine } = createTestWorld({
    config: {
      conversation: {
        max_turns: options?.max_turns ?? 2,
        inactive_check_turns: options?.inactive_check_turns ?? 10,
        interval_ms: 500,
        accept_timeout_ms: 1000,
        turn_timeout_ms: 1000,
      },
    },
  });
  const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice', });
  const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob', });
  await engine.loginAgent(alice.agent_id);
  await engine.loginAgent(bob.agent_id);
  engine.state.setNode(bob.agent_id, '3-2');
  return { engine, alice, bob };
}

async function setupGroupConversationWorld(options?: { max_turns?: number; inactive_check_turns?: number }) {
  const { engine, alice, bob } = await setupConversationWorld(options);
  const carol = await engine.registerAgent({ discord_bot_id: 'bot-carol' });
  await engine.loginAgent(carol.agent_id);
  engine.state.setNode(carol.agent_id, '3-2');
  return { engine, alice, bob, carol };
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
    const closingEvents: Array<{ speaker: string; reason: string }> = [];
    const unsubscribe = engine.eventBus.onAny((event) => {
      if (event.type === 'conversation_message') {
        messageEvents.push({
          turn: event.turn,
          message: event.message,
        });
      } else if (event.type === 'conversation_closing') {
        closingEvents.push({
          speaker: event.current_speaker_agent_id,
          reason: event.reason,
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
    expect(closingEvents).toEqual([{ speaker: alice.agent_id, reason: 'max_turns' }]);

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

  it('includes max turns in conversation snapshots', async () => {
    const { engine, alice, bob } = await setupConversationWorld({ max_turns: 4 });

    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });

    expect(engine.getSnapshot().conversations).toEqual([
      expect.objectContaining({
        current_turn: 2,
        max_turns: 4,
        actionable_speaker_agent_id: bob.agent_id,
      }),
    ]);
  });

  it('ends conversation by agent request', async () => {
    const { engine, alice, bob } = await setupConversationWorld({ max_turns: 10 });
    const endEvents: Array<{ reason: string }> = [];
    const closingEvents: Array<{ speaker: string; reason: string }> = [];
    const unsubscribe = engine.eventBus.onAny((event) => {
      if (event.type === 'conversation_ended') {
        endEvents.push({ reason: event.reason });
      } else if (event.type === 'conversation_closing') {
        closingEvents.push({
          speaker: event.current_speaker_agent_id,
          reason: event.reason,
        });
      }
    });

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);

    engine.endConversation(alice.agent_id, { message: 'Goodbye Bob' });
    let conversation = engine.state.conversations.get(started.conversation_id);
    expect(conversation?.status).toBe('closing');
    expect(conversation?.closing_reason).toBe('ended_by_agent');
    expect(conversation?.current_speaker_agent_id).toBe(bob.agent_id);
    expect(closingEvents).toEqual([{ speaker: bob.agent_id, reason: 'ended_by_agent' }]);
    vi.advanceTimersByTime(500);

    conversation = engine.state.conversations.get(started.conversation_id);
    expect(conversation?.status).toBe('closing');

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
    // interval fires → Bob's farewell turn starts
    vi.advanceTimersByTime(500);

    // Bob does not respond → turn timeout fires
    vi.advanceTimersByTime(1000);

    expect(engine.state.conversations.get(started.conversation_id)).toBeNull();
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
    expect(engine.state.getLoggedIn(bob.agent_id)?.state).toBe('idle');
    expect(endEvents).toEqual([{ reason: 'ended_by_agent' }]);
    unsubscribe();
  });

  it('rejects acceptConversation with empty message', async () => {
    const { engine, alice, bob } = await setupConversationWorld();
    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });

    expect(() => engine.acceptConversation(bob.agent_id, { message: '   ' })).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });

  it('rejects speak when turn timer is missing', async () => {
    const { engine, alice, bob } = await setupConversationWorld({ max_turns: 10 });
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });
    vi.advanceTimersByTime(500);

    // Cancel Alice's turn timer to simulate missing timer
    const turnTimer = engine.timerManager.list().find(
      (timer) => timer.type === 'conversation_turn',
    );
    if (turnTimer) {
      engine.timerManager.cancel(turnTimer.timer_id);
    }

    expect(() => engine.speak(alice.agent_id, { message: 'test' })).toThrow(
      expect.objectContaining({ code: 'not_your_turn' }),
    );
  });

  it('does not reset an agent to idle when endConversation fires after the agent has already moved to a new state via server event window', async () => {
    const { engine, alice, bob } = await setupConversationWorld({ max_turns: 4 });
    engine.state.setNode(alice.agent_id, '3-1');

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });

    // Fire server event and have bob interrupt into a wait
    engine.fireServerEvent('Dark clouds gather.');
    engine.executeWait(bob.agent_id, { duration: 1 });

    // Bob is now in_action (waiting). The old conversation is closing.
    expect(engine.state.getLoggedIn(bob.agent_id)?.state).toBe('in_action');

    // Alice (farewell speaker) sends farewell, which triggers endConversation
    engine.speak(alice.agent_id, { message: 'Goodbye' });
    vi.advanceTimersByTime(500);

    // Bob should still be in_action, NOT reset to idle
    expect(engine.state.getLoggedIn(bob.agent_id)?.state).toBe('in_action');
    expect(engine.state.conversations.get(started.conversation_id)).toBeNull();
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

  it('cancels the inactive-check timer when the last pending participant leaves', async () => {
    const { engine, alice, bob } = await setupConversationWorld({ max_turns: 10, inactive_check_turns: 1 });
    const carol = await engine.registerAgent({ discord_bot_id: 'bot-carol' });
    await engine.loginAgent(carol.agent_id);

    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');
    engine.state.setNode(carol.agent_id, '3-2');

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);

    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Mind if I join?',
    });

    engine.speak(alice.agent_id, {
      message: 'Bob, over to you.',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);

    expect(engine.timerManager.list().filter((timer) => timer.type === 'conversation_inactive_check')).toHaveLength(1);

    engine.leaveConversation(carol.agent_id);

    const conversationTimers = engine.timerManager.list().filter(
      (timer) => 'conversation_id' in timer && timer.conversation_id === started.conversation_id,
    );
    expect(conversationTimers.filter((timer) => timer.type === 'conversation_inactive_check')).toHaveLength(0);
    expect(conversationTimers.filter((timer) => timer.type === 'conversation_turn')).toEqual([
      expect.objectContaining({
        current_speaker_agent_id: bob.agent_id,
      }),
    ]);
  });

  it('skips the paused resume speaker if they log out during an inactive-check pause', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 10, inactive_check_turns: 2 });
    const dave = await engine.registerAgent({ discord_bot_id: 'bot-dave' });
    await engine.loginAgent(dave.agent_id);

    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');
    engine.state.setNode(carol.agent_id, '3-2');
    engine.state.setNode(dave.agent_id, '3-2');

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);

    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Mind if I join?',
    });
    engine.joinConversation(dave.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Room for one more?',
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
    expect(engine.getSnapshot().conversations).toEqual([
      expect.objectContaining({
        current_speaker_agent_id: bob.agent_id,
        actionable_speaker_agent_id: alice.agent_id,
      }),
    ]);

    await engine.logoutAgent(alice.agent_id);

    expect(engine.state.conversations.get(started.conversation_id)).toEqual(expect.objectContaining({
      current_speaker_agent_id: bob.agent_id,
      resume_speaker_agent_id: carol.agent_id,
      inactive_check_pending_agent_ids: [carol.agent_id, dave.agent_id],
    }));

    engine.stayInConversation(carol.agent_id);
    engine.stayInConversation(dave.agent_id);

    expect(engine.state.conversations.get(started.conversation_id)).toEqual(expect.objectContaining({
      current_speaker_agent_id: carol.agent_id,
      resume_speaker_agent_id: null,
      inactive_check_pending_agent_ids: [],
    }));
    expect(engine.timerManager.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'conversation_turn',
        conversation_id: started.conversation_id,
        current_speaker_agent_id: carol.agent_id,
      }),
    ]));
  });

  it('enters closing immediately and rejects joins during a 2-person farewell handoff', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 10 });
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);

    engine.endConversation(alice.agent_id, { message: 'Goodbye Bob' });

    const conversation = engine.state.conversations.get(started.conversation_id);
    expect(conversation?.status).toBe('closing');
    expect(conversation?.current_speaker_agent_id).toBe(bob.agent_id);
    expect(() => engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Mind if I join?',
    })).toThrow(expect.objectContaining({ code: 'conversation_not_found' }));
  });

  it('requires next_speaker_agent_id for closing turns that still have 3 or more participants', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 3 });
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Mind if I join?',
    });

    engine.speak(alice.agent_id, {
      message: 'Bob, over to you.',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);

    expect(engine.state.conversations.get(started.conversation_id)).toEqual(expect.objectContaining({
      status: 'closing',
      current_speaker_agent_id: bob.agent_id,
      participant_agent_ids: [alice.agent_id, bob.agent_id, carol.agent_id],
    }));
    expect(() => engine.speak(bob.agent_id, { message: 'One last thing.' })).toThrow(
      expect.objectContaining({ code: 'next_speaker_required' }),
    );
  });

  it('defaults voluntary group leave handoff to the next participant after the leaver', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 10 });
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Mind if I join?',
    });

    engine.speak(alice.agent_id, {
      message: 'Bob, your turn next.',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);

    engine.endConversation(bob.agent_id, { message: 'I need to go.' });
    vi.advanceTimersByTime(500);

    const conversation = engine.state.conversations.get(started.conversation_id);
    expect(conversation?.current_speaker_agent_id).toBe(carol.agent_id);
    expect(engine.timerManager.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'conversation_turn',
        conversation_id: started.conversation_id,
        current_speaker_agent_id: carol.agent_id,
      }),
    ]));
  });

  it('preserves the pending interval next speaker when another participant logs out', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 10 });
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Mind if I join?',
    });

    engine.speak(alice.agent_id, {
      message: 'Bob, over to you.',
      next_speaker_agent_id: bob.agent_id,
    });
    await engine.logoutAgent(carol.agent_id);

    const conversation = engine.state.conversations.get(started.conversation_id);
    expect(conversation?.current_speaker_agent_id).toBe(bob.agent_id);
    expect(engine.timerManager.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'conversation_turn',
        conversation_id: started.conversation_id,
        current_speaker_agent_id: bob.agent_id,
      }),
    ]));
  });

  it('emits a leave update and a new turn prompt when detaching the current speaker from a non-server-event closing conversation', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 3 });
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Mind if I join?',
    });

    engine.speak(alice.agent_id, {
      message: 'Bob, over to you.',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);

    const events: WorldEvent[] = [];
    const unsubscribe = engine.eventBus.onAny((event) => {
      if (event.type === 'conversation_leave' || event.type === 'conversation_turn_started' || event.type === 'conversation_closing') {
        events.push(event);
      }
    });

    detachParticipantFromClosingConversation(engine, started.conversation_id, bob.agent_id);

    expect(events).toEqual([
      expect.objectContaining({
        type: 'conversation_leave',
        agent_id: bob.agent_id,
        reason: 'server_event',
        participant_agent_ids: [alice.agent_id, carol.agent_id],
        next_speaker_agent_id: alice.agent_id,
      }),
      expect.objectContaining({
        type: 'conversation_turn_started',
        current_speaker_agent_id: alice.agent_id,
      }),
    ]);
    expect(engine.timerManager.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'conversation_turn',
        conversation_id: started.conversation_id,
        current_speaker_agent_id: alice.agent_id,
      }),
    ]));
    unsubscribe();
  });

  it('emits a leave update when detaching a listener from a closing conversation', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 3 });
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Mind if I join?',
    });

    engine.speak(alice.agent_id, {
      message: 'Bob, over to you.',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);

    const events: WorldEvent[] = [];
    const unsubscribe = engine.eventBus.onAny((event) => {
      if (event.type === 'conversation_leave' || event.type === 'conversation_turn_started') {
        events.push(event);
      }
    });

    detachParticipantFromClosingConversation(engine, started.conversation_id, carol.agent_id);

    expect(events).toEqual([
      expect.objectContaining({
        type: 'conversation_leave',
        agent_id: carol.agent_id,
        reason: 'server_event',
        participant_agent_ids: [alice.agent_id, bob.agent_id],
      }),
    ]);
    expect(engine.state.conversations.get(started.conversation_id)?.current_speaker_agent_id).toBe(bob.agent_id);
    unsubscribe();
  });

  it('re-resolves the next speaker after removing a closing speaker whose chosen successor already left', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 3 });
    const dave = await engine.registerAgent({ discord_bot_id: 'bot-dave' });
    await engine.loginAgent(dave.agent_id);
    engine.state.setNode(dave.agent_id, '3-2');
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Mind if I join?',
    });
    engine.joinConversation(dave.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Room for one more?',
    });

    engine.speak(alice.agent_id, {
      message: 'Bob, over to you.',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);

    engine.speak(bob.agent_id, {
      message: 'Alice, then Carol.',
      next_speaker_agent_id: alice.agent_id,
    });

    const events: WorldEvent[] = [];
    const unsubscribe = engine.eventBus.onAny((event) => {
      if (event.type === 'conversation_leave' || event.type === 'conversation_closing') {
        events.push(event);
      }
    });

    detachParticipantFromClosingConversation(engine, started.conversation_id, alice.agent_id);
    vi.advanceTimersByTime(500);

    const bobLeaveEvent = events.find((event) => event.type === 'conversation_leave' && event.agent_id === bob.agent_id);
    const closingEvent = [...events].reverse().find((event) => event.type === 'conversation_closing');

    expect(bobLeaveEvent).toEqual(expect.objectContaining({
      type: 'conversation_leave',
      agent_id: bob.agent_id,
      reason: 'voluntary',
      participant_agent_ids: [carol.agent_id, dave.agent_id],
      next_speaker_agent_id: carol.agent_id,
    }));
    expect(closingEvent).toEqual(expect.objectContaining({
      type: 'conversation_closing',
      current_speaker_agent_id: carol.agent_id,
      participant_agent_ids: [carol.agent_id, dave.agent_id],
      reason: 'max_turns',
    }));
    expect(engine.timerManager.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'conversation_turn',
        conversation_id: started.conversation_id,
        current_speaker_agent_id: carol.agent_id,
      }),
    ]));
    unsubscribe();
  });

  it('emits a leave update before server-event closing when removing the interrupting participant', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 10 });
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Mind if I join?',
    });

    const events: WorldEvent[] = [];
    const unsubscribe = engine.eventBus.onAny((event) => {
      if (event.type === 'conversation_leave' || event.type === 'conversation_closing') {
        events.push(event);
      }
    });

    beginClosingConversation(engine, started.conversation_id, alice.agent_id, 'server_event', bob.agent_id);

    expect(events).toEqual([
      expect.objectContaining({
        type: 'conversation_leave',
        agent_id: bob.agent_id,
        reason: 'server_event',
        participant_agent_ids: [alice.agent_id, carol.agent_id],
      }),
      expect.objectContaining({
        type: 'conversation_closing',
        current_speaker_agent_id: alice.agent_id,
        participant_agent_ids: [alice.agent_id, carol.agent_id],
        reason: 'server_event',
      }),
    ]);
    unsubscribe();
  });

  it('re-emits the server-event closing prompt when the current farewell speaker logs out', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 10 });
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Mind if I join?',
    });

    beginClosingConversation(engine, started.conversation_id, bob.agent_id, 'server_event');

    const events: WorldEvent[] = [];
    const unsubscribe = engine.eventBus.onAny((event) => {
      if (event.type === 'conversation_leave' || event.type === 'conversation_closing' || event.type === 'conversation_turn_started') {
        events.push(event);
      }
    });

    await engine.logoutAgent(bob.agent_id);

    expect(events).toEqual([
      expect.objectContaining({
        type: 'conversation_leave',
        agent_id: bob.agent_id,
        reason: 'logged_out',
        participant_agent_ids: [alice.agent_id, carol.agent_id],
      }),
      expect.objectContaining({
        type: 'conversation_closing',
        current_speaker_agent_id: carol.agent_id,
        participant_agent_ids: [alice.agent_id, carol.agent_id],
        reason: 'server_event',
      }),
    ]);
    expect(events.some((event) => event.type === 'conversation_turn_started')).toBe(false);
    unsubscribe();
  });

  it('clears inactive-check state before closing so a later logout cannot leave the conversation stuck', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 10, inactive_check_turns: 1 });
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Mind if I join?',
    });

    engine.speak(alice.agent_id, {
      message: 'Bob, over to you.',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);

    expect(engine.timerManager.list().filter((timer) => timer.type === 'conversation_inactive_check')).toHaveLength(1);

    beginClosingConversation(engine, started.conversation_id, bob.agent_id, 'server_event', alice.agent_id);

    const closingConversation = engine.state.conversations.get(started.conversation_id);
    expect(closingConversation).toEqual(expect.objectContaining({
      status: 'closing',
      inactive_check_pending_agent_ids: [],
      resume_speaker_agent_id: null,
      participant_agent_ids: [bob.agent_id, carol.agent_id],
    }));
    expect(
      engine.timerManager.list().filter(
        (timer) => timer.type === 'conversation_inactive_check' && 'conversation_id' in timer && timer.conversation_id === started.conversation_id,
      ),
    ).toHaveLength(0);

    await engine.logoutAgent(bob.agent_id);

    expect(engine.state.conversations.get(started.conversation_id)).toBeNull();
    expect(
      engine.timerManager.list().filter((timer) => 'conversation_id' in timer && timer.conversation_id === started.conversation_id),
    ).toEqual([]);
    expect(engine.state.getLoggedIn(carol.agent_id)?.state).toBe('idle');
  });

  it('rejects joining when max_participants is reached', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 10 });
    const dave = await engine.registerAgent({ discord_bot_id: 'bot-dave' });
    await engine.loginAgent(dave.agent_id);
    engine.state.setNode(dave.agent_id, '3-2');

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);

    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
      message: 'I join!',
    });

    // max_participants defaults to 5, add 2 more to reach it
    const eve = await engine.registerAgent({ discord_bot_id: 'bot-eve' });
    const frank = await engine.registerAgent({ discord_bot_id: 'bot-frank' });
    await engine.loginAgent(eve.agent_id);
    await engine.loginAgent(frank.agent_id);
    engine.state.setNode(eve.agent_id, '3-2');
    engine.state.setNode(frank.agent_id, '3-2');

    engine.joinConversation(dave.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Me too!',
    });
    engine.joinConversation(eve.agent_id, {
      conversation_id: started.conversation_id,
      message: 'And me!',
    });

    expect(() => engine.joinConversation(frank.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Can I join?',
    })).toThrow(expect.objectContaining({ code: 'conversation_full' }));
  });

  it('auto-removes inactive participants when inactive-check timer fires', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 10, inactive_check_turns: 1 });
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Mind if I join?',
    });

    engine.speak(alice.agent_id, {
      message: 'Bob, over to you.',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);

    // Carol is inactive (not spoken since join) — inactive check should fire
    const conversation = engine.state.conversations.get(started.conversation_id);
    expect(conversation?.inactive_check_pending_agent_ids).toEqual([carol.agent_id]);

    const events: WorldEvent[] = [];
    const unsubscribe = engine.eventBus.onAny((event) => {
      if (event.type === 'conversation_leave') {
        events.push(event);
      }
    });

    // Advance past inactive check timeout
    vi.advanceTimersByTime(1000);

    expect(events).toEqual([
      expect.objectContaining({
        type: 'conversation_leave',
        agent_id: carol.agent_id,
        reason: 'inactive',
      }),
    ]);

    const afterConversation = engine.state.conversations.get(started.conversation_id);
    expect(afterConversation?.participant_agent_ids).toEqual([alice.agent_id, bob.agent_id]);
    expect(afterConversation?.inactive_check_pending_agent_ids).toEqual([]);
    expect(engine.state.getLoggedIn(carol.agent_id)?.state).toBe('idle');
    unsubscribe();
  });

  it('rejects self-nomination in group conversations', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 10 });
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Mind if I join?',
    });

    expect(() => engine.speak(alice.agent_id, {
      message: 'Me next!',
      next_speaker_agent_id: alice.agent_id,
    })).toThrow(expect.objectContaining({ code: 'cannot_nominate_self' }));
  });

  it('rejects invalid next speaker in group conversations', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 10 });
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
      message: 'Mind if I join?',
    });

    expect(() => engine.speak(alice.agent_id, {
      message: 'Unknown person next!',
      next_speaker_agent_id: 'nonexistent-agent',
    })).toThrow(expect.objectContaining({ code: 'invalid_next_speaker' }));
  });
});
