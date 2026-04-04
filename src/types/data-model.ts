export type NodeId = `${number}-${number}`;

export type NodeType = 'normal' | 'wall' | 'door' | 'building_interior' | 'npc';

export type Direction = 'north' | 'south' | 'east' | 'west';

export interface NodeCoordinate {
  row: number;
  col: number;
}

export interface NodeConfig {
  type: NodeType;
  label?: string;
  building_id?: string;
  npc_id?: string;
}

export interface ActionConfig {
  action_id: string;
  name: string;
  description: string;
  duration_ms: number;
  result_description: string;
}

export interface BuildingConfig {
  building_id: string;
  name: string;
  description: string;
  wall_nodes: NodeId[];
  interior_nodes: NodeId[];
  door_nodes: NodeId[];
  actions: ActionConfig[];
}

export interface NpcConfig {
  npc_id: string;
  name: string;
  description: string;
  node_id: NodeId;
  actions: ActionConfig[];
}

export interface MapConfig {
  rows: number;
  cols: number;
  nodes: Partial<Record<NodeId, NodeConfig>>;
  buildings: BuildingConfig[];
  npcs: NpcConfig[];
}

export interface WorldConfig {
  name: string;
  description: string;
  skill_name: string;
}

export interface MovementConfig {
  duration_ms: number;
}

export interface ConversationConfig {
  max_turns: number;
  interval_ms: number;
  accept_timeout_ms: number;
  turn_timeout_ms: number;
}

export interface PerceptionConfig {
  range: number;
}

export interface SpawnConfig {
  nodes: NodeId[];
}

export interface IdleReminderConfig {
  interval_ms: number;
}

export interface ServerConfig {
  world: WorldConfig;
  movement: MovementConfig;
  conversation: ConversationConfig;
  perception: PerceptionConfig;
  spawn: SpawnConfig;
  map: MapConfig;
  idle_reminder?: IdleReminderConfig;
}
