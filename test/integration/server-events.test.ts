import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestWorld } from '../helpers/test-world.js';

describe('server events integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('moves a conversation into closing when an in-conversation agent starts a new command during the event window', async () => {
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

    engine.fireServerEvent('Dark clouds gather.');
    engine.executeWait(bob.agent_id, { duration: 1 });

    expect(engine.state.conversations.get(started.conversation_id)?.status).toBe('closing');
    expect(engine.state.conversations.get(started.conversation_id)?.current_speaker_agent_id).toBe(alice.agent_id);
    expect(engine.state.getLoggedIn(bob.agent_id)?.state).toBe('in_action');
  });
});
