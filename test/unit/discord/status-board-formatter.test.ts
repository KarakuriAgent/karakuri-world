import { describe, expect, it } from 'vitest';

import { formatStatusBoard } from '../../../src/discord/status-board-formatter.js';
import type { AgentSnapshot } from '../../../src/types/snapshot.js';
import type { WorldSnapshot } from '../../../src/types/snapshot.js';
import { createTestConfig } from '../../helpers/test-map.js';

function createAgentSnapshot(overrides: Partial<AgentSnapshot>): AgentSnapshot {
  return {
    agent_id: 'agent-1',
    agent_name: 'agent',
    node_id: '3-1',
    state: 'idle',
    discord_channel_id: 'channel',
    money: 0,
    items: [],
    ...overrides,
  };
}

function createSnapshot(): WorldSnapshot {
  const config = createTestConfig();
  return {
    world: config.world,
    map: config.map,
    agents: [
      createAgentSnapshot({
        agent_id: 'agent-1',
        agent_name: 'sakura',
        node_id: '3-4',
        state: 'idle',
        discord_channel_id: 'channel-1',
      }),
      createAgentSnapshot({
        agent_id: 'agent-2',
        agent_name: 'taro',
        node_id: '3-2',
        state: 'moving',
        discord_channel_id: 'channel-2',
        movement: {
          from_node_id: '3-1',
          to_node_id: '2-4',
          path: ['3-1', '3-2', '3-3', '2-3', '2-4'],
          arrives_at: Date.UTC(2026, 0, 1, 5, 31, 0),
        },
      }),
      createAgentSnapshot({
        agent_id: 'agent-3',
        agent_name: 'hana',
        node_id: '2-4',
        state: 'in_action',
        discord_channel_id: 'channel-3',
        current_activity: {
          type: 'action',
          action_id: 'brew-tea',
          action_name: 'お茶を淹れる',
          duration_ms: 300_000,
          completes_at: Date.UTC(2026, 0, 1, 5, 31, 0),
        },
      }),
    ],
    conversations: [
      {
        conversation_id: 'conversation-1',
        status: 'active',
        initiator_agent_id: 'agent-1',
        target_agent_id: 'agent-2',
        current_turn: 3,
        max_turns: 10,
        current_speaker_agent_id: 'agent-1',
      },
    ],
    server_events: [
      {
        server_event_id: 'server-event-1',
        description: '空が暗くなり雨が降り出した',
        delivered_agent_ids: ['agent-1'],
        pending_agent_ids: ['agent-2', 'agent-3'],
      },
    ],
    generated_at: Date.UTC(2026, 0, 1, 5, 30, 0),
  };
}

describe('formatStatusBoard', () => {
  it('formats world status sections', () => {
    const [message] = formatStatusBoard(createSnapshot(), 'Asia/Tokyo');

    expect(message).toContain('# Karakuri Test World');
    expect(message).toContain('## エージェント状況 (3名ログイン中)');
    expect(message).toContain('- **sakura** - 3-4 (Workshop Door) - 待機中');
    expect(message).toContain('- **taro** - 3-2 - 移動中 → 2-4 (Workshop Interior)');
    expect(message).toContain('- **hana** - 2-4 (Workshop Interior) - 行動中:「お茶を淹れる」');
    expect(message).toContain('## 進行中の会話 (1件)');
    expect(message).toContain('- sakura と taro (ターン 3/10, sakuraの番)');
    expect(message).not.toContain('サーバーイベント');
    expect(message).toContain('最終更新: 14:30');
  });

  it('formats empty sections gracefully', () => {
    const snapshot = createSnapshot();
    snapshot.agents = [];
    snapshot.conversations = [];
    snapshot.server_events = [];

    const [message] = formatStatusBoard(snapshot, 'Asia/Tokyo');

    expect(message).toContain('_ログイン中のエージェントはいません。_');
    expect(message).toContain('_進行中の会話はありません。_');
    expect(message).not.toContain('サーバーイベント');
  });

  it('clamps displayed turn progress while a conversation is closing', () => {
    const snapshot = createSnapshot();
    snapshot.conversations = [
      {
        conversation_id: 'conversation-1',
        status: 'closing',
        initiator_agent_id: 'agent-1',
        target_agent_id: 'agent-2',
        current_turn: 11,
        max_turns: 10,
        current_speaker_agent_id: 'agent-1',
      },
    ];

    const [message] = formatStatusBoard(snapshot, 'Asia/Tokyo');

    expect(message).toContain('- sakura と taro (ターン 10/10, sakuraの番, 終了処理中)');
    expect(message).not.toContain('ターン 11/10');
  });

  it('shows a moving agent without movement data using a plain fallback', () => {
    const snapshot = createSnapshot();
    snapshot.agents = [
      {
        ...createAgentSnapshot({
          agent_id: 'agent-1',
          agent_name: 'sakura',
          node_id: '3-2',
          state: 'moving',
          discord_channel_id: 'channel-1',
        }),
      },
    ];

    const [message] = formatStatusBoard(snapshot, 'Asia/Tokyo');

    expect(message).toContain('- **sakura** - 3-2 - 移動中');
    expect(message).not.toContain('→');
  });

  it('shows a waiting agent under in_action state', () => {
    const snapshot = createSnapshot();
    snapshot.agents = [
      createAgentSnapshot({
        agent_id: 'agent-1',
        agent_name: 'sakura',
        node_id: '3-2',
        state: 'in_action',
        discord_channel_id: 'channel-1',
        current_activity: {
          type: 'wait',
          duration_ms: 600_000,
          completes_at: Date.UTC(2026, 0, 1, 5, 40, 0),
        },
      }),
    ];

    const [message] = formatStatusBoard(snapshot, 'Asia/Tokyo');

    expect(message).toContain('- **sakura** - 3-2 - 待機中');
  });

  it('shows a plain fallback for in_action agent without current_activity', () => {
    const snapshot = createSnapshot();
    snapshot.agents = [
      createAgentSnapshot({
        agent_id: 'agent-1',
        agent_name: 'sakura',
        node_id: '3-2',
        state: 'in_action',
        discord_channel_id: 'channel-1',
      }),
    ];

    const [message] = formatStatusBoard(snapshot, 'Asia/Tokyo');

    expect(message).toContain('- **sakura** - 3-2 - 行動中');
    expect(message).not.toContain('行動中:');
  });

  it('excludes pending conversations from the display', () => {
    const snapshot = createSnapshot();
    snapshot.conversations = [
      {
        conversation_id: 'conversation-1',
        status: 'pending',
        initiator_agent_id: 'agent-1',
        target_agent_id: 'agent-2',
        current_turn: 1,
        max_turns: 10,
        current_speaker_agent_id: 'agent-1',
      },
    ];

    const [message] = formatStatusBoard(snapshot, 'Asia/Tokyo');

    expect(message).toContain('進行中の会話 (0件)');
    expect(message).toContain('_進行中の会話はありません。_');
  });

  it('splits oversized sections into multiple Discord-safe messages', () => {
    const snapshot = createSnapshot();
    snapshot.agents = Array.from({ length: 40 }, (_, index) =>
      createAgentSnapshot({
        agent_id: `agent-${index + 1}`,
        agent_name: `agent-${String(index + 1).padStart(2, '0')}`,
        node_id: '2-4',
        state: 'in_action',
        discord_channel_id: `channel-${index + 1}`,
        current_activity: {
          type: 'action',
          action_id: `action-${index + 1}`,
          action_name: `非常に長い行動名 ${index + 1} `.repeat(8).trim(),
          duration_ms: 300_000,
          completes_at: Date.UTC(2026, 0, 1, 5, 31, 0),
        },
      }),
    );

    const messages = formatStatusBoard(snapshot, 'Asia/Tokyo');

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(1900);
    }
  });
});
