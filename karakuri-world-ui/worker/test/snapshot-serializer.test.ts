import { describe, expect, it } from 'vitest';

import { buildSpectatorSnapshot } from '../src/contracts/spectator-snapshot.js';
import type { WorldSnapshot } from '../src/contracts/world-snapshot.js';
import { decodeSpectatorSnapshot, encodeSpectatorSnapshot } from '../src/contracts/snapshot-serializer.js';

const worldSnapshot: WorldSnapshot = {
  world: {
    name: 'Karakuri World',
    description: 'serializer fixture',
  },
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
      },
    },
    buildings: [],
    npcs: [],
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
  conversations: [],
  server_events: [],
  generated_at: 1_750_000_000_000,
};

describe('spectator snapshot serializer', () => {
  it('round-trips schema_version=1 snapshots', () => {
    const snapshot = buildSpectatorSnapshot({
      world_snapshot: worldSnapshot,
      recent_server_events: [],
      published_at: 1_750_000_005_000,
    });

    expect(snapshot.map.nodes).toEqual({
      '1-1': { type: 'normal' },
      '1-2': { type: 'normal' },
      '2-1': { type: 'normal' },
      '2-2': { type: 'normal' },
    });
    expect(snapshot.agents[0]?.current_activity).toEqual({
      type: 'item_use',
      label: 'Tea',
      emoji: '🧰',
      completes_at: 1_750_000_010_000,
    });
    expect(decodeSpectatorSnapshot(encodeSpectatorSnapshot(snapshot))).toEqual(snapshot);
  });

  it('rejects incompatible schema versions during decode', () => {
    const encoded = JSON.stringify({
      ...buildSpectatorSnapshot({
        world_snapshot: worldSnapshot,
        recent_server_events: [],
        published_at: 1_750_000_005_000,
      }),
      schema_version: 2,
    });

    expect(() => decodeSpectatorSnapshot(encoded)).toThrow(/Invalid literal value/);
  });

  it('rejects snapshots whose duplicated timezone disagrees with calendar.timezone', () => {
    const encoded = JSON.stringify({
      ...buildSpectatorSnapshot({
        world_snapshot: worldSnapshot,
        recent_server_events: [],
        published_at: 1_750_000_005_000,
      }),
      timezone: 'UTC',
    });

    expect(() => decodeSpectatorSnapshot(encoded)).toThrow(/timezone must match calendar\.timezone/);
  });

  it('rejects sparse map snapshots during decode', () => {
    const encoded = JSON.stringify({
      ...buildSpectatorSnapshot({
        world_snapshot: worldSnapshot,
        recent_server_events: [],
        published_at: 1_750_000_005_000,
      }),
      map: {
        rows: 2,
        cols: 2,
        nodes: {
          '1-1': { type: 'normal' },
        },
        buildings: [],
        npcs: [],
      },
    });

    expect(() => decodeSpectatorSnapshot(encoded)).toThrow(/map\.nodes must include grid node 1-2/);
  });

  it('rejects out-of-grid map nodes during decode', () => {
    const encoded = JSON.stringify({
      ...buildSpectatorSnapshot({
        world_snapshot: worldSnapshot,
        recent_server_events: [],
        published_at: 1_750_000_005_000,
      }),
      map: {
        rows: 2,
        cols: 2,
        nodes: {
          '1-1': { type: 'normal' },
          '1-2': { type: 'normal' },
          '2-1': { type: 'normal' },
          '2-2': { type: 'normal' },
          '3-1': { type: 'normal' },
        },
        buildings: [],
        npcs: [],
      },
    });

    expect(() => decodeSpectatorSnapshot(encoded)).toThrow(/map\.nodes contains out-of-grid node 3-1/);
  });

  it('rejects unreasonable row counts before full-grid validation', () => {
    const encoded = JSON.stringify({
      ...buildSpectatorSnapshot({
        world_snapshot: worldSnapshot,
        recent_server_events: [],
        published_at: 1_750_000_005_000,
      }),
      map: {
        rows: 201,
        cols: 1,
        nodes: {},
        buildings: [],
        npcs: [],
      },
    });

    expect(() => decodeSpectatorSnapshot(encoded)).toThrow(/map\.rows must be <= 200/);
  });

  it('rejects unreasonable total cell counts before full-grid validation', () => {
    const encoded = JSON.stringify({
      ...buildSpectatorSnapshot({
        world_snapshot: worldSnapshot,
        recent_server_events: [],
        published_at: 1_750_000_005_000,
      }),
      map: {
        rows: 101,
        cols: 100,
        nodes: {},
        buildings: [],
        npcs: [],
      },
    });

    expect(() => decodeSpectatorSnapshot(encoded)).toThrow(/map must contain <= 10000 cells/);
  });
});
