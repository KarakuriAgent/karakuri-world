import type { NodeId } from './data-model.js';

export type AgentState = 'idle' | 'moving' | 'in_action' | 'in_conversation';

export interface AgentItem {
  item_id: string;
  quantity: number;
}

export interface AgentRegistration {
  agent_id: string;
  agent_name: string;
  api_key: string;
  discord_bot_avatar_url?: string;
  created_at: number;
  discord_channel_id?: string;
  last_node_id?: NodeId;
  money?: number;
  items?: AgentItem[];
}

export interface LoggedInAgent {
  agent_id: string;
  agent_name: string;
  node_id: NodeId;
  state: AgentState;
  discord_channel_id: string;
  pending_conversation_id: string | null;
  current_conversation_id: string | null;
  pending_server_event_ids: string[];
  active_server_event_id: string | null;
  /** 通常のクールダウン対象となる直前の action_id */
  last_action_id: string | null;
  /** reject 後の次回 choices だけで一時除外する action_id */
  last_rejected_action_id: string | null;
  last_used_item_id: string | null;
  money: number;
  items: AgentItem[];
}
