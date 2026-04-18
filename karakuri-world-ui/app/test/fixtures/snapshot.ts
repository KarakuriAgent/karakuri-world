import type { SpectatorSnapshot } from '../../../worker/src/contracts/spectator-snapshot.js';

export function createFixtureSnapshot(): SpectatorSnapshot {
  return {
    schema_version: 1,
    world: {
      name: 'Karakuri World',
      description: 'Fixture spectator snapshot',
    },
    timezone: 'Asia/Tokyo',
    calendar: {
      timezone: 'Asia/Tokyo',
      local_date: '2026-06-20',
      local_time: '18:30:00',
      display_label: '2026-06-20 18:30 (Asia/Tokyo)',
    },
    map: {
      rows: 2,
      cols: 2,
      nodes: {
        '1-1': { type: 'normal', label: 'Square' },
        '1-2': { type: 'building_interior', building_id: 'atelier' },
        '2-1': { type: 'normal', npc_id: 'keeper' },
        '2-2': { type: 'normal' },
      },
      buildings: [
        {
          building_id: 'atelier',
          name: 'Atelier',
          description: 'Creative workshop',
          wall_nodes: ['1-1'],
          interior_nodes: ['1-2'],
          door_nodes: ['2-2'],
        },
      ],
      npcs: [
        {
          npc_id: 'keeper',
          name: 'Keeper',
          description: 'Watches the gate',
          node_id: '2-1',
        },
      ],
    },
    map_render_theme: {
      cell_size: 96,
      label_font_size: 14,
      node_id_font_size: 12,
      background_fill: '#0f172a',
      grid_stroke: '#334155',
      default_node_fill: '#1e293b',
      normal_node_fill: '#0f172a',
      wall_node_fill: '#475569',
      door_node_fill: '#22d3ee',
      npc_node_fill: '#f59e0b',
      building_palette: ['#0ea5e9'],
      wall_text_color: '#f8fafc',
      default_text_color: '#e2e8f0',
    },
    weather: {
      condition: '晴れ',
      temperature_celsius: 24,
    },
    agents: [
      {
        agent_id: 'alice',
        agent_name: 'Alice',
        node_id: '1-2',
        state: 'in_action',
        status_emoji: '🛠️',
        discord_bot_avatar_url: 'https://example.com/alice.png',
        current_activity: {
          type: 'action',
          label: 'Craft',
          emoji: '🛠️',
          duration_ms: 300000,
          completes_at: 1_780_000_000_000,
        },
      },
      {
        agent_id: 'bob',
        agent_name: 'Bob',
        node_id: '2-1',
        state: 'idle',
        status_emoji: '💤',
      },
    ],
    conversations: [
      {
        conversation_id: 'conv-1',
        status: 'active',
        participant_agent_ids: ['alice', 'bob'],
        current_speaker_agent_id: 'alice',
        current_turn: 3,
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
    recent_server_events: [
      {
        server_event_id: 'event-1',
        description: 'Harvest Festival',
        occurred_at: 1_780_000_000_000,
        is_active: true,
      },
    ],
    generated_at: 1_780_000_000_000,
    published_at: 1_780_000_005_000,
  };
}
