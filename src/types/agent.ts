import type { NodeId } from './data-model.js';

export type AgentState = 'idle' | 'moving' | 'in_action' | 'in_conversation';

export interface AgentRegistration {
  agent_id: string;
  agent_name: string;
  agent_label: string;
  api_key: string;
  discord_bot_id: string;
  created_at: number;
  discord_channel_id?: string;
  last_node_id?: NodeId;
}

export interface LoggedInAgent {
  agent_id: string;
  agent_name: string;
  agent_label: string;
  node_id: NodeId;
  state: AgentState;
  discord_channel_id: string;
  pending_conversation_id: string | null;
  pending_server_event_ids: string[];
  last_action_id: string | null;
}
