import type { AgentState } from './agent.js';
import type { ConversationClosureReason, ConversationStatus } from './conversation.js';
import type { MapConfig, NodeId, WorldConfig } from './data-model.js';
import type { ServerEventChoiceConfig } from './server-event.js';

export interface AgentSnapshot {
  agent_id: string;
  agent_name: string;
  node_id: NodeId;
  state: AgentState;
  discord_channel_id: string;
  avatar_url?: string;
  movement?: {
    from_node_id: NodeId;
    to_node_id: NodeId;
    path: NodeId[];
    arrives_at: number;
  };
}

export interface ConversationSnapshot {
  conversation_id: string;
  status: ConversationStatus;
  initiator_agent_id: string;
  target_agent_id: string;
  current_turn: number;
  current_speaker_agent_id: string;
  closing_reason?: ConversationClosureReason;
}

export interface ServerEventSnapshot {
  server_event_id: string;
  event_id: string;
  name: string;
  description: string;
  choices: ServerEventChoiceConfig[];
  delivered_agent_ids: string[];
  pending_agent_ids: string[];
}

export interface WorldSnapshot {
  world: WorldConfig;
  map: MapConfig;
  agents: AgentSnapshot[];
  conversations: ConversationSnapshot[];
  server_events: ServerEventSnapshot[];
  generated_at: number;
}
