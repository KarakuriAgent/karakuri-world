import { describe, expect, expectTypeOf, it } from 'vitest';

import { buildSpectatorSnapshot, toSpectatorMapSnapshot } from '../src/contracts/spectator-snapshot.js';
import type { WorldSnapshot } from '../src/contracts/world-snapshot.js';

function createWorldSnapshot(): WorldSnapshot<
  {
    agent_id: string;
    agent_name: string;
    node_id: '1-1' | '1-2';
    state: 'idle' | 'in_action';
    discord_channel_id: string;
    money: number;
    items: Array<{ item_id: string }>;
    status_emoji: string;
    discord_bot_avatar_url?: string;
    current_conversation_id?: string;
    current_activity?:
      | {
          type: 'action';
          action_id: string;
          action_name: string;
          duration_ms: number;
          completes_at: number;
        }
      | {
          type: 'wait';
          duration_ms: number;
          completes_at: number;
        }
      | {
          type: 'item_use';
          item_id: string;
          item_name: string;
          completes_at: number;
          duration_ms?: number;
        };
  },
  {
    conversation_id: string;
    status: 'active';
    participant_agent_ids: string[];
    current_speaker_agent_id: string;
    current_turn: number;
    initiator_agent_id: string;
  },
  {
    server_event_id: string;
    description: string;
    delivered_agent_ids: string[];
    pending_agent_ids: string[];
    admin_secret: string;
  }
> {
  return {
    world: {
      name: 'Karakuri World',
      description: 'Spectator contract test fixture',
      skill_name: 'ignored-by-public-contract',
    },
    timezone: 'ignored-top-level-timezone',
    calendar: {
      timezone: 'Asia/Tokyo',
      local_date: '2026-06-15',
      local_time: '12:04:05',
      display_label: '2026-06-15 12:04 (Asia/Tokyo)',
    },
    map: {
      rows: 2,
      cols: 2,
      nodes: {
        '1-1': {
          type: 'normal',
          label: 'Square',
          internal_note: 'dropped',
        },
        '1-2': {
          type: 'building_interior',
          building_id: 'workshop',
        },
      },
      buildings: [
        {
          building_id: 'workshop',
          name: 'Workshop',
          description: 'A place to craft things',
          wall_nodes: ['1-1'],
          interior_nodes: ['1-2'],
          door_nodes: ['2-2'],
          actions: [{ action_id: 'craft', name: 'Craft', emoji: '🛠️' }],
        },
      ],
      npcs: [
        {
          npc_id: 'gatekeeper',
          name: 'Gatekeeper',
          description: 'Watches the gate',
          node_id: '2-1',
          actions: [{ action_id: 'talk', name: 'Talk' }],
        },
      ],
    },
    map_render_theme: {
      cell_size: 96,
      label_font_size: 14,
      node_id_font_size: 12,
      background_fill: '#e2e8f0',
      grid_stroke: '#94a3b8',
      default_node_fill: '#bbf7d0',
      normal_node_fill: '#f8fafc',
      wall_node_fill: '#334155',
      door_node_fill: '#b45309',
      npc_node_fill: '#fde68a',
      building_palette: ['#dbeafe'],
      wall_text_color: '#f8fafc',
      default_text_color: '#0f172a',
    },
    weather: {
      condition: '晴れ',
      temperature_celsius: 22,
    },
    agents: [
      {
        agent_id: 'alice',
        agent_name: 'Alice',
        node_id: '1-2',
        state: 'in_action',
        discord_channel_id: 'discord-channel-1',
        money: 500,
        items: [{ item_id: 'tea' }],
        status_emoji: '🛠️',
        discord_bot_avatar_url: 'https://example.com/alice.png',
        current_activity: {
          type: 'action',
          action_id: 'craft',
          action_name: 'Craft',
          duration_ms: 30_000,
          completes_at: 1_750_000_030_000,
        },
      },
      ],
    conversations: [
      {
        conversation_id: 'conv-1',
        status: 'active',
        participant_agent_ids: ['alice', 'bob'],
        current_speaker_agent_id: 'alice',
        current_turn: 2,
        initiator_agent_id: 'alice',
      },
    ],
    server_events: [
      {
        server_event_id: 'event-1',
        description: 'Harvest Festival',
        delivered_agent_ids: ['alice'],
        pending_agent_ids: ['bob'],
        admin_secret: 'drop-me',
      },
    ],
    recent_server_events: [],
    generated_at: 1_750_000_000_000,
  };
}

describe('spectator snapshot contract helpers', () => {
  it('projects the public map contract without private action config', () => {
    const projected = toSpectatorMapSnapshot(createWorldSnapshot().map);

    expect(projected).toEqual({
      rows: 2,
      cols: 2,
      nodes: {
        '1-1': {
          type: 'normal',
          label: 'Square',
        },
        '1-2': {
          type: 'building_interior',
          building_id: 'workshop',
        },
        '2-1': {
          type: 'normal',
        },
        '2-2': {
          type: 'normal',
        },
      },
      buildings: [
        {
          building_id: 'workshop',
          name: 'Workshop',
          description: 'A place to craft things',
          wall_nodes: ['1-1'],
          interior_nodes: ['1-2'],
          door_nodes: ['2-2'],
        },
      ],
      npcs: [
        {
          npc_id: 'gatekeeper',
          name: 'Gatekeeper',
          description: 'Watches the gate',
          node_id: '2-1',
        },
      ],
    });
  });

  it('expands sparse world snapshot nodes into a full grid', () => {
    const projected = toSpectatorMapSnapshot(createWorldSnapshot().map);

    expect(Object.keys(projected.nodes).sort()).toEqual(['1-1', '1-2', '2-1', '2-2']);
    expect(projected.nodes['2-1']).toEqual({ type: 'normal' });
    expect(projected.nodes['2-2']).toEqual({ type: 'normal' });
  });

  it('builds a schema_version=1 spectator snapshot with timezone duplication and publish metadata', () => {
    const spectatorSnapshot = buildSpectatorSnapshot({
      world_snapshot: createWorldSnapshot(),
      recent_server_events: [
        {
          server_event_id: 'event-1',
          description: 'Harvest Festival',
          occurred_at: 1_750_000_000_100,
          is_active: true,
        },
      ],
      published_at: 1_750_000_005_000,
      last_publish_error_at: 1_750_000_004_500,
    });

    expect(spectatorSnapshot).toMatchObject({
      schema_version: 1,
      world: {
        name: 'Karakuri World',
        description: 'Spectator contract test fixture',
      },
      timezone: 'Asia/Tokyo',
      calendar: {
        timezone: 'Asia/Tokyo',
        display_label: '2026-06-15 12:04 (Asia/Tokyo)',
      },
      map_render_theme: {
        background_fill: '#e2e8f0',
      },
      agents: [
        {
          agent_id: 'alice',
          status_emoji: '🛠️',
          discord_bot_avatar_url: 'https://example.com/alice.png',
          current_activity: {
            type: 'action',
            label: 'Craft',
            emoji: '🛠️',
          },
        },
      ],
      conversations: [
        {
          conversation_id: 'conv-1',
          status: 'active',
          participant_agent_ids: ['alice', 'bob'],
          current_speaker_agent_id: 'alice',
          current_turn: 2,
        },
      ],
      server_events: [
        {
          server_event_id: 'event-1',
          description: 'Harvest Festival',
          delivered_agent_ids: ['alice'],
          pending_agent_ids: ['bob'],
        },
      ],
      generated_at: 1_750_000_000_000,
      published_at: 1_750_000_005_000,
      last_publish_error_at: 1_750_000_004_500,
      recent_server_events: [
        {
          server_event_id: 'event-1',
          is_active: true,
        },
      ],
    });

    expectTypeOf(spectatorSnapshot.schema_version).toEqualTypeOf<1>();
    type ItemUseActivity = Extract<NonNullable<(typeof spectatorSnapshot.agents)[number]['current_activity']>, { type: 'item_use' }>;
    expectTypeOf<ItemUseActivity>().toMatchTypeOf<{
      duration_ms?: number;
    }>();
    expect(spectatorSnapshot.agents[0]).not.toHaveProperty('discord_channel_id');
    expect(spectatorSnapshot.agents[0]).not.toHaveProperty('money');
    expect(spectatorSnapshot.agents[0]).not.toHaveProperty('items');
    expect(spectatorSnapshot.conversations[0]).not.toHaveProperty('initiator_agent_id');
    expect(spectatorSnapshot.server_events[0]).not.toHaveProperty('admin_secret');
  });

  it('derives current_activity labels for wait and item_use activities', () => {
    const waitSnapshot = buildSpectatorSnapshot({
      world_snapshot: {
        ...createWorldSnapshot(),
        agents: [
          {
            agent_id: 'alice',
            agent_name: 'Alice',
            node_id: '1-1',
            state: 'in_action',
            discord_channel_id: 'discord-channel-1',
            money: 500,
            items: [],
            status_emoji: '💤',
            current_activity: {
              type: 'wait',
              duration_ms: 60_000,
              completes_at: 1_750_000_060_000,
            },
          },
        ],
      },
      recent_server_events: [],
      published_at: 1_750_000_005_000,
    });

    expect(waitSnapshot.agents[0]?.current_activity).toEqual({
      type: 'wait',
      label: '待機',
      emoji: '💤',
      duration_ms: 60_000,
      completes_at: 1_750_000_060_000,
    });

    const itemUseSnapshot = buildSpectatorSnapshot({
      world_snapshot: {
        ...createWorldSnapshot(),
        agents: [
          {
            agent_id: 'alice',
            agent_name: 'Alice',
            node_id: '1-1',
            state: 'in_action',
            discord_channel_id: 'discord-channel-1',
            money: 500,
            items: [],
            status_emoji: '🧰',
            current_activity: {
              type: 'item_use',
              item_id: 'tea',
              item_name: 'Tea',
              completes_at: 1_750_000_010_000,
            },
          },
        ],
      },
      recent_server_events: [],
      published_at: 1_750_000_005_000,
    });

    expect(itemUseSnapshot.agents[0]?.current_activity).toEqual({
      type: 'item_use',
      label: 'Tea',
      emoji: '🧰',
      completes_at: 1_750_000_010_000,
    });
  });

  it('rejects unreasonable map sizes before building a dense spectator grid', () => {
    expect(() =>
      toSpectatorMapSnapshot({
        ...createWorldSnapshot().map,
        rows: 101,
        cols: 100,
        nodes: {},
      }),
    ).toThrow(/map must contain <= 10000 cells/);
  });
});
