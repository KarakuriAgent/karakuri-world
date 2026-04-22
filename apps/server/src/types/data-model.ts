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

export interface Hours {
  open: string;
  close: string;
}

export interface ItemRequirement {
  item_id: string;
  quantity: number;
}

interface ActionConfigBase {
  action_id: string;
  name: string;
  description: string;
  emoji?: string;
  hours?: Hours;
  cost_money?: number;
  reward_money?: number;
  required_items?: ItemRequirement[];
  reward_items?: ItemRequirement[];
}

export interface FixedDurationActionConfig extends ActionConfigBase {
  duration_ms: number;
  min_duration_minutes?: never;
  max_duration_minutes?: never;
}

export interface RangeDurationActionConfig extends ActionConfigBase {
  duration_ms?: never;
  min_duration_minutes: number;
  max_duration_minutes: number;
}

export type ActionConfig = FixedDurationActionConfig | RangeDurationActionConfig;

export interface BuildingConfig {
  building_id: string;
  name: string;
  description: string;
  wall_nodes: NodeId[];
  interior_nodes: NodeId[];
  door_nodes: NodeId[];
  actions: ActionConfig[];
  hours?: Hours;
}

export interface NpcConfig {
  npc_id: string;
  name: string;
  description: string;
  node_id: NodeId;
  actions: ActionConfig[];
  hours?: Hours;
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
  max_participants: number;
  inactive_check_turns: number;
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

export interface WeatherLocation {
  latitude: number;
  longitude: number;
}

export interface WeatherConfig {
  location: WeatherLocation;
  interval_ms: number;
}

export interface EconomyConfig {
  initial_money?: number;
  max_inventory_slots?: number;
  item_use_duration_ms?: number;
}

export type ItemType = 'general' | 'food' | 'drink' | 'venue';

export interface ItemConfig {
  item_id: string;
  name: string;
  description: string;
  type: ItemType;
  stackable: boolean;
  max_stack?: number;
}

export interface ServerConfig {
  world: WorldConfig;
  timezone: string;
  movement: MovementConfig;
  conversation: ConversationConfig;
  perception: PerceptionConfig;
  spawn: SpawnConfig;
  map: MapConfig;
  idle_reminder?: IdleReminderConfig;
  weather?: WeatherConfig;
  economy?: EconomyConfig;
  items?: ItemConfig[];
}
