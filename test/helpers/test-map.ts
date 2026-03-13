import type { MapConfig, ServerConfig } from '../../src/types/data-model.js';

export function createTestMapConfig(): MapConfig {
  return {
    rows: 3,
    cols: 5,
    nodes: {
      '1-2': { type: 'npc', label: 'Gatekeeper', npc_id: 'npc-gatekeeper' },
      '1-3': { type: 'wall' },
      '1-4': { type: 'wall' },
      '1-5': { type: 'wall' },
      '2-3': { type: 'wall' },
      '2-4': { type: 'building_interior', label: 'Workshop Interior', building_id: 'building-workshop' },
      '2-5': { type: 'wall' },
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
            result_description: 'The workshop gleams with fresh polish.',
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
            result_description: 'The gatekeeper returns the greeting with a nod.',
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
    server_events: [
      {
        event_id: 'sudden-rain',
        name: 'Sudden Rain',
        description: 'Dark clouds gather and rain starts to pour.',
        timeout_ms: 5000,
        choices: [
          {
            choice_id: 'take-shelter',
            label: 'Take shelter',
            description: 'Rush toward the nearest roof.',
          },
          {
            choice_id: 'observe-rain',
            label: 'Observe the rain',
            description: 'Stay put and study the weather.',
          },
        ],
      },
    ],
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
    server_events: overrides.server_events ?? config.server_events,
  };
}
