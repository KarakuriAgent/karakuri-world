import type { ServerConfig } from '../types/data-model.js';
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

function pushIssue(issues: ConfigValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function checkNodeBounds(config: ServerConfig, issues: ConfigValidationIssue[]): void {
  for (const nodeId of Object.keys(config.map.nodes)) {
    if (!isNodeWithinBounds(nodeId as `${number}-${number}`, config.map)) {
      pushIssue(issues, `map.nodes.${nodeId}`, 'Node is outside map bounds.');
    }
  }
}

export function collectValidationIssues(config: ServerConfig): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  const actionOwners = new Map<string, string>();
  const buildingNodeOwners = new Map<string, string>();
  const npcNodeOwners = new Map<string, string>();
  const serverEventIds = new Set<string>();

  checkNodeBounds(config, issues);

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
    const claimedNodes = new Set<string>();

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
        }
        claimedNodes.add(nodeId);

        const owner = buildingNodeOwners.get(nodeId);
        if (owner && owner !== building.building_id) {
          pushIssue(issues, path, `Node is already used by building ${owner}.`);
        }
        buildingNodeOwners.set(nodeId, building.building_id);
      });
    }

    building.wall_nodes.forEach((nodeId, nodeIndex) => {
      if (getNodeConfig(nodeId, config.map).type !== 'wall') {
        pushIssue(issues, `map.buildings[${buildingIndex}].wall_nodes[${nodeIndex}]`, 'Wall node must have type "wall".');
      }
    });

    building.interior_nodes.forEach((nodeId, nodeIndex) => {
      if (getNodeConfig(nodeId, config.map).type !== 'building_interior') {
        pushIssue(
          issues,
          `map.buildings[${buildingIndex}].interior_nodes[${nodeIndex}]`,
          'Interior node must have type "building_interior".',
        );
      }

      for (const direction of ['north', 'south', 'east', 'west'] as const) {
        const adjacentNodeId = getAdjacentNodeId(nodeId, direction, config.map);
        if (!adjacentNodeId) {
          continue;
        }

        const isInterior = building.interior_nodes.includes(adjacentNodeId);
        const isDoor = building.door_nodes.includes(adjacentNodeId);
        if (isInterior || isDoor) {
          continue;
        }

        const adjacentType = getNodeConfig(adjacentNodeId, config.map).type;
        if (isPassable(adjacentType)) {
          pushIssue(
            issues,
            `map.buildings[${buildingIndex}].interior_nodes[${nodeIndex}]`,
            'Interior node cannot touch passable exterior nodes without a door.',
          );
          break;
        }
      }
    });

    building.door_nodes.forEach((nodeId, nodeIndex) => {
      if (getNodeConfig(nodeId, config.map).type !== 'door') {
        pushIssue(issues, `map.buildings[${buildingIndex}].door_nodes[${nodeIndex}]`, 'Door node must have type "door".');
      }

      let touchesInterior = false;
      let touchesExterior = false;
      for (const direction of ['north', 'south', 'east', 'west'] as const) {
        const adjacentNodeId = getAdjacentNodeId(nodeId, direction, config.map);
        if (!adjacentNodeId) {
          continue;
        }

        if (building.interior_nodes.includes(adjacentNodeId)) {
          touchesInterior = true;
          continue;
        }

        const isBuildingNode = claimedNodes.has(adjacentNodeId);
        const adjacentType = getNodeConfig(adjacentNodeId, config.map).type;
        if (!isBuildingNode && isPassable(adjacentType)) {
          touchesExterior = true;
        }
      }

      if (!touchesInterior || !touchesExterior) {
        pushIssue(
          issues,
          `map.buildings[${buildingIndex}].door_nodes[${nodeIndex}]`,
          'Door node must connect at least one interior node and one passable exterior node.',
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

    if (getNodeConfig(npc.node_id, config.map).type !== 'npc') {
      pushIssue(issues, `map.npcs[${npcIndex}].node_id`, 'NPC node must have type "npc".');
    }

    const existingNpc = npcNodeOwners.get(npc.node_id);
    if (existingNpc && existingNpc !== npc.npc_id) {
      pushIssue(issues, `map.npcs[${npcIndex}].node_id`, `NPC node is already used by ${existingNpc}.`);
    }
    npcNodeOwners.set(npc.node_id, npc.npc_id);

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

  return issues;
}

export function validateServerConfig(config: ServerConfig): void {
  const issues = collectValidationIssues(config);
  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }
}
