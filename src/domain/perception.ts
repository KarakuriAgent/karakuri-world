import type { WorldEngine } from '../engine/world-engine.js';
import type { JoinedAgent } from '../types/agent.js';
import type { PerceptionResponse } from '../types/api.js';
import { WorldError } from '../types/api.js';
import type { MapConfig, NodeId } from '../types/data-model.js';
import { findBuildingsInNodes, getNodeConfig, getNodesInRange, manhattanDistance } from './map-utils.js';
import { getAgentCurrentNode } from './movement.js';

export type PerceptionData = PerceptionResponse;

export function getPerceptionData(engine: WorldEngine, agentId: string): PerceptionData {
  const joinedAgent = engine.state.getJoined(agentId);
  if (!joinedAgent) {
    throw new WorldError(403, 'not_joined', `Agent is not joined: ${agentId}`);
  }

  const now = Date.now();
  const joinedAgents = engine.state.listJoined().map((agent) => ({
    ...agent,
    node_id: getAgentCurrentNode(engine, agent, now),
  }));
  const currentAgent = joinedAgents.find((agent) => agent.agent_id === agentId);
  if (!currentAgent) {
    throw new WorldError(403, 'not_joined', `Agent is not joined: ${agentId}`);
  }

  return buildPerceptionData(currentAgent, joinedAgents, engine.config.map, engine.config.perception.range);
}

export function buildPerceptionData(
  agent: Pick<JoinedAgent, 'agent_id' | 'node_id'>,
  joinedAgents: ReadonlyArray<JoinedAgent>,
  mapConfig: MapConfig,
  range: number,
): PerceptionData {
  const nodeIds = getNodesInRange(agent.node_id, range, mapConfig);
  const nodeSet = new Set(nodeIds);

  return {
    current_node: {
      node_id: agent.node_id,
      ...getNodeConfig(agent.node_id, mapConfig),
    },
    nodes: nodeIds.map((nodeId) => {
      const nodeConfig = getNodeConfig(nodeId, mapConfig);
      return {
        node_id: nodeId,
        type: nodeConfig.type,
        label: nodeConfig.label,
        distance: manhattanDistance(agent.node_id, nodeId),
      };
    }),
    agents: joinedAgents
      .filter((otherAgent) => otherAgent.agent_id !== agent.agent_id && nodeSet.has(otherAgent.node_id))
      .map((otherAgent) => ({
        agent_id: otherAgent.agent_id,
        agent_name: otherAgent.agent_name,
        node_id: otherAgent.node_id,
      }))
      .sort((left, right) => left.agent_id.localeCompare(right.agent_id)),
    npcs: mapConfig.npcs
      .filter((npc) => nodeSet.has(npc.node_id))
      .map((npc) => ({
        npc_id: npc.npc_id,
        name: npc.name,
        node_id: npc.node_id,
      }))
      .sort((left, right) => left.npc_id.localeCompare(right.npc_id)),
    buildings: findBuildingsInNodes(nodeSet as Iterable<NodeId>, mapConfig).map((building) => ({
      building_id: building.building_id,
      name: building.name,
      door_nodes: building.door_nodes,
    })),
  };
}

function summarizeList(title: string, values: string[]): string {
  return `${title}: ${values.length > 0 ? values.join(' / ') : 'なし'}`;
}

export function buildPerceptionText(data: PerceptionData): string {
  const nodeSummary = data.nodes
    .map((node) => `${node.node_id}(${node.type}${node.label ? `:${node.label}` : ''})`)
    .join(', ');

  return [
    `現在地: ${data.current_node.node_id}${data.current_node.label ? ` (${data.current_node.label})` : ''}`,
    summarizeList('周囲ノード', nodeSummary ? [nodeSummary] : []),
    summarizeList(
      '見えているエージェント',
      data.agents.map((agent) => `${agent.agent_name}@${agent.node_id}`),
    ),
    summarizeList('近くのNPC', data.npcs.map((npc) => `${npc.name}@${npc.node_id}`)),
    summarizeList('近くの建物', data.buildings.map((building) => `${building.name} [${building.door_nodes.join(', ')}]`)),
  ].join('\n');
}
