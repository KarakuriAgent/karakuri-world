import { describe, expect, it } from 'vitest';

import { createTestMapConfig } from '../../helpers/test-map.js';
import {
  findAdjacentNpcs,
  findBuildingByInteriorNode,
  findBuildingsInNodes,
  getAdjacentNodeId,
  getNodeConfig,
  getNodesInRange,
  isPassable,
  manhattanDistance,
  parseNodeId,
  toNodeId,
} from '../../../src/domain/map-utils.js';

const mapConfig = createTestMapConfig();

describe('map-utils', () => {
  it('parses and serializes node ids', () => {
    expect(parseNodeId('2-4')).toEqual({ row: 2, col: 4 });
    expect(toNodeId(2, 4)).toBe('2-4');
  });

  it('finds adjacent nodes within bounds', () => {
    expect(getAdjacentNodeId('2-4', 'north', mapConfig)).toBe('1-4');
    expect(getAdjacentNodeId('1-1', 'north', mapConfig)).toBeNull();
    expect(getAdjacentNodeId('3-5', 'east', mapConfig)).toBeNull();
  });

  it('returns default normal node config when node is undefined', () => {
    expect(getNodeConfig('3-1', mapConfig)).toEqual({ type: 'normal' });
  });

  it('knows which node types are passable', () => {
    expect(isPassable('normal')).toBe(true);
    expect(isPassable('door')).toBe(true);
    expect(isPassable('building_interior')).toBe(true);
    expect(isPassable('wall')).toBe(false);
    expect(isPassable('npc')).toBe(false);
  });

  it('calculates Manhattan distance', () => {
    expect(manhattanDistance('1-1', '3-2')).toBe(3);
  });

  it('collects nodes in range sorted by distance', () => {
    expect(getNodesInRange('3-1', 1, mapConfig)).toEqual(['3-1', '2-1', '3-2']);
  });

  it('finds buildings from interior nodes and node sets', () => {
    expect(findBuildingByInteriorNode('2-4', mapConfig)?.building_id).toBe('building-workshop');
    expect(findBuildingByInteriorNode('3-1', mapConfig)).toBeNull();
    expect(findBuildingsInNodes(['2-4', '3-1'], mapConfig).map((building) => building.building_id)).toEqual([
      'building-workshop',
    ]);
  });

  it('finds adjacent NPCs', () => {
    expect(findAdjacentNpcs('1-1', mapConfig).map((npc) => npc.npc_id)).toEqual(['npc-gatekeeper']);
    expect(findAdjacentNpcs('3-1', mapConfig)).toEqual([]);
  });
});
