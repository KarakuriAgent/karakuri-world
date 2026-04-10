import type { AgentItem, AgentState } from './agent.js';
import type { ConversationClosureReason, ConversationStatus } from './conversation.js';
import type { MapConfig, NodeId, WorldConfig } from './data-model.js';

export type AgentActivitySnapshot =
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
    };

export interface SnapshotWeather {
  condition: string;
  temperature_celsius: number;
}

export interface AgentSnapshot {
  agent_id: string;
  agent_name: string;
  node_id: NodeId;
  state: AgentState;
  discord_channel_id: string;
  money: number;
  items: AgentItem[];
  movement?: {
    from_node_id: NodeId;
    to_node_id: NodeId;
    path: NodeId[];
    arrives_at: number;
  };
  current_activity?: AgentActivitySnapshot;
}

export interface ConversationSnapshot {
  conversation_id: string;
  status: ConversationStatus;
  initiator_agent_id: string;
  participant_agent_ids: string[];
  current_turn: number;
  max_turns: number;
  max_participants: number;
  current_speaker_agent_id: string;
  actionable_speaker_agent_id: string;
  closing_reason?: ConversationClosureReason;
}

export interface ServerEventSnapshot {
  server_event_id: string;
  description: string;
  delivered_agent_ids: string[];
  pending_agent_ids: string[];
}

export interface WorldSnapshot {
  world: WorldConfig;
  map: MapConfig;
  weather?: SnapshotWeather;
  agents: AgentSnapshot[];
  conversations: ConversationSnapshot[];
  server_events: ServerEventSnapshot[];
  generated_at: number;
}
