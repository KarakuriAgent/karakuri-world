import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorldError } from '../../../src/types/api.js';
import { createTestWorld } from '../../helpers/test-world.js';

describe('movement domain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts movement and completes it on timer fire', async () => {
    const { engine } = createTestWorld({ withDiscord: false });
    const alice = engine.registerAgent({ agent_name: 'alice' });
    await engine.joinAgent(alice.agent_id);

    const response = engine.move(alice.agent_id, { direction: 'east' });
    expect(response).toMatchObject({
      arrives_at: Date.now() + 1000,
    });
    expect(['3-1', '3-2']).toContain(response.from_node_id);
    expect(['3-2', '3-3']).toContain(response.to_node_id);
    expect(engine.state.getJoined(alice.agent_id)?.state).toBe('moving');

    vi.advanceTimersByTime(1000);

    expect(engine.state.getJoined(alice.agent_id)).toMatchObject({
      node_id: response.to_node_id,
      state: 'idle',
    });
  });

  it('rejects impassable moves and moves while a conversation is pending', async () => {
    const { engine } = createTestWorld({ withDiscord: false });
    const alice = engine.registerAgent({ agent_name: 'alice' });
    await engine.joinAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');

    expect(() => engine.move(alice.agent_id, { direction: 'east' })).toThrowError(WorldError);

    engine.state.setPendingConversation(alice.agent_id, 'conversation-1');
    expect(() => engine.move(alice.agent_id, { direction: 'south' })).toThrowError(WorldError);
  });
});
