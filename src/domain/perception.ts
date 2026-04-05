import type { WorldEngine } from '../engine/world-engine.js';
import type { LoggedInAgent } from '../types/agent.js';
import type { PerceptionResponse } from '../types/api.js';
import { WorldError } from '../types/api.js';
import type { ItemConfig, MapConfig, NodeId } from '../types/data-model.js';
import { findBuildingsInNodes, getNodeConfig, getNodesInRange, isPassable, manhattanDistance } from './map-utils.js';
import { getAgentCurrentNode } from './movement.js';
import { formatWorldTime } from './time-utils.js';

export type PerceptionData = PerceptionResponse;

function formatItemEntries(items: LoggedInAgent['items'], itemConfigs: ReadonlyArray<ItemConfig>): PerceptionResponse['items'] {
  const itemMap = new Map(itemConfigs.map((item) => [item.item_id, item]));
  return [...items]
    .map((item) => ({
      item_id: item.item_id,
      name: itemMap.get(item.item_id)?.name ?? item.item_id,
      quantity: item.quantity,
    }))
    .sort((left, right) => left.item_id.localeCompare(right.item_id));
}

export function getPerceptionData(engine: WorldEngine, agentId: string): PerceptionData {
  const loggedInAgent = engine.state.getLoggedIn(agentId);
  if (!loggedInAgent) {
    throw new WorldError(403, 'not_logged_in', `Agent is not logged in: ${agentId}`);
  }

  const now = new Date();
  const timestamp = now.getTime();
  const loggedInAgents = engine.state.listLoggedIn().map((agent) => ({
    ...agent,
    node_id: getAgentCurrentNode(engine, agent, timestamp),
  }));
  const currentAgent = loggedInAgents.find((agent) => agent.agent_id === agentId);
  if (!currentAgent) {
    throw new WorldError(403, 'not_logged_in', `Agent is not logged in: ${agentId}`);
  }

  return buildPerceptionData(currentAgent, loggedInAgents, engine.config.map, engine.config.perception.range, {
    timezone: engine.config.timezone,
    now,
    itemConfigs: engine.config.items ?? [],
    weather: engine.getWeatherState() ?? undefined,
  });
}

export function buildPerceptionData(
  agent: Pick<LoggedInAgent, 'agent_id' | 'node_id' | 'money' | 'items'>,
  loggedInAgents: ReadonlyArray<LoggedInAgent>,
  mapConfig: MapConfig,
  range: number,
  options: {
    timezone: string;
    now: Date;
    itemConfigs: ReadonlyArray<ItemConfig>;
    weather?: { condition_text: string; temperature_celsius: number };
  },
): PerceptionData {
  const nodeIds = getNodesInRange(agent.node_id, range, mapConfig);
  const nodeSet = new Set(nodeIds);

  return {
    world_time: formatWorldTime(options.now, options.timezone),
    ...(options.weather
      ? {
          weather: {
            condition: options.weather.condition_text,
            temperature_celsius: options.weather.temperature_celsius,
          },
        }
      : {}),
    money: agent.money,
    items: formatItemEntries(agent.items, options.itemConfigs),
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
    agents: loggedInAgents
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
  const passableNodes = data.nodes
    .filter((node) => node.distance !== 0 && isPassable(node.type))
    .map((node) => `${node.node_id}${node.label ? `(${node.label})` : ''}`)
    .join(', ');

  const itemsText = data.items.length > 0 ? data.items.map((item) => `${item.name} ×${item.quantity}`).join(', ') : 'なし';
  const weatherText = data.weather ? `天気: ${data.weather.condition} ${data.weather.temperature_celsius}℃` : undefined;

  return [
    `現在時刻: ${data.world_time}`,
    weatherText,
    `現在地: ${data.current_node.node_id}${data.current_node.label ? ` (${data.current_node.label})` : ''}`,
    summarizeList('近くのノード', passableNodes ? [passableNodes] : []),
    summarizeList(
      '見えているエージェント',
      data.agents.map((agent) => `${agent.agent_name}@${agent.node_id}`),
    ),
    summarizeList('近くのNPC', data.npcs.map((npc) => `${npc.name}@${npc.node_id}`)),
    summarizeList('近くの建物', data.buildings.map((building) => `${building.name} [${building.door_nodes.join(', ')}]`)),
    `所持金: ${data.money.toLocaleString('ja-JP')}円`,
    `アイテム: ${itemsText}`,
  ]
    .filter(Boolean)
    .join('\n');
}
