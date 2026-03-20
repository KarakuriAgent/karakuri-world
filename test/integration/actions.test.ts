import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestWorld } from '../helpers/test-world.js';

describe('actions integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('executes an NPC action end-to-end', async () => {
    const { engine } = createTestWorld();
    const alice = engine.registerAgent({ agent_name: 'alice', agent_label: 'alice', discord_bot_id: 'bot-alice', });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');

    const response = engine.executeAction(alice.agent_id, { action_id: 'greet-gatekeeper' });
    expect(response.action_id).toBe('greet-gatekeeper');

    vi.advanceTimersByTime(1200);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
  });
});
