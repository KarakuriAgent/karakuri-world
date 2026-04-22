import { describe, expect, it } from 'vitest';

import { buildMapSummaryText } from '../../../src/domain/map-summary.js';
import { createTestMapConfig } from '../../helpers/test-map.js';

describe('buildMapSummaryText', () => {
  it('formats buildings and NPCs from the map config', () => {
    const mapConfig = createTestMapConfig();
    const text = buildMapSummaryText(mapConfig);

    expect(text).toContain('マップ: 3行 × 5列');
    expect(text).toContain('  Clockwork Workshop [入口: 3-4] - A small workshop filled with gears and steam.');
    expect(text).toContain('  Gatekeeper @ 1-2 - Watches the town gate with a calm expression.');
  });

  it('shows なし when there are no buildings', () => {
    const mapConfig = createTestMapConfig();
    mapConfig.buildings = [];
    const text = buildMapSummaryText(mapConfig);

    expect(text).toContain('建物:\n  なし');
    expect(text).toContain('Gatekeeper @ 1-2');
  });

  it('shows なし when there are no NPCs', () => {
    const mapConfig = createTestMapConfig();
    mapConfig.npcs = [];
    const text = buildMapSummaryText(mapConfig);

    expect(text).toContain('Clockwork Workshop');
    expect(text).toContain('NPC:\n  なし');
  });

  it('shows なし for both when map is empty', () => {
    const mapConfig = createTestMapConfig();
    mapConfig.buildings = [];
    mapConfig.npcs = [];
    const text = buildMapSummaryText(mapConfig);

    expect(text).toContain('建物:\n  なし');
    expect(text).toContain('NPC:\n  なし');
  });

  it('joins multiple door nodes with commas', () => {
    const mapConfig = createTestMapConfig();
    mapConfig.buildings = [
      {
        building_id: 'multi-door',
        name: 'Multi Door Building',
        description: 'A building with multiple entrances.',
        wall_nodes: [],
        interior_nodes: [],
        door_nodes: ['1-1', '2-1', '3-1'],
        actions: [],
      },
    ];
    const text = buildMapSummaryText(mapConfig);

    expect(text).toContain('  Multi Door Building [入口: 1-1, 2-1, 3-1] - A building with multiple entrances.');
  });
});
