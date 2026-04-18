import { afterEach, describe, expect, it, vi } from 'vitest';

import { getMapRenderTheme } from '../../../src/discord/map-renderer.js';
import { buildWorldCalendarSnapshot } from '../../../src/engine/world-snapshot.js';
import type { AgentRegistration } from '../../../src/types/agent.js';
import { createTestWorld } from '../../helpers/test-world.js';

function createRegistration(overrides: Partial<AgentRegistration> = {}): AgentRegistration {
  const agentName = overrides.agent_name ?? 'alice';
  const agentId = overrides.agent_id ?? `bot-${agentName}`;

  return {
    agent_id: agentId,
    agent_name: agentName,
    api_key: `karakuri_${agentId}`,
    created_at: 1,
    ...overrides,
  };
}

describe('world snapshot helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a calendar snapshot from the configured timezone', () => {
    const snapshot = buildWorldCalendarSnapshot(Date.parse('2026-01-01T00:00:00Z'), 'Asia/Tokyo');

    expect(snapshot).toEqual({
      timezone: 'Asia/Tokyo',
      local_date: '2026-01-01',
      local_time: '09:00:00',
      display_label: '2026-01-01 09:00 (Asia/Tokyo)',
    });
  });

  it('formats display_label from local date and time', () => {
    const snapshot = buildWorldCalendarSnapshot(Date.parse('2026-02-28T14:59:59Z'), 'Asia/Tokyo');

    expect(snapshot).toMatchObject({
      local_date: '2026-02-28',
      local_time: '23:59:59',
      display_label: '2026-02-28 23:59 (Asia/Tokyo)',
    });
  });

  it('includes calendar and map render theme in world snapshots', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T03:04:05Z'));

    const { engine } = createTestWorld();
    const snapshot = engine.getSnapshot();

    expect(snapshot.calendar).toEqual({
      timezone: 'Asia/Tokyo',
      local_date: '2026-06-15',
      local_time: '12:04:05',
      display_label: '2026-06-15 12:04 (Asia/Tokyo)',
    });
    expect(snapshot.map_render_theme).toEqual(getMapRenderTheme());
  });

  it('includes avatar url, conversation id, and status emoji in agent snapshots', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T03:04:05Z'));

    const registration = createRegistration({
      discord_bot_avatar_url: 'https://example.com/avatar/bot-alice.png',
      items: [{ item_id: 'gear-oil', quantity: 1 }],
    });
    const { engine } = createTestWorld({
      config: {
        items: [
          {
            item_id: 'gear-oil',
            name: 'Gear Oil',
            description: 'Keeps gears moving smoothly.',
            type: 'general',
            stackable: true,
          },
        ],
      },
      engineOptions: {
        initialRegistrations: [registration],
      },
    });

    await engine.loginAgent(registration.agent_id);

    expect(engine.getSnapshot().agents[0]).toMatchObject({
      agent_id: registration.agent_id,
      discord_bot_avatar_url: registration.discord_bot_avatar_url,
      status_emoji: '',
    });

    engine.state.setState(registration.agent_id, 'moving');
    engine.timerManager.create({
      type: 'movement',
      agent_ids: [registration.agent_id],
      agent_id: registration.agent_id,
      from_node_id: '3-1',
      to_node_id: '3-2',
      path: ['3-1', '3-2'],
      fires_at: Date.now() + 60_000,
    });
    expect(engine.getSnapshot().agents[0]?.status_emoji).toBe('🚶');

    engine.timerManager.cancelByAgent(registration.agent_id);
    engine.state.setState(registration.agent_id, 'in_action');
    engine.timerManager.create({
      type: 'action',
      agent_ids: [registration.agent_id],
      agent_id: registration.agent_id,
      action_id: 'polish-gears',
      action_name: 'Gears polishing',
      duration_ms: 1_500,
      fires_at: Date.now() + 60_000,
    });
    expect(engine.getSnapshot().agents[0]).toMatchObject({
      status_emoji: '⚙️',
      current_activity: {
        type: 'action',
        action_id: 'polish-gears',
      },
    });

    engine.timerManager.cancelByAgent(registration.agent_id);
    engine.timerManager.create({
      type: 'wait',
      agent_ids: [registration.agent_id],
      agent_id: registration.agent_id,
      duration_ms: 600_000,
      fires_at: Date.now() + 60_000,
    });
    expect(engine.getSnapshot().agents[0]?.status_emoji).toBe('💤');

    engine.timerManager.cancelByAgent(registration.agent_id);
    engine.timerManager.create({
      type: 'item_use',
      agent_ids: [registration.agent_id],
      agent_id: registration.agent_id,
      item_id: 'gear-oil',
      item_name: 'Gear Oil',
      item_type: 'general',
      fires_at: Date.now() + 60_000,
    });
    expect(engine.getSnapshot().agents[0]).toMatchObject({
      status_emoji: '🧰',
      current_activity: {
        type: 'item_use',
        item_id: 'gear-oil',
      },
    });

    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(bob.agent_id);
    engine.timerManager.cancelByAgent(registration.agent_id);
    engine.state.setState(registration.agent_id, 'idle');
    engine.state.setNode(registration.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');
    const started = engine.startConversation(registration.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    expect(engine.getSnapshot().agents[0]).toMatchObject({
      status_emoji: '💬',
      current_conversation_id: started.conversation_id,
    });
  });

  it('suppresses current_conversation_id for deferred joiners until participation is applied', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T03:04:05Z'));

    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    const carol = await engine.registerAgent({ discord_bot_id: 'bot-carol' });

    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await engine.loginAgent(carol.agent_id);

    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');
    engine.state.setNode(carol.agent_id, '3-2');

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    vi.advanceTimersByTime(500);

    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
    });

    const pendingJoinerSnapshot = engine.getSnapshot();
    expect(pendingJoinerSnapshot.agents.find((agent) => agent.agent_id === carol.agent_id)).toMatchObject({
      agent_id: carol.agent_id,
      state: 'in_conversation',
      status_emoji: '💬',
    });
    expect(
      pendingJoinerSnapshot.agents.find((agent) => agent.agent_id === carol.agent_id)?.current_conversation_id,
    ).toBeUndefined();

    engine.speak(alice.agent_id, {
      message: 'Bob, over to you.',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);

    const appliedJoinerSnapshot = engine.getSnapshot();
    expect(appliedJoinerSnapshot.conversations[0]?.participant_agent_ids).toContain(carol.agent_id);
    expect(appliedJoinerSnapshot.agents.find((agent) => agent.agent_id === carol.agent_id)).toMatchObject({
      agent_id: carol.agent_id,
      current_conversation_id: started.conversation_id,
    });
  });
});
