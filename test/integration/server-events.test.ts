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

  it('moves a conversation into closing when an event is selected', async () => {
    const { engine } = createTestWorld({
      withDiscord: false,
      config: {
        conversation: {
          max_turns: 4,
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

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { conversation_id: started.conversation_id });

    const fired = engine.fireServerEvent('sudden-rain');
    engine.selectServerEvent(bob.agent_id, {
      server_event_id: fired.server_event_id,
      choice_id: 'take-shelter',
    });

    expect(engine.state.conversations.get(started.conversation_id)?.status).toBe('closing');
    expect(engine.state.conversations.get(started.conversation_id)?.current_speaker_agent_id).toBe(bob.agent_id);
  });
});
