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

    expect(engine.speak(alice.agent_id, { message: 'Goodbye', next_speaker_agent_id: bob.agent_id })).toEqual({
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

    engine.endConversation(alice.agent_id, { message: 'Goodbye Bob', next_speaker_agent_id: bob.agent_id });
    let conversation = engine.state.conversations.get(started.conversation_id);
    expect(conversation?.status).toBe('closing');
    expect(conversation?.closing_reason).toBe('ended_by_agent');
    expect(conversation?.current_speaker_agent_id).toBe(bob.agent_id);
    expect(closingEvents).toEqual([{ speaker: bob.agent_id, reason: 'ended_by_agent' }]);
    vi.advanceTimersByTime(500);

    conversation = engine.state.conversations.get(started.conversation_id);
    expect(conversation?.status).toBe('closing');

    engine.speak(bob.agent_id, { message: 'Farewell Alice', next_speaker_agent_id: alice.agent_id });
    vi.advanceTimersByTime(500);

    expect(engine.state.conversations.get(started.conversation_id)).toBeNull();
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
    expect(engine.state.getLoggedIn(bob.agent_id)?.state).toBe('idle');
    expect(endEvents).toEqual([{ reason: 'ended_by_agent' }]);
    unsubscribe();
  });

  it('rejects endConversation when agent is idle', async () => {
    const { engine, alice } = await setupConversationWorld();

    expect(() => engine.endConversation(alice.agent_id, { message: 'bye', next_speaker_agent_id: 'unused' })).toThrow(
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

    expect(() => engine.endConversation(alice.agent_id, { message: '   ', next_speaker_agent_id: bob.agent_id })).toThrow(
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
    expect(() => engine.endConversation(bob.agent_id, { message: 'bye', next_speaker_agent_id: alice.agent_id })).toThrow(
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
    expect(() => engine.endConversation(alice.agent_id, { message: 'bye', next_speaker_agent_id: bob.agent_id })).toThrow(
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

    engine.endConversation(alice.agent_id, { message: 'Goodbye Bob', next_speaker_agent_id: bob.agent_id });
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

    expect(() => engine.speak(alice.agent_id, { message: 'test', next_speaker_agent_id: bob.agent_id })).toThrow(
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
    engine.speak(alice.agent_id, { message: 'Goodbye', next_speaker_agent_id: bob.agent_id });
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
    });

    engine.speak(alice.agent_id, {
      message: 'Bob, over to you.',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);
    engine.speak(bob.agent_id, {
      message: 'Alice, continue.',
      next_speaker_agent_id: alice.agent_id,
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
        current_speaker_agent_id: alice.agent_id,
      }),
    ]);
  });

  it('skips the paused resume speaker if they log out during an inactive-check pause', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 10, inactive_check_turns: 1 });
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
    });
    engine.joinConversation(dave.agent_id, {
      conversation_id: started.conversation_id,
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

    engine.endConversation(alice.agent_id, { message: 'Goodbye Bob', next_speaker_agent_id: bob.agent_id });

    const conversation = engine.state.conversations.get(started.conversation_id);
    expect(conversation?.status).toBe('closing');
    expect(conversation?.current_speaker_agent_id).toBe(bob.agent_id);
    expect(() => engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
    })).toThrow(expect.objectContaining({ code: 'conversation_not_found' }));
  });

  it('notifies discarded pending joiners when a 2-person conversation ends before they are applied', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 10 });
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);

    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
    });

    const cancelledEvents: WorldEvent[] = [];
    const unsubscribe = engine.eventBus.onAny((event) => {
      if (event.type === 'conversation_pending_join_cancelled') {
        cancelledEvents.push(event);
      }
    });

    engine.endConversation(alice.agent_id, { message: 'Goodbye Bob', next_speaker_agent_id: bob.agent_id });

    expect(cancelledEvents).toContainEqual(expect.objectContaining({
      type: 'conversation_pending_join_cancelled',
      conversation_id: started.conversation_id,
      agent_id: carol.agent_id,
      reason: 'ended_by_agent',
    }));
    expect(engine.state.getLoggedIn(carol.agent_id)).toEqual(expect.objectContaining({
      state: 'idle',
      current_conversation_id: null,
    }));
    unsubscribe();
  });

  it('discards pending joiners when logout ends a conversation before their turn-boundary join', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 10 });
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);

    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
    });

    const cancelledEvents: WorldEvent[] = [];
    const unsubscribe = engine.eventBus.onAny((event) => {
      if (event.type === 'conversation_pending_join_cancelled') {
        cancelledEvents.push(event);
      }
    });

    await engine.logoutAgent(alice.agent_id);

    expect(engine.state.conversations.get(started.conversation_id)).toBeNull();
    expect(engine.state.getLoggedIn(bob.agent_id)).toEqual(expect.objectContaining({
      state: 'idle',
      current_conversation_id: null,
    }));
    expect(engine.state.getLoggedIn(carol.agent_id)).toEqual(expect.objectContaining({
      state: 'idle',
      current_conversation_id: null,
    }));
    expect(cancelledEvents).toContainEqual(expect.objectContaining({
      type: 'conversation_pending_join_cancelled',
      conversation_id: started.conversation_id,
      agent_id: carol.agent_id,
      reason: 'participant_logged_out',
    }));
    unsubscribe();
  });

  it('keeps pending joiners queued when logout continues an active group conversation', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 10 });
    const dave = await engine.registerAgent({ discord_bot_id: 'bot-dave' });
    await engine.loginAgent(dave.agent_id);
    engine.state.setNode(dave.agent_id, '3-2');

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
    });
    vi.advanceTimersByTime(500);

    expect(engine.state.conversations.get(started.conversation_id)).toEqual(expect.objectContaining({
      participant_agent_ids: [alice.agent_id, bob.agent_id, carol.agent_id],
      pending_participant_agent_ids: [],
      current_speaker_agent_id: alice.agent_id,
    }));

    engine.joinConversation(dave.agent_id, {
      conversation_id: started.conversation_id,
    });

    await engine.logoutAgent(alice.agent_id);

    expect(engine.state.conversations.get(started.conversation_id)).toEqual(expect.objectContaining({
      participant_agent_ids: [bob.agent_id, carol.agent_id],
      pending_participant_agent_ids: [dave.agent_id],
      current_speaker_agent_id: bob.agent_id,
    }));
    expect(engine.state.getLoggedIn(dave.agent_id)).toEqual(expect.objectContaining({
      state: 'in_conversation',
      current_conversation_id: started.conversation_id,
    }));
    expect(engine.timerManager.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'conversation_turn',
        conversation_id: started.conversation_id,
        current_speaker_agent_id: bob.agent_id,
      }),
    ]));
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
    expect(() => engine.speak(bob.agent_id, { message: 'One last thing.' } as never)).toThrow(
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
    });

    engine.speak(alice.agent_id, {
      message: 'Bob, your turn next.',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);

    engine.endConversation(bob.agent_id, { message: 'I need to go.', next_speaker_agent_id: carol.agent_id });
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
    });

    engine.speak(alice.agent_id, {
      message: 'Bob, over to you.',
      next_speaker_agent_id: bob.agent_id,
    });
    await engine.logoutAgent(carol.agent_id);
    vi.advanceTimersByTime(500);

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
    });
    engine.joinConversation(dave.agent_id, {
      conversation_id: started.conversation_id,
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
    });
    engine.speak(alice.agent_id, {
      message: 'Carolも来たよ。',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);

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
    });
    engine.speak(alice.agent_id, {
      message: 'Carolも一緒に話そう。',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);

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
    });

    engine.speak(alice.agent_id, {
      message: 'Bob, over to you.',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);
    engine.speak(bob.agent_id, {
      message: 'Alice, continue.',
      next_speaker_agent_id: alice.agent_id,
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
    });
    engine.joinConversation(eve.agent_id, {
      conversation_id: started.conversation_id,
    });

    expect(() => engine.joinConversation(frank.agent_id, {
      conversation_id: started.conversation_id,
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
    });

    engine.speak(alice.agent_id, {
      message: 'Bob, over to you.',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);
    engine.speak(bob.agent_id, {
      message: 'Alice, continue.',
      next_speaker_agent_id: alice.agent_id,
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
    });

    expect(() => engine.speak(alice.agent_id, {
      message: 'Unknown person next!',
      next_speaker_agent_id: 'nonexistent-agent',
    })).toThrow(expect.objectContaining({ code: 'invalid_next_speaker' }));
  });

  it('removes the agent and continues the conversation when ending a 3+ participant conversation', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 10 });
    const leaveEvents: WorldEvent[] = [];
    const unsubscribe = engine.eventBus.onAny((event) => {
      if (event.type === 'conversation_leave') {
        leaveEvents.push(event);
      }
    });

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
    });

    engine.speak(alice.agent_id, {
      message: 'Carolも来たよ。',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);

    // Bob ends the 3-person conversation
    engine.endConversation(bob.agent_id, { message: 'I need to leave.', next_speaker_agent_id: carol.agent_id });

    // Bob should be removed from the conversation, Alice+Carol continue
    expect(leaveEvents).toContainEqual(expect.objectContaining({
      type: 'conversation_leave',
      agent_id: bob.agent_id,
      reason: 'voluntary',
      participant_agent_ids: expect.arrayContaining([alice.agent_id, carol.agent_id]),
    }));

    // Bob should be idle, Alice+Carol still in_conversation
    expect(engine.state.getLoggedIn(bob.agent_id)?.state).toBe('idle');
    expect(engine.state.getLoggedIn(bob.agent_id)?.current_conversation_id).toBeNull();
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('in_conversation');
    expect(engine.state.getLoggedIn(carol.agent_id)?.state).toBe('in_conversation');

    // Conversation should still exist with Alice+Carol
    const conversation = engine.state.conversations.get(started.conversation_id);
    expect(conversation).not.toBeNull();
    expect(conversation?.participant_agent_ids).toEqual([alice.agent_id, carol.agent_id]);
    expect(conversation?.status).toBe('active');

    // A conversation interval timer should be scheduled for the remaining participants
    const intervalTimers = engine.timerManager.list().filter(
      (timer) => timer.type === 'conversation_interval' && 'conversation_id' in timer && timer.conversation_id === started.conversation_id,
    );
    expect(intervalTimers).toHaveLength(1);

    unsubscribe();
  });

  it('rejects join when the agent is out of range of all participants', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 10 });
    // Alice on 3-1, Bob+Carol on 3-2 (adjacent)
    // Move carol far away to 1-1 (not adjacent to 3-1 or 3-2)
    engine.state.setNode(carol.agent_id, '1-1');

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);

    // Carol is too far to join
    expect(() => engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
    })).toThrow(expect.objectContaining({ code: 'out_of_range' }));
  });

  it('rejects join when the agent is already participating', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 10 });
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
    });

    // Carol is already a participant (pending promoted immediately since timer hasn't fired yet)
    // Try to join again
    expect(() => engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
    })).toThrow(expect.objectContaining({ code: 'state_conflict' }));
  });

  it('rejects join when the agent is already a pending participant', async () => {
    const { engine, alice, bob, carol } = await setupGroupConversationWorld({ max_turns: 10 });
    // Carol is on a non-adjacent node so she stays pending
    engine.state.setNode(carol.agent_id, '1-1');

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    // At this point, the conversation has only Alice+Bob as participants
    // Carol on 1-1 is out of range, so we need her to be adjacent to at least one participant

    // Actually, for pending join, we need carol to be adjacent but the join hasn't been applied yet
    // Let's use a different approach: set carol adjacent and check she can't double-join while pending
    engine.state.setNode(carol.agent_id, '3-1');

    // Carol joins (becomes pending, not yet applied)
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
    });

    // Carol is now pending — try to join again before the timer fires
    expect(() => engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
    })).toThrow(expect.objectContaining({ code: 'state_conflict' }));
  });

  it('emits pending join cancelled event when a pending joiner is discarded on conversation end', async () => {
    const { engine, alice, bob } = await setupConversationWorld({ max_turns: 10 });
    const carol = await engine.registerAgent({ discord_bot_id: 'bot-carol' });
    const dave = await engine.registerAgent({ discord_bot_id: 'bot-dave' });
    await engine.loginAgent(carol.agent_id);
    await engine.loginAgent(dave.agent_id);
    engine.state.setNode(carol.agent_id, '3-2');
    engine.state.setNode(dave.agent_id, '3-2');

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);

    // Carol and Dave join (both pending, not yet applied since interval hasn't fired again)
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
    });
    engine.joinConversation(dave.agent_id, {
      conversation_id: started.conversation_id,
    });

    const cancelledEvents: WorldEvent[] = [];
    const unsubscribe = engine.eventBus.onAny((event) => {
      if (event.type === 'conversation_pending_join_cancelled') {
        cancelledEvents.push(event);
      }
    });

    // Alice ends the 2-person conversation before pending joiners are applied
    // This goes into closing (2-person), discarding pending joiners
    engine.endConversation(alice.agent_id, { message: 'Goodbye', next_speaker_agent_id: bob.agent_id });

    // Carol and Dave's pending joins should be cancelled
    expect(cancelledEvents).toContainEqual(expect.objectContaining({
      type: 'conversation_pending_join_cancelled',
      conversation_id: started.conversation_id,
      agent_id: carol.agent_id,
      reason: 'ended_by_agent',
    }));
    expect(cancelledEvents).toContainEqual(expect.objectContaining({
      type: 'conversation_pending_join_cancelled',
      conversation_id: started.conversation_id,
      agent_id: dave.agent_id,
      reason: 'ended_by_agent',
    }));

    unsubscribe();
  });
});
