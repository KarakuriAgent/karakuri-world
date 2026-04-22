import type { BuildingConfig, Direction, MapConfig, NodeConfig, NodeCoordinate, NodeId, NodeType, NpcConfig } from '../types/data-model.js';

const PASSABLE_NODE_TYPES = new Set<NodeType>(['normal', 'door', 'building_interior']);
const CARDINAL_DIRECTIONS: readonly Direction[] = ['north', 'south', 'east', 'west'];

export function parseNodeId(nodeId: NodeId | string): NodeCoordinate {
  const match = /^(\d+)-(\d+)$/.exec(nodeId);
  if (!match) {
    throw new Error(`Invalid node id: ${nodeId}`);
  }

  return {
    row: Number(match[1]),
    col: Number(match[2]),
  };
}

export function toNodeId(row: number, col: number): NodeId {
  return `${row}-${col}` as NodeId;
}

export function isNodeWithinBounds(nodeId: NodeId, mapConfig: MapConfig): boolean {
  const { row, col } = parseNodeId(nodeId);
  return row >= 1 && row <= mapConfig.rows && col >= 1 && col <= mapConfig.cols;
}

export function getAdjacentNodeId(
  nodeId: NodeId,
  direction: Direction,
  mapConfig: MapConfig,
): NodeId | null {
  const { row, col } = parseNodeId(nodeId);
  const next = {
    north: { row: row - 1, col },
    south: { row: row + 1, col },
    east: { row, col: col + 1 },
    west: { row, col: col - 1 },
  }[direction];

  const adjacentNodeId = toNodeId(next.row, next.col);
  return isNodeWithinBounds(adjacentNodeId, mapConfig) ? adjacentNodeId : null;
}

export function getNodeConfig(nodeId: NodeId, mapConfig: MapConfig): NodeConfig {
  return mapConfig.nodes[nodeId] ?? { type: 'normal' };
}

export function isPassable(nodeType: NodeType): boolean {
  return PASSABLE_NODE_TYPES.has(nodeType);
}

function reconstructPath(from: NodeId, to: NodeId, previous: ReadonlyMap<NodeId, NodeId>): NodeId[] {
  const path: NodeId[] = [];
  let current = to;

  while (current !== from) {
    path.push(current);
    const previousNode = previous.get(current);
    if (!previousNode) {
      throw new Error(`Failed to reconstruct path from ${from} to ${to}.`);
    }
    current = previousNode;
  }

  return path.reverse();
}

export function findPath(from: NodeId, to: NodeId, mapConfig: MapConfig): NodeId[] | null {
  if (from === to) {
    return [];
  }

  const queue: NodeId[] = [from];
  const visited = new Set<NodeId>([from]);
  const previous = new Map<NodeId, NodeId>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    for (const direction of CARDINAL_DIRECTIONS) {
      const adjacentNodeId = getAdjacentNodeId(current, direction, mapConfig);
      if (!adjacentNodeId || visited.has(adjacentNodeId)) {
        continue;
      }

      if (!isPassable(getNodeConfig(adjacentNodeId, mapConfig).type)) {
        continue;
      }

      visited.add(adjacentNodeId);
      previous.set(adjacentNodeId, current);

      if (adjacentNodeId === to) {
        return reconstructPath(from, to, previous);
      }

      queue.push(adjacentNodeId);
    }
  }

  return null;
}

export function manhattanDistance(a: NodeId, b: NodeId): number {
  const left = parseNodeId(a);
  const right = parseNodeId(b);
  return Math.abs(left.row - right.row) + Math.abs(left.col - right.col);
}

export function getNodesInRange(center: NodeId, range: number, mapConfig: MapConfig): NodeId[] {
  const nodes: NodeId[] = [];
  for (let row = 1; row <= mapConfig.rows; row += 1) {
    for (let col = 1; col <= mapConfig.cols; col += 1) {
      const candidate = toNodeId(row, col);
      if (manhattanDistance(center, candidate) <= range) {
        nodes.push(candidate);
      }
    }
  }

  return nodes.sort((left, right) => {
    const distanceDiff = manhattanDistance(center, left) - manhattanDistance(center, right);
    return distanceDiff !== 0 ? distanceDiff : left.localeCompare(right);
  });
}

export function findBuildingByInteriorNode(nodeId: NodeId, mapConfig: MapConfig): BuildingConfig | null {
  return mapConfig.buildings.find((building) => building.interior_nodes.includes(nodeId)) ?? null;
}

export function findBuildingsInNodes(nodeIds: Iterable<NodeId>, mapConfig: MapConfig): BuildingConfig[] {
  const nodeSet = new Set(nodeIds);
  return mapConfig.buildings
    .filter((building) => {
      const buildingNodes = [...building.wall_nodes, ...building.interior_nodes, ...building.door_nodes];
      return buildingNodes.some((nodeId) => nodeSet.has(nodeId));
    })
    .sort((left, right) => left.building_id.localeCompare(right.building_id));
}

export function findAdjacentNpcs(nodeId: NodeId, mapConfig: MapConfig): NpcConfig[] {
  return mapConfig.npcs
    .filter((npc) => manhattanDistance(nodeId, npc.node_id) === 1)
    .sort((left, right) => left.npc_id.localeCompare(right.npc_id));
}
