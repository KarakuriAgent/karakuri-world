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
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice', });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');

    const response = engine.executeAction(alice.agent_id, { action_id: 'greet-gatekeeper' });
    expect(response.ok).toBe(true);

    vi.advanceTimersByTime(1200);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
  });

  it('executes a variable-duration building action end-to-end', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice', });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '2-4');

    const response = engine.executeAction(alice.agent_id, { action_id: 'long-nap', duration_minutes: 2 });
    expect(response.ok).toBe(true);

    vi.advanceTimersByTime(120_000);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
  });
});
