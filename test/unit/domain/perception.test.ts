import { describe, expect, it } from 'vitest';

import { buildPerceptionData, buildPerceptionText } from '../../../src/domain/perception.js';
import type { LoggedInAgent } from '../../../src/types/agent.js';
import { createTestMapConfig } from '../../helpers/test-map.js';

const loggedInAgents: LoggedInAgent[] = [
  {
    agent_id: 'agent-alice',
    agent_name: 'Alice',
    agent_label: 'Alice',
    node_id: '2-1',
    state: 'idle',
    discord_channel_id: 'channel-alice',
    pending_conversation_id: null,
    pending_server_event_ids: [],
    last_action_id: null,
  },
  {
    agent_id: 'agent-bob',
    agent_name: 'Bob',
    agent_label: 'Bob',
    node_id: '3-2',
    state: 'idle',
    discord_channel_id: 'channel-bob',
    pending_conversation_id: null,
    pending_server_event_ids: [],
    last_action_id: null,
  },
];

describe('perception', () => {
  it('builds structured perception data', () => {
    const data = buildPerceptionData(loggedInAgents[0], loggedInAgents, createTestMapConfig(), 3);

    expect(data.current_node.node_id).toBe('2-1');
    expect(data.agents).toEqual([
      {
        agent_id: 'agent-bob',
        agent_name: 'Bob',
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

  it('builds readable perception text', () => {
    const data = buildPerceptionData(loggedInAgents[0], loggedInAgents, createTestMapConfig(), 3);
    const text = buildPerceptionText(data);

    expect(text).toContain('現在地: 2-1');
    expect(text).toContain('Bob@3-2');
    expect(text).toContain('Gatekeeper@1-2');
    expect(text).toContain('Clockwork Workshop');
  });
});
