import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestWorld } from '../../helpers/test-world.js';

describe('server event domain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('fires and selects an event immediately for idle agents', async () => {
    const { engine } = createTestWorld({ withDiscord: false });
    const alice = engine.registerAgent({ agent_name: 'alice' });
    await engine.joinAgent(alice.agent_id);

    const fired = engine.fireServerEvent('sudden-rain');
    expect(engine.getSnapshot().server_events).toHaveLength(1);

    expect(
      engine.selectServerEvent(alice.agent_id, {
        server_event_id: fired.server_event_id,
        choice_id: 'take-shelter',
      }),
    ).toEqual({ status: 'ok' });
    expect(engine.getSnapshot().server_events).toHaveLength(0);
  });

  it('delays event delivery while moving and releases it on arrival', async () => {
    const { engine } = createTestWorld({ withDiscord: false });
    const alice = engine.registerAgent({ agent_name: 'alice' });
    await engine.joinAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '3-1');

    engine.move(alice.agent_id, { target_node_id: '3-4' });
    const fired = engine.fireServerEvent('sudden-rain');

    expect(engine.state.getJoined(alice.agent_id)?.pending_server_event_ids).toEqual([fired.server_event_id]);
    expect(
      engine.timerManager.list().some((timer) => timer.type === 'server_event_timeout' && timer.agent_id === alice.agent_id),
    ).toBe(false);

    vi.advanceTimersByTime(3000);

    expect(engine.state.getJoined(alice.agent_id)?.pending_server_event_ids).toEqual([]);
    expect(
      engine.timerManager.list().some((timer) => timer.type === 'server_event_timeout' && timer.agent_id === alice.agent_id),
    ).toBe(true);
  });
});
