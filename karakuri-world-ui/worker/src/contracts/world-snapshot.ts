export type NodeId = `${number}-${number}`;

export type NodeType = 'normal' | 'wall' | 'door' | 'building_interior' | 'npc';

export type AgentState = 'idle' | 'moving' | 'in_action' | 'in_conversation';

export interface SnapshotWeather {
  condition: string;
  temperature_celsius: number;
}

export interface WorldCalendarSnapshot {
  timezone: string;
  local_date: string;
  local_time: string;
  season: 'spring' | 'summer' | 'autumn' | 'winter';
  season_label: '春' | '夏' | '秋' | '冬';
  day_in_season: number;
  display_label: string;
}

export interface MapRenderTheme {
  cell_size: number;
  label_font_size: number;
  node_id_font_size: number;
  background_fill: string;
  grid_stroke: string;
  default_node_fill: string;
  normal_node_fill: string;
  wall_node_fill: string;
  door_node_fill: string;
  npc_node_fill: string;
  building_palette: string[];
  wall_text_color: string;
  default_text_color: string;
}

export interface WorldSnapshotWorldConfigInput {
  name: string;
  description: string;
  [key: string]: unknown;
}

export interface WorldSnapshotNodeConfigInput {
  type: NodeType;
  label?: string;
  building_id?: string;
  npc_id?: string;
  [key: string]: unknown;
}

export interface WorldSnapshotBuildingConfigInput {
  building_id: string;
  name: string;
  description: string;
  wall_nodes: NodeId[];
  interior_nodes: NodeId[];
  door_nodes: NodeId[];
  actions: WorldSnapshotActionConfigInput[];
  [key: string]: unknown;
}

export interface WorldSnapshotNpcConfigInput {
  npc_id: string;
  name: string;
  description: string;
  node_id: NodeId;
  actions: WorldSnapshotActionConfigInput[];
  [key: string]: unknown;
}

export interface WorldSnapshotActionConfigInput {
  action_id: string;
  name: string;
  emoji?: string;
  [key: string]: unknown;
}

export interface WorldSnapshotAgentItemInput {
  [key: string]: unknown;
}

export type WorldSnapshotAgentActivityInput =
  | {
      type: 'action';
      action_id: string;
      action_name: string;
      duration_ms: number;
      completes_at: number;
    }
  | {
      type: 'wait';
      duration_ms: number;
      completes_at: number;
    }
  | {
      type: 'item_use';
      item_id: string;
      item_name: string;
      completes_at: number;
      duration_ms?: number;
    };

export interface WorldSnapshotAgentInput {
  agent_id: string;
  agent_name: string;
  node_id: NodeId;
  state: AgentState;
  discord_channel_id: string;
  money: number;
  items: WorldSnapshotAgentItemInput[];
  status_emoji: string;
  discord_bot_avatar_url?: string;
  current_conversation_id?: string;
  movement?: {
    from_node_id: NodeId;
    to_node_id: NodeId;
    path: NodeId[];
    arrives_at: number;
  };
  current_activity?: WorldSnapshotAgentActivityInput;
  [key: string]: unknown;
}

export interface WorldSnapshotConversationInput {
  conversation_id: string;
  status: 'pending' | 'active' | 'closing';
  participant_agent_ids: string[];
  current_speaker_agent_id: string;
  current_turn: number;
  [key: string]: unknown;
}

export interface WorldSnapshotServerEventInput {
  server_event_id: string;
  description: string;
  delivered_agent_ids: string[];
  pending_agent_ids: string[];
  [key: string]: unknown;
}

export interface WorldSnapshotMapInput {
  rows: number;
  cols: number;
  nodes: Partial<Record<NodeId, WorldSnapshotNodeConfigInput>>;
  buildings: WorldSnapshotBuildingConfigInput[];
  npcs: WorldSnapshotNpcConfigInput[];
}

export interface WorldSnapshot<
  TAgent = WorldSnapshotAgentInput,
  TConversation = WorldSnapshotConversationInput,
  TServerEvent = WorldSnapshotServerEventInput,
> {
  world: WorldSnapshotWorldConfigInput;
  timezone?: string;
  calendar: WorldCalendarSnapshot;
  map: WorldSnapshotMapInput;
  map_render_theme: MapRenderTheme;
  weather?: SnapshotWeather;
  agents: TAgent[];
  conversations: TConversation[];
  server_events: TServerEvent[];
  generated_at: number;
}
