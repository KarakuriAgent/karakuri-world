import { describe, expect, it } from 'vitest';

import { validateConfig } from '../../../src/config/index.js';
import { createTestConfig } from '../../helpers/test-map.js';

describe('validateConfig', () => {
  it('returns success for a valid config', () => {
    const result = validateConfig(createTestConfig());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.config.world.name).toBe('Karakuri Test World');
    }
  });

  it('normalizes Zod issues with bracket notation paths', () => {
    const invalidConfig = createTestConfig() as unknown as {
      map: {
        buildings: Array<{
          actions: Array<{
            description: unknown;
          }>;
        }>;
      };
    };
    invalidConfig.map.buildings[0].actions[0].description = 123;

    const result = validateConfig(invalidConfig);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'map.buildings[0].actions[0].description',
          }),
        ]),
      );
    }
  });

  it('returns logical validation issues for semantic config errors', () => {
    const invalidConfig = createTestConfig();
    const wallNode = invalidConfig.map.nodes['1-3'];
    if (!wallNode) {
      throw new Error('Expected test wall node to exist.');
    }
    delete wallNode.building_id;

    const result = validateConfig(invalidConfig);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          {
            path: 'map.nodes.1-3.building_id',
            message: 'Node type "wall" must define building_id.',
          },
        ]),
      );
    }
  });

  it('rejects NPC nodes that reference unknown buildings', () => {
    const invalidConfig = createTestConfig();
    const npcNode = invalidConfig.map.nodes['1-2'];
    if (!npcNode || npcNode.type !== 'npc') {
      throw new Error('Expected test NPC node to exist.');
    }
    npcNode.building_id = 'missing-building';

    const result = validateConfig(invalidConfig);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          {
            path: 'map.nodes.1-2.building_id',
            message: 'Node references unknown building "missing-building".',
          },
        ]),
      );
    }
  });
});
