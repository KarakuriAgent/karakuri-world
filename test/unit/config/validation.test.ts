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

  it('rejects invalid door topology', () => {
    const invalidMap = createTestMapConfig();
    invalidMap.buildings[0].door_nodes = ['1-1'];
    invalidMap.nodes['1-1'] = { type: 'door' };

    expect(() => parseConfig(createTestConfig({ map: invalidMap }))).toThrowError(ConfigValidationError);
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
});
