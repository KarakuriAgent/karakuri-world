import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestWorld } from '../helpers/test-world.js';

describe('movement integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('updates perception after a move completes', async () => {
    const { engine } = createTestWorld({ withDiscord: false });
    const alice = engine.registerAgent({ agent_name: 'alice' });
    await engine.joinAgent(alice.agent_id);

    const move = engine.move(alice.agent_id, { direction: 'east' });
    vi.advanceTimersByTime(1000);

    expect(engine.getPerception(alice.agent_id).current_node.node_id).toBe(move.to_node_id);
  });
});
