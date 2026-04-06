import type { MapConfig, ServerConfig } from '../../src/types/data-model.js';

export function createTestMapConfig(): MapConfig {
  return {
    rows: 3,
    cols: 5,
    nodes: {
      '1-2': { type: 'npc', label: 'Gatekeeper', npc_id: 'npc-gatekeeper' },
      '1-3': { type: 'wall', building_id: 'building-workshop' },
      '1-4': { type: 'wall', building_id: 'building-workshop' },
      '1-5': { type: 'wall', building_id: 'building-workshop' },
      '2-3': { type: 'wall', building_id: 'building-workshop' },
      '2-4': { type: 'building_interior', label: 'Workshop Interior', building_id: 'building-workshop' },
      '2-5': { type: 'wall', building_id: 'building-workshop' },
      '3-4': { type: 'door', label: 'Workshop Door', building_id: 'building-workshop' },
    },
    buildings: [
      {
        building_id: 'building-workshop',
        name: 'Clockwork Workshop',
        description: 'A small workshop filled with gears and steam.',
        wall_nodes: ['1-3', '1-4', '1-5', '2-3', '2-5'],
        interior_nodes: ['2-4'],
        door_nodes: ['3-4'],
        actions: [
          {
            action_id: 'polish-gears',
            name: 'Gears polishing',
            description: 'Carefully polish the workshop gears.',
            duration_ms: 1500,
          },
        ],
      },
    ],
    npcs: [
      {
        npc_id: 'npc-gatekeeper',
        name: 'Gatekeeper',
        description: 'Watches the town gate with a calm expression.',
        node_id: '1-2',
        actions: [
          {
            action_id: 'greet-gatekeeper',
            name: 'Greet the gatekeeper',
            description: 'Offer a respectful greeting.',
            duration_ms: 1200,
          },
        ],
      },
    ],
  };
}

export function createTestConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const base: ServerConfig = {
    world: {
      name: 'Karakuri Test World',
      description: 'A compact map used by automated tests.',
      skill_name: 'test-skill',
    },
    timezone: 'Asia/Tokyo',
    movement: {
      duration_ms: 1000,
    },
    conversation: {
      max_turns: 10,
      interval_ms: 500,
      accept_timeout_ms: 3000,
      turn_timeout_ms: 4000,
    },
    perception: {
      range: 3,
    },
    spawn: {
      nodes: ['3-1', '3-2'],
    },
    map: createTestMapConfig(),
  };

  const config = structuredClone(base);
  return {
    ...config,
    ...overrides,
    world: { ...config.world, ...overrides.world },
    movement: { ...config.movement, ...overrides.movement },
    conversation: { ...config.conversation, ...overrides.conversation },
    perception: { ...config.perception, ...overrides.perception },
    spawn: { ...config.spawn, ...overrides.spawn },
    map: overrides.map ?? config.map,
    economy: overrides.economy ?? config.economy,
    weather: overrides.weather ?? config.weather,
    items: overrides.items ?? config.items,
    idle_reminder: overrides.idle_reminder === undefined ? config.idle_reminder : overrides.idle_reminder,
  };
}
