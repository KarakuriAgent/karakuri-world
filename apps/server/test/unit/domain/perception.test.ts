import { describe, expect, it } from 'vitest';

import { buildPerceptionData, buildPerceptionText } from '../../../src/domain/perception.js';
import type { LoggedInAgent } from '../../../src/types/agent.js';
import { createTestMapConfig } from '../../helpers/test-map.js';

const loggedInAgents: LoggedInAgent[] = [
  {
    agent_id: 'agent-alice',
    agent_name: 'alice',
    node_id: '2-1',
    state: 'idle',
    discord_channel_id: 'channel-alice',
    pending_conversation_id: null,
    current_conversation_id: null,
    active_transfer_id: null,
    pending_transfer_id: null,
    pending_server_event_ids: [],
    active_server_event_id: null,
    last_action_id: null,
    last_rejected_action_id: null,
    last_used_item_id: null,
    money: 1000,
    items: [],
  },
  {
    agent_id: 'agent-bob',
    agent_name: 'bob',
    node_id: '3-2',
    state: 'idle',
    discord_channel_id: 'channel-bob',
    pending_conversation_id: null,
    current_conversation_id: null,
    active_transfer_id: null,
    pending_transfer_id: null,
    pending_server_event_ids: [],
    active_server_event_id: null,
    last_action_id: null,
    last_rejected_action_id: null,
    last_used_item_id: null,
    money: 500,
    items: [],
  },
];

describe('perception', () => {
  it('builds structured perception data', async () => {
    const data = buildPerceptionData(loggedInAgents[0], loggedInAgents, createTestMapConfig(), 3, {
      timezone: 'Asia/Tokyo',
      now: new Date('2026-01-01T00:00:00Z'),
      itemConfigs: [],
    });

    expect(data.current_node.node_id).toBe('2-1');
    expect(data.agents).toEqual([
      {
        agent_id: 'agent-bob',
        agent_name: 'bob',
        node_id: '3-2',
      },
    ]);
    expect(data.npcs).toEqual([
      {
        npc_id: 'npc-gatekeeper',
        name: 'Gatekeeper',
        node_id: '1-2',
      },
    ]);
    expect(data.buildings).toEqual([
      {
        building_id: 'building-workshop',
        name: 'Clockwork Workshop',
        door_nodes: ['3-4'],
      },
    ]);
  });

  it('builds readable perception text', async () => {
    const data = buildPerceptionData(loggedInAgents[0], loggedInAgents, createTestMapConfig(), 3, {
      timezone: 'Asia/Tokyo',
      now: new Date('2026-01-01T00:00:00Z'),
      itemConfigs: [],
    });
    const text = buildPerceptionText(data);

    expect(text).toContain('現在時刻: 2026-01-01 09:00 (Asia/Tokyo)');
    expect(text).toContain('現在地: 2-1');
    expect(text).toContain('近くのノード:');
    expect(text).toContain('bob@3-2');
    expect(text).toContain('Gatekeeper@1-2');
    expect(text).toContain('Clockwork Workshop');
    expect(text).toContain('所持金: 1,000円');
  });
});
