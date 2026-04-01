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
    const { engine } = createTestWorld();
    const alice = engine.registerAgent({ agent_name: 'alice', agent_label: 'alice', discord_bot_id: 'bot-alice', });
    await engine.loginAgent(alice.agent_id);

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
    const { engine } = createTestWorld();
    const alice = engine.registerAgent({ agent_name: 'alice', agent_label: 'alice', discord_bot_id: 'bot-alice', });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '3-1');

    engine.move(alice.agent_id, { target_node_id: '3-4' });
    const fired = engine.fireServerEvent('sudden-rain');

    expect(engine.state.getLoggedIn(alice.agent_id)?.pending_server_event_ids).toEqual([fired.server_event_id]);
    expect(
      engine.timerManager.list().some((timer) => timer.type === 'server_event_timeout' && timer.agent_id === alice.agent_id),
    ).toBe(false);

    vi.advanceTimersByTime(3000);

    expect(engine.state.getLoggedIn(alice.agent_id)?.pending_server_event_ids).toEqual([]);
    expect(
      engine.timerManager.list().some((timer) => timer.type === 'server_event_timeout' && timer.agent_id === alice.agent_id),
    ).toBe(true);
  });

  it('emits an expiration event when the last server event timeout fires', async () => {
    const { engine } = createTestWorld();
    const alice = engine.registerAgent({ agent_name: 'alice', agent_label: 'alice', discord_bot_id: 'bot-alice', });
    await engine.loginAgent(alice.agent_id);

    const events: Array<{ type: string; fullyExpired?: boolean; agentId?: string }> = [];
    engine.eventBus.onAny((event) => {
      events.push({
        type: event.type,
        fullyExpired: event.type === 'server_event_expired' ? event.fully_expired : undefined,
        agentId: event.type === 'server_event_expired' ? event.agent_id : undefined,
      });
    });

    const fired = engine.fireServerEvent('sudden-rain');
    vi.advanceTimersByTime(5000);

    expect(engine.getSnapshot().server_events).toHaveLength(0);
    expect(events).toContainEqual({
      type: 'server_event_expired',
      fullyExpired: true,
      agentId: alice.agent_id,
    });
    expect(events.filter((event) => event.type === 'server_event_expired')).toHaveLength(1);
    expect(fired.server_event_id).toMatch(/^server-event-/);
  });

  it('emits an expiration event for intermediate timeouts so outstanding counts can refresh', async () => {
    const { engine } = createTestWorld({
      config: {
        movement: {
          duration_ms: 3000,
        },
      },
    });
    const alice = engine.registerAgent({ agent_name: 'alice', agent_label: 'alice', discord_bot_id: 'bot-alice' });
    const bob = engine.registerAgent({ agent_name: 'bob', agent_label: 'bob', discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(bob.agent_id, '3-1');

    const expiredEvents: Array<{ agent_id: string; delivered_agent_ids: string[]; pending_agent_ids: string[]; fully_expired: boolean }> = [];
    engine.eventBus.onAny((event) => {
      if (event.type === 'server_event_expired') {
        expiredEvents.push({
          agent_id: event.agent_id,
          delivered_agent_ids: event.delivered_agent_ids,
          pending_agent_ids: event.pending_agent_ids,
          fully_expired: event.fully_expired,
        });
      }
    });

    engine.move(bob.agent_id, { target_node_id: '3-4' });
    engine.fireServerEvent('sudden-rain');

    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(4000);
    vi.advanceTimersByTime(5000);

    expect(expiredEvents).toEqual([
      {
        agent_id: alice.agent_id,
        delivered_agent_ids: [],
        pending_agent_ids: [bob.agent_id],
        fully_expired: false,
      },
      {
        agent_id: bob.agent_id,
        delivered_agent_ids: [],
        pending_agent_ids: [],
        fully_expired: true,
      },
    ]);
  });

  it('removes responders from the outstanding server event count', async () => {
    const { engine } = createTestWorld();
    const alice = engine.registerAgent({ agent_name: 'alice', agent_label: 'alice', discord_bot_id: 'bot-alice' });
    const bob = engine.registerAgent({ agent_name: 'bob', agent_label: 'bob', discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);

    const fired = engine.fireServerEvent('sudden-rain');
    engine.selectServerEvent(alice.agent_id, {
      server_event_id: fired.server_event_id,
      choice_id: 'take-shelter',
    });

    expect(engine.getSnapshot().server_events).toEqual([
      expect.objectContaining({
        server_event_id: fired.server_event_id,
        delivered_agent_ids: [bob.agent_id],
        pending_agent_ids: [],
      }),
    ]);
  });
});
