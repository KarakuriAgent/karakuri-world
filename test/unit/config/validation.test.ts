import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../../src/config/index.js';
import { ConfigValidationError } from '../../../src/config/validation.js';
import { createTestConfig, createTestMapConfig } from '../../helpers/test-map.js';

describe('config validation', () => {
  it('accepts a valid config', () => {
    expect(() => parseConfig(createTestConfig())).not.toThrow();
  });

  it('rejects non-passable spawn nodes', () => {
    const invalidConfig = createTestConfig({
      spawn: {
        nodes: ['1-3'],
      },
    });

    expect(() => parseConfig(invalidConfig)).toThrowError(ConfigValidationError);
  });

  it('rejects duplicated action ids', () => {
    const invalidMap = createTestMapConfig();
    invalidMap.npcs[0].actions[0].action_id = 'polish-gears';

    expect(() => parseConfig(createTestConfig({ map: invalidMap }))).toThrowError(ConfigValidationError);
  });

  it('rejects wall nodes without building_id', () => {
    const invalidMap = createTestMapConfig();
    const wallNode = invalidMap.nodes['1-3'];
    if (!wallNode) {
      throw new Error('Expected test wall node to exist.');
    }
    delete wallNode.building_id;

    expect(() => parseConfig(createTestConfig({ map: invalidMap }))).toThrowError(ConfigValidationError);
  });

  it('rejects invalid door topology', () => {
    const invalidMap = createTestMapConfig();
    invalidMap.buildings[0].door_nodes = ['1-1'];
    invalidMap.nodes['1-1'] = { type: 'door', building_id: 'building-workshop' };

    try {
      parseConfig(createTestConfig({ map: invalidMap }));
      expect.unreachable('Expected invalid door topology to throw.');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      if (error instanceof ConfigValidationError) {
        expect(error.issues).toEqual(
          expect.arrayContaining([
            {
              path: 'map.buildings[0].door_nodes[0]',
              message: 'Door node must connect at least one interior node and one exterior normal node.',
            },
          ]),
        );
      }
    }
  });

  it('rejects duplicated server event ids', () => {
    const baseConfig = createTestConfig();
    const invalidConfig = createTestConfig({
      server_events: [
        ...baseConfig.server_events,
        {
          event_id: 'sudden-rain',
          name: 'Another rain',
          description: 'Duplicate id should fail.',
          timeout_ms: 5000,
          choices: [
            {
              choice_id: 'wait',
              label: 'Wait',
              description: 'Do nothing.',
            },
          ],
        },
      ],
    });

    expect(() => parseConfig(invalidConfig)).toThrowError(ConfigValidationError);
  });

  it('rejects duplicated building ids', () => {
    const baseConfig = createTestConfig();
    const invalidConfig = createTestConfig({
      map: {
        ...baseConfig.map,
        buildings: [
          ...baseConfig.map.buildings,
          {
            building_id: 'building-workshop',
            name: 'Duplicate Workshop',
            description: 'Should fail because building_id is duplicated.',
            wall_nodes: ['3-5'],
            interior_nodes: ['3-4'],
            door_nodes: ['3-3'],
            actions: [],
          },
        ],
        nodes: {
          ...baseConfig.map.nodes,
          '3-3': { type: 'door', building_id: 'building-workshop' },
          '3-4': { type: 'building_interior', building_id: 'building-workshop' },
          '3-5': { type: 'wall', building_id: 'building-workshop' },
        },
      },
    });

    expect(() => parseConfig(invalidConfig)).toThrowError(ConfigValidationError);
  });
});
