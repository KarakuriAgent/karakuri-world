import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorldError } from '../../../src/types/api.js';
import { createTestWorld } from '../../helpers/test-world.js';

describe('actions domain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('lists and executes building actions', async () => {
    const { engine } = createTestWorld();
    const alice = engine.registerAgent({ agent_name: 'alice', discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '2-4');

    expect(engine.getAvailableActions(alice.agent_id).actions).toEqual([
      {
        action_id: 'polish-gears',
        name: 'Gears polishing',
        description: 'Carefully polish the workshop gears.',
        duration_ms: 1500,
        source: {
          type: 'building',
          id: 'building-workshop',
          name: 'Clockwork Workshop',
        },
      },
    ]);

    const response = engine.executeAction(alice.agent_id, { action_id: 'polish-gears' });
    expect(response.completes_at).toBe(Date.now() + 1500);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('in_action');

    vi.advanceTimersByTime(1500);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
  });

  it('supports NPC actions and rejects invalid/unavailable actions', async () => {
    const { engine } = createTestWorld();
    const alice = engine.registerAgent({ agent_name: 'alice', discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');

    expect(engine.getAvailableActions(alice.agent_id).actions[0]?.action_id).toBe('greet-gatekeeper');
    expect(() => engine.executeAction(alice.agent_id, { action_id: 'missing-action' })).toThrowError(WorldError);

    engine.state.setNode(alice.agent_id, '3-4');
    expect(() => engine.executeAction(alice.agent_id, { action_id: 'polish-gears' })).toThrowError(WorldError);
  });
});
