import type { Direction, NodeConfig, NodeId, ServerConfig } from '../types/data-model.js';
import { getAdjacentNodeId, getNodeConfig, isNodeWithinBounds, isPassable } from '../domain/map-utils.js';

export interface ConfigValidationIssue {
  path: string;
  message: string;
}

export class ConfigValidationError extends Error {
  readonly issues: ConfigValidationIssue[];

  constructor(issues: ConfigValidationIssue[]) {
    super(`Invalid server config (${issues.length} issue${issues.length === 1 ? '' : 's'})`);
    this.issues = issues;
  }
}

const CARDINAL_DIRECTIONS: readonly Direction[] = ['north', 'south', 'east', 'west'];
const BUILDING_NODE_TYPES = new Set<NodeConfig['type']>(['wall', 'door', 'building_interior', 'npc']);

function pushIssue(issues: ConfigValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function getAdjacentNodeIds(nodeId: NodeId, config: ServerConfig): NodeId[] {
  return CARDINAL_DIRECTIONS.flatMap((direction) => {
    const adjacentNodeId = getAdjacentNodeId(nodeId, direction, config.map);
    return adjacentNodeId ? [adjacentNodeId] : [];
  });
}

function isBuildingBoundaryNode(nodeId: NodeId, buildingId: string, config: ServerConfig): boolean {
  const node = getNodeConfig(nodeId, config.map);
  return node.building_id === buildingId && BUILDING_NODE_TYPES.has(node.type);
}

function checkNodeBounds(config: ServerConfig, issues: ConfigValidationIssue[]): void {
  for (const nodeId of Object.keys(config.map.nodes)) {
    if (!isNodeWithinBounds(nodeId as NodeId, config.map)) {
      pushIssue(issues, `map.nodes.${nodeId}`, 'Node is outside map bounds.');
    }
  }
}

export function collectValidationIssues(config: ServerConfig): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  const actionOwners = new Map<string, string>();
  const buildingIds = new Map<string, number>();
  const buildingNodeOwners = new Map<string, { buildingId: string; buildingIndex: number }>();
  const npcIds = new Map<string, number>();
  const npcNodeOwners = new Map<string, { npcId: string; npcIndex: number }>();
  const serverEventIds = new Set<string>();

  checkNodeBounds(config, issues);

  config.map.buildings.forEach((building, buildingIndex) => {
    const previousIndex = buildingIds.get(building.building_id);
    if (previousIndex !== undefined) {
      pushIssue(
        issues,
        `map.buildings[${buildingIndex}].building_id`,
        `Duplicate building id "${building.building_id}".`,
      );
    } else {
      buildingIds.set(building.building_id, buildingIndex);
    }
  });

  config.map.npcs.forEach((npc, npcIndex) => {
    const previousIndex = npcIds.get(npc.npc_id);
    if (previousIndex !== undefined) {
      pushIssue(issues, `map.npcs[${npcIndex}].npc_id`, `Duplicate NPC id "${npc.npc_id}".`);
    } else {
      npcIds.set(npc.npc_id, npcIndex);
    }
  });

  for (const [nodeId, nodeConfig] of Object.entries(config.map.nodes) as Array<[NodeId, NodeConfig]>) {
    const nodePath = `map.nodes.${nodeId}`;
    switch (nodeConfig.type) {
      case 'normal':
        if (nodeConfig.building_id !== undefined) {
          pushIssue(issues, `${nodePath}.building_id`, 'Normal node must not define building_id.');
        }
        if (nodeConfig.npc_id !== undefined) {
          pushIssue(issues, `${nodePath}.npc_id`, 'Normal node must not define npc_id.');
        }
        break;
      case 'wall':
      case 'door':
      case 'building_interior':
        if (!nodeConfig.building_id) {
          pushIssue(
            issues,
            `${nodePath}.building_id`,
            `Node type "${nodeConfig.type}" must define building_id.`,
          );
        }
        if (nodeConfig.npc_id !== undefined) {
          pushIssue(issues, `${nodePath}.npc_id`, `Node type "${nodeConfig.type}" must not define npc_id.`);
        }
        break;
      case 'npc':
        if (!nodeConfig.npc_id) {
          pushIssue(issues, `${nodePath}.npc_id`, 'NPC node must define npc_id.');
        }
        break;
    }
  }

  config.spawn.nodes.forEach((nodeId, index) => {
    if (!isNodeWithinBounds(nodeId, config.map)) {
      pushIssue(issues, `spawn.nodes[${index}]`, 'Spawn node is outside map bounds.');
      return;
    }

    if (!isPassable(getNodeConfig(nodeId, config.map).type)) {
      pushIssue(issues, `spawn.nodes[${index}]`, 'Spawn node must be passable.');
    }
  });

  config.map.buildings.forEach((building, buildingIndex) => {
    const claimedNodes = new Set<NodeId>();

    for (const [kind, nodes] of [
      ['wall_nodes', building.wall_nodes],
      ['interior_nodes', building.interior_nodes],
      ['door_nodes', building.door_nodes],
    ] as const) {
      nodes.forEach((nodeId, nodeIndex) => {
        const path = `map.buildings[${buildingIndex}].${kind}[${nodeIndex}]`;
        if (!isNodeWithinBounds(nodeId, config.map)) {
          pushIssue(issues, path, 'Building node is outside map bounds.');
          return;
        }

        if (claimedNodes.has(nodeId)) {
          pushIssue(issues, path, 'Building nodes must not overlap within a building.');
        } else {
          claimedNodes.add(nodeId);
        }

        const owner = buildingNodeOwners.get(nodeId);
        if (owner && owner.buildingIndex !== buildingIndex) {
          pushIssue(issues, path, `Node is already used by building ${owner.buildingId}.`);
        } else {
          buildingNodeOwners.set(nodeId, { buildingId: building.building_id, buildingIndex });
        }
      });
    }

    building.wall_nodes.forEach((nodeId, nodeIndex) => {
      const path = `map.buildings[${buildingIndex}].wall_nodes[${nodeIndex}]`;
      const node = getNodeConfig(nodeId, config.map);
      if (node.type !== 'wall') {
        pushIssue(issues, path, 'Wall node must have type "wall".');
      }
      if (node.building_id !== building.building_id) {
        pushIssue(issues, path, 'Wall node must belong to the same building.');
      }

      const touchesSameBuilding = getAdjacentNodeIds(nodeId, config).some((adjacentNodeId) =>
        isBuildingBoundaryNode(adjacentNodeId, building.building_id, config),
      );
      if (!touchesSameBuilding) {
        pushIssue(issues, path, 'Wall node must touch at least one node in the same building.');
      }
    });

    building.interior_nodes.forEach((nodeId, nodeIndex) => {
      const path = `map.buildings[${buildingIndex}].interior_nodes[${nodeIndex}]`;
      const node = getNodeConfig(nodeId, config.map);
      if (node.type !== 'building_interior') {
        pushIssue(issues, path, 'Interior node must have type "building_interior".');
      }
      if (node.building_id !== building.building_id) {
        pushIssue(issues, path, 'Interior node must belong to the same building.');
      }

      for (const adjacentNodeId of getAdjacentNodeIds(nodeId, config)) {
        if (isBuildingBoundaryNode(adjacentNodeId, building.building_id, config)) {
          continue;
        }

        pushIssue(issues, path, 'Interior node must be enclosed by nodes in the same building.');
        break;
      }
    });

    building.door_nodes.forEach((nodeId, nodeIndex) => {
      const path = `map.buildings[${buildingIndex}].door_nodes[${nodeIndex}]`;
      const node = getNodeConfig(nodeId, config.map);
      if (node.type !== 'door') {
        pushIssue(issues, path, 'Door node must have type "door".');
      }
      if (node.building_id !== building.building_id) {
        pushIssue(issues, path, 'Door node must belong to the same building.');
      }

      let touchesInterior = false;
      let touchesExterior = false;
      for (const adjacentNodeId of getAdjacentNodeIds(nodeId, config)) {
        const adjacentNode = getNodeConfig(adjacentNodeId, config.map);
        if (adjacentNode.type === 'building_interior' && adjacentNode.building_id === building.building_id) {
          touchesInterior = true;
        }

        if (
          adjacentNode.type === 'normal'
          && adjacentNode.building_id === undefined
          && adjacentNode.npc_id === undefined
        ) {
          touchesExterior = true;
        }
      }

      if (!touchesInterior || !touchesExterior) {
        pushIssue(
          issues,
          path,
          'Door node must connect at least one interior node and one exterior normal node.',
        );
      }
    });

    building.actions.forEach((action, actionIndex) => {
      const owner = actionOwners.get(action.action_id);
      if (owner) {
        pushIssue(
          issues,
          `map.buildings[${buildingIndex}].actions[${actionIndex}].action_id`,
          `Action id "${action.action_id}" is already used by ${owner}.`,
        );
        return;
      }

      actionOwners.set(action.action_id, `building ${building.building_id}`);
    });
  });

  config.map.npcs.forEach((npc, npcIndex) => {
    if (!isNodeWithinBounds(npc.node_id, config.map)) {
      pushIssue(issues, `map.npcs[${npcIndex}].node_id`, 'NPC node is outside map bounds.');
    }

    const node = getNodeConfig(npc.node_id, config.map);
    if (node.type !== 'npc') {
      pushIssue(issues, `map.npcs[${npcIndex}].node_id`, 'NPC node must have type "npc".');
    }
    if (node.npc_id !== npc.npc_id) {
      pushIssue(issues, `map.npcs[${npcIndex}].node_id`, 'NPC node must reference the same npc_id.');
    }

    const existingNpc = npcNodeOwners.get(npc.node_id);
    if (existingNpc && existingNpc.npcIndex !== npcIndex) {
      pushIssue(issues, `map.npcs[${npcIndex}].node_id`, `NPC node is already used by ${existingNpc.npcId}.`);
    } else {
      npcNodeOwners.set(npc.node_id, { npcId: npc.npc_id, npcIndex });
    }

    if (buildingNodeOwners.has(npc.node_id)) {
      pushIssue(issues, `map.npcs[${npcIndex}].node_id`, 'NPC node cannot overlap a building node.');
    }

    npc.actions.forEach((action, actionIndex) => {
      const owner = actionOwners.get(action.action_id);
      if (owner) {
        pushIssue(
          issues,
          `map.npcs[${npcIndex}].actions[${actionIndex}].action_id`,
          `Action id "${action.action_id}" is already used by ${owner}.`,
        );
        return;
      }

      actionOwners.set(action.action_id, `npc ${npc.npc_id}`);
    });
  });

  config.server_events.forEach((serverEvent, eventIndex) => {
    if (serverEventIds.has(serverEvent.event_id)) {
      pushIssue(issues, `server_events[${eventIndex}].event_id`, `Duplicate server event id "${serverEvent.event_id}".`);
    }
    serverEventIds.add(serverEvent.event_id);

    const choiceIds = new Set<string>();
    serverEvent.choices.forEach((choice, choiceIndex) => {
      if (choiceIds.has(choice.choice_id)) {
        pushIssue(
          issues,
          `server_events[${eventIndex}].choices[${choiceIndex}].choice_id`,
          `Duplicate choice id "${choice.choice_id}" in server event ${serverEvent.event_id}.`,
        );
      }
      choiceIds.add(choice.choice_id);
    });
  });

  for (const [nodeId, nodeConfig] of Object.entries(config.map.nodes) as Array<[NodeId, NodeConfig]>) {
    const nodePath = `map.nodes.${nodeId}`;
    if (nodeConfig.building_id) {
      const buildingIndex = buildingIds.get(nodeConfig.building_id);
      if (buildingIndex === undefined) {
        pushIssue(
          issues,
          `${nodePath}.building_id`,
          `Node references unknown building "${nodeConfig.building_id}".`,
        );
      } else if (nodeConfig.type !== 'npc') {
        const building = config.map.buildings[buildingIndex];
        const belongsToBuilding = {
          wall: building.wall_nodes.includes(nodeId),
          door: building.door_nodes.includes(nodeId),
          building_interior: building.interior_nodes.includes(nodeId),
          normal: false,
          npc: false,
        }[nodeConfig.type];

        if (!belongsToBuilding) {
          pushIssue(
            issues,
            `${nodePath}.building_id`,
            'Node must be listed in the corresponding building definition.',
          );
        }
      }
    }

    if (nodeConfig.npc_id) {
      const npcIndex = npcIds.get(nodeConfig.npc_id);
      if (npcIndex === undefined) {
        pushIssue(issues, `${nodePath}.npc_id`, `Node references unknown NPC "${nodeConfig.npc_id}".`);
      } else if (config.map.npcs[npcIndex].node_id !== nodeId) {
        pushIssue(issues, `${nodePath}.npc_id`, 'NPC node must match the corresponding NPC definition.');
      }
    }

    if (nodeConfig.type === 'npc' && nodeConfig.building_id) {
      for (const adjacentNodeId of getAdjacentNodeIds(nodeId, config)) {
        if (isBuildingBoundaryNode(adjacentNodeId, nodeConfig.building_id, config)) {
          continue;
        }

        pushIssue(
          issues,
          nodePath,
          'NPC node inside a building must be enclosed by nodes in the same building.',
        );
        break;
      }
    }
  }

  return issues;
}

export function validateServerConfig(config: ServerConfig): void {
  const issues = collectValidationIssues(config);
  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }
}
