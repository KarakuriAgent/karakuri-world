import type {
  AgentState,
  MapRenderTheme,
  SnapshotWeather,
  WorldCalendarSnapshot,
  WorldSnapshot,
  WorldSnapshotAgentActivityInput,
  WorldSnapshotAgentInput,
  WorldSnapshotConversationInput,
  WorldSnapshotMapInput,
  WorldSnapshotWorldConfigInput,
} from './world-snapshot.js';
import type { NodeId, NodeType } from './world-snapshot.js';
import { assertSpectatorMapDimensions } from './map-grid-limits.js';

export interface SpectatorWorldSnapshot {
  name: string;
  description: string;
}

export interface SpectatorNodeConfig {
  type: NodeType;
  label?: string;
  building_id?: string;
  npc_id?: string;
}

export interface SpectatorBuildingConfig {
  building_id: string;
  name: string;
  description: string;
  wall_nodes: NodeId[];
  interior_nodes: NodeId[];
  door_nodes: NodeId[];
}

export interface SpectatorNpcConfig {
  npc_id: string;
  name: string;
  description: string;
  node_id: NodeId;
}

export interface SpectatorMapSnapshot {
  rows: number;
  cols: number;
  nodes: Record<NodeId, SpectatorNodeConfig>;
  buildings: SpectatorBuildingConfig[];
  npcs: SpectatorNpcConfig[];
}

export interface SpectatorRecentServerEvent {
  server_event_id: string;
  description: string;
  occurred_at: number;
  is_active: boolean;
}

export type SpectatorAgentActivity =
  | {
      type: 'action';
      label: string;
      emoji: string;
      duration_ms: number;
      completes_at: number;
    }
  | {
      type: 'wait';
      label: string;
      emoji: string;
      duration_ms: number;
      completes_at: number;
    }
  | {
      type: 'item_use';
      label: string;
      emoji: string;
      completes_at: number;
      duration_ms?: number;
    };

export interface SpectatorAgentSnapshot {
  agent_id: string;
  agent_name: string;
  node_id: NodeId;
  state: AgentState;
  status_emoji: string;
  discord_bot_avatar_url?: string;
  current_conversation_id?: string;
  movement?: {
    from_node_id: NodeId;
    to_node_id: NodeId;
    path: NodeId[];
    arrives_at: number;
  };
  current_activity?: SpectatorAgentActivity;
}

export interface SpectatorConversationSnapshot {
  conversation_id: string;
  status: 'pending' | 'active' | 'closing';
  participant_agent_ids: string[];
  current_speaker_agent_id: string;
}

export interface SpectatorKnownAgent {
  agent_id: string;
  agent_name: string;
  discord_bot_avatar_url?: string;
}

export interface SpectatorSnapshot {
  schema_version: 1;
  world: SpectatorWorldSnapshot;
  timezone: string;
  calendar: WorldCalendarSnapshot;
  map: SpectatorMapSnapshot;
  map_render_theme: MapRenderTheme;
  weather?: SnapshotWeather;
  agents: SpectatorAgentSnapshot[];
  known_agents: SpectatorKnownAgent[];
  conversations: SpectatorConversationSnapshot[];
  recent_server_events: SpectatorRecentServerEvent[];
  generated_at: number;
  published_at: number;
  last_publish_error_at?: number;
}

export interface BuildSpectatorSnapshotInput {
  world_snapshot: WorldSnapshot<WorldSnapshotAgentInput, WorldSnapshotConversationInput>;
  recent_server_events: SpectatorRecentServerEvent[];
  published_at: number;
  last_publish_error_at?: number;
}

export function toSpectatorWorldSnapshot(world: WorldSnapshotWorldConfigInput): SpectatorWorldSnapshot {
  return {
    name: world.name,
    description: world.description,
  };
}

function toDenseSpectatorNodes(map: WorldSnapshotMapInput): SpectatorMapSnapshot['nodes'] {
  const nodes: Partial<Record<NodeId, SpectatorNodeConfig>> = {};

  for (let row = 1; row <= map.rows; row += 1) {
    for (let col = 1; col <= map.cols; col += 1) {
      const nodeId = `${row}-${col}` as NodeId;
      const node = map.nodes[nodeId];

      nodes[nodeId] = node
        ? {
            type: node.type,
            ...(node.label ? { label: node.label } : {}),
            ...(node.building_id ? { building_id: node.building_id } : {}),
            ...(node.npc_id ? { npc_id: node.npc_id } : {}),
          }
        : { type: 'normal' };
    }
  }

  return nodes as SpectatorMapSnapshot['nodes'];
}

export function toSpectatorMapSnapshot(map: WorldSnapshotMapInput): SpectatorMapSnapshot {
  assertSpectatorMapDimensions(map.rows, map.cols);

  return {
    rows: map.rows,
    cols: map.cols,
    nodes: toDenseSpectatorNodes(map),
    buildings: map.buildings.map((building) => ({
      building_id: building.building_id,
      name: building.name,
      description: building.description,
      wall_nodes: [...building.wall_nodes],
      interior_nodes: [...building.interior_nodes],
      door_nodes: [...building.door_nodes],
    })),
    npcs: map.npcs.map((npc) => ({
      npc_id: npc.npc_id,
      name: npc.name,
      description: npc.description,
      node_id: npc.node_id,
    })),
  };
}

function findActionEmoji(worldSnapshot: WorldSnapshot, actionId: string): string | undefined {
  for (const building of worldSnapshot.map.buildings) {
    const action = building.actions.find((candidate) => candidate.action_id === actionId);
    if (action) {
      return action.emoji;
    }
  }

  for (const npc of worldSnapshot.map.npcs) {
    const action = npc.actions.find((candidate) => candidate.action_id === actionId);
    if (action) {
      return action.emoji;
    }
  }

  return undefined;
}

function toSpectatorAgentActivity(
  worldSnapshot: WorldSnapshot,
  activity: WorldSnapshotAgentActivityInput,
): SpectatorAgentActivity {
  switch (activity.type) {
    case 'action':
      return {
        type: 'action',
        label: activity.action_name,
        emoji: findActionEmoji(worldSnapshot, activity.action_id) ?? '✨',
        duration_ms: activity.duration_ms,
        completes_at: activity.completes_at,
      };
    case 'wait':
      return {
        type: 'wait',
        label: '待機',
        emoji: '💤',
        duration_ms: activity.duration_ms,
        completes_at: activity.completes_at,
      };
    case 'item_use':
      return {
        type: 'item_use',
        label: activity.item_name,
        emoji: '🧰',
        completes_at: activity.completes_at,
        ...(activity.duration_ms !== undefined ? { duration_ms: activity.duration_ms } : {}),
      };
  }
}

function toSpectatorAgentSnapshot(
  worldSnapshot: WorldSnapshot,
  agent: WorldSnapshotAgentInput,
): SpectatorAgentSnapshot {
  return {
    agent_id: agent.agent_id,
    agent_name: agent.agent_name,
    node_id: agent.node_id,
    state: agent.state,
    status_emoji: agent.status_emoji,
    ...(agent.discord_bot_avatar_url ? { discord_bot_avatar_url: agent.discord_bot_avatar_url } : {}),
    ...(agent.current_conversation_id ? { current_conversation_id: agent.current_conversation_id } : {}),
    ...(agent.movement
      ? {
          movement: {
            from_node_id: agent.movement.from_node_id,
            to_node_id: agent.movement.to_node_id,
            path: [...agent.movement.path],
            arrives_at: agent.movement.arrives_at,
          },
        }
      : {}),
    ...(agent.current_activity
      ? {
          current_activity: toSpectatorAgentActivity(worldSnapshot, agent.current_activity),
        }
      : {}),
  };
}

function toSpectatorConversationSnapshot(
  conversation: WorldSnapshotConversationInput,
): SpectatorConversationSnapshot {
  return {
    conversation_id: conversation.conversation_id,
    status: conversation.status,
    participant_agent_ids: [...conversation.participant_agent_ids],
    current_speaker_agent_id: conversation.current_speaker_agent_id,
  };
}

function toSpectatorKnownAgent(agent: { agent_id: string; agent_name: string; discord_bot_avatar_url?: string }): SpectatorKnownAgent {
  return {
    agent_id: agent.agent_id,
    agent_name: agent.agent_name,
    ...(agent.discord_bot_avatar_url ? { discord_bot_avatar_url: agent.discord_bot_avatar_url } : {}),
  };
}

export function buildSpectatorSnapshot({
  world_snapshot,
  recent_server_events,
  published_at,
  last_publish_error_at,
}: BuildSpectatorSnapshotInput): SpectatorSnapshot {
  return {
    schema_version: 1,
    world: toSpectatorWorldSnapshot(world_snapshot.world),
    timezone: world_snapshot.calendar.timezone,
    calendar: { ...world_snapshot.calendar },
    map: toSpectatorMapSnapshot(world_snapshot.map),
    map_render_theme: {
      ...world_snapshot.map_render_theme,
      building_palette: [...world_snapshot.map_render_theme.building_palette],
    },
    ...(world_snapshot.weather ? { weather: { ...world_snapshot.weather } } : {}),
    agents: world_snapshot.agents.map((agent) => toSpectatorAgentSnapshot(world_snapshot, agent)),
    known_agents: (world_snapshot.known_agents ?? []).map(toSpectatorKnownAgent),
    conversations: world_snapshot.conversations.map((conversation) => toSpectatorConversationSnapshot(conversation)),
    recent_server_events: recent_server_events.map((event) => ({ ...event })),
    generated_at: world_snapshot.generated_at,
    published_at,
    ...(last_publish_error_at !== undefined ? { last_publish_error_at } : {}),
  };
}
