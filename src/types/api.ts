import type { AgentState } from './agent.js';
import type { NodeConfig, NodeId, NodeType } from './data-model.js';
import type { WorldSnapshot } from './snapshot.js';

export type ApiErrorCode =
  | 'unauthorized'
  | 'not_joined'
  | 'invalid_request'
  | 'state_conflict'
  | 'out_of_bounds'
  | 'impassable_node'
  | 'same_node'
  | 'no_path'
  | 'action_not_found'
  | 'action_not_available'
  | 'target_not_found'
  | 'target_unavailable'
  | 'out_of_range'
  | 'conversation_not_found'
  | 'not_target'
  | 'not_your_turn'
  | 'event_not_found'
  | 'invalid_choice'
  | 'conversation_closing'
  | 'not_found'
  | 'invalid_config';

export interface ErrorResponse {
  error: ApiErrorCode;
  message: string;
  details?: unknown;
}

export class WorldError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function toErrorResponse(error: WorldError): ErrorResponse {
  return {
    error: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

export interface AdminAgentSummary {
  agent_id: string;
  agent_name: string;
  discord_bot_id: string;
  is_joined: boolean;
}

export interface AdminRegisterAgentRequest {
  agent_name: string;
  discord_bot_id: string;
}

export interface AdminRegisterAgentResponse {
  agent_id: string;
  api_key: string;
  api_base_url: string;
  mcp_endpoint: string;
}

export interface AdminAgentsResponse {
  agents: AdminAgentSummary[];
}

export interface JoinResponse {
  channel_id: string;
  node_id: NodeId;
}

export interface LeaveResponse {
  status: 'ok';
}

export interface MoveRequest {
  target_node_id: NodeId;
}

export interface MoveResponse {
  from_node_id: NodeId;
  to_node_id: NodeId;
  arrives_at: number;
}

export interface ActionRequest {
  action_id: string;
}

export interface ActionResponse {
  action_id: string;
  action_name: string;
  completes_at: number;
}

export interface WaitRequest {
  duration_ms: number;
}

export interface WaitResponse {
  completes_at: number;
}

export interface ConversationStartRequest {
  target_agent_id: string;
  message: string;
}

export interface ConversationStartResponse {
  conversation_id: string;
}

export interface ConversationAcceptRequest {
  conversation_id: string;
}

export interface ConversationRejectRequest {
  conversation_id: string;
}

export interface ConversationSpeakRequest {
  conversation_id: string;
  message: string;
}

export interface OkResponse {
  status: 'ok';
}

export interface ConversationSpeakResponse {
  turn: number;
}

export interface ServerEventSelectRequest {
  server_event_id: string;
  choice_id: string;
}

export interface AvailableActionSummary {
  action_id: string;
  name: string;
  description: string;
  duration_ms: number;
  source: {
    type: 'building' | 'npc';
    id: string;
    name: string;
  };
}

export interface AvailableActionsResponse {
  actions: AvailableActionSummary[];
}

export interface PerceptionNode {
  node_id: NodeId;
  type: NodeType;
  label?: string;
  distance: number;
}

export interface PerceptionResponse {
  current_node: {
    node_id: NodeId;
    type: NodeType;
    label?: string;
  };
  nodes: PerceptionNode[];
  agents: Array<{
    agent_id: string;
    agent_name: string;
    node_id: NodeId;
  }>;
  npcs: Array<{
    npc_id: string;
    name: string;
    node_id: NodeId;
  }>;
  buildings: Array<{
    building_id: string;
    name: string;
    door_nodes: NodeId[];
  }>;
}

export interface MapResponse {
  rows: number;
  cols: number;
  nodes: Partial<Record<NodeId, NodeConfig>>;
  buildings: unknown[];
  npcs: unknown[];
}

export interface WorldAgentsResponse {
  agents: Array<{
    agent_id: string;
    agent_name: string;
    node_id: NodeId;
    state: AgentState;
  }>;
}

export interface FireServerEventResponse {
  server_event_id: string;
}

export interface SnapshotResponse extends WorldSnapshot {}
