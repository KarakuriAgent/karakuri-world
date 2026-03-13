import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestWorld } from '../helpers/test-world.js';

describe('conversation integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('allows an agent in action to accept a conversation and cancels the action', async () => {
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
    const alice = engine.registerAgent({ agent_name: 'alice', discord_bot_id: 'bot-alice' });
    const bob = engine.registerAgent({ agent_name: 'bob', discord_bot_id: 'bot-bob' });
    await engine.joinAgent(alice.agent_id);
    await engine.joinAgent(bob.agent_id);

    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '1-1');
    engine.executeAction(bob.agent_id, { action_id: 'greet-gatekeeper' });
    engine.state.setNode(bob.agent_id, '3-2');

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Can we talk?',
    });
    engine.acceptConversation(bob.agent_id, { conversation_id: started.conversation_id });

    expect(engine.state.getJoined(bob.agent_id)?.state).toBe('in_conversation');
    expect(engine.timerManager.list().some((timer) => timer.type === 'action' && timer.agent_id === bob.agent_id)).toBe(false);
  });
});
