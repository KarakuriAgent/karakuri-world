import type { AgentItem, AgentState } from './agent.js';
import type { NodeId, NodeType } from './data-model.js';
import type { ServerEvent } from './server-event.js';
import type { WorldSnapshot } from './snapshot.js';

export type ApiErrorCode =
  | 'unauthorized'
  | 'service_unavailable'
  | 'not_logged_in'
  | 'invalid_request'
  | 'state_conflict'
  | 'info_already_consumed'
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
  | 'conversation_closing'
  | 'conversation_full'
  | 'invalid_next_speaker'
  | 'next_speaker_required'
  | 'cannot_nominate_self'
  | 'not_found'
  | 'already_cleared'
  | 'invalid_config'
  | 'validation_error'
  | 'transfer_role_conflict'
  | 'transfer_already_settled'
  | 'transfer_refund_failed';

export type TransferRoleConflictReason =
  | 'sender_active_transfer_id_set'
  | 'sender_pending_transfer_id_set'
  | 'receiver_active_transfer_id_set'
  | 'receiver_pending_transfer_id_set';

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
  is_logged_in: boolean;
}

export interface AdminRegisterAgentRequest {
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

export interface LoginResponse {
  channel_id: string;
  node_id: NodeId;
}

export interface LogoutResponse {
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
  duration_minutes?: number;
}

export interface UseItemRequest {
  item_id: string;
}

export interface WaitRequest {
  duration: number;
}

export interface WaitResponse {
  completes_at: number;
}

/**
 * 譲渡時の payload。
 * - `item` を指定する場合: `{ item: { item_id, quantity } }`（quantity は正の整数）
 * - `money` を指定する場合: `{ money: 正の整数 }`
 * `item` と `money` は排他で、どちらか一方のみ。
 */
export type TransferAttachment =
  | { item: { item_id: string; quantity: number }; money?: undefined }
  | { item?: undefined; money: number };

export type TransferRequest = TransferAttachment & {
  target_agent_id: string;
};

export interface ConversationStartRequest {
  target_agent_id: string;
  message: string;
}

export interface ConversationJoinRequest {
  conversation_id: string;
}

export interface ConversationLeaveRequest {
  message?: string;
}

export interface ConversationStartResponse {
  conversation_id: string;
}

export interface ConversationAcceptRequest {
  message: string;
}

export interface ConversationSpeakRequest {
  message: string;
  next_speaker_agent_id: string;
  transfer?: TransferAttachment;
  transfer_response?: 'accept' | 'reject';
}

export interface ConversationEndRequest {
  message: string;
  next_speaker_agent_id: string;
  transfer_response?: 'accept' | 'reject';
}

export interface OkResponse {
  status: 'ok';
}

export interface NotificationAcceptedResponse {
  ok: true;
  message: string;
}

export const NOTIFICATION_ACCEPTED_MESSAGE = '正常に受け付けました。結果が通知されるまで待機してください。';

export function createNotificationAcceptedResponse(): NotificationAcceptedResponse {
  return {
    ok: true,
    message: NOTIFICATION_ACCEPTED_MESSAGE,
  };
}

export type TransferFailureReason =
  | 'persist_failed'
  | 'role_conflict'
  | 'overflow_inventory_full'
  | 'overflow_money'
  | 'validation_failed';

export interface ConversationSpeakResponse {
  turn: number;
  transfer_status?: 'pending' | 'completed' | 'rejected' | 'failed';
  transfer_id?: string;
  failure_reason?: TransferFailureReason;
}

export interface TransferActionResponse extends NotificationAcceptedResponse {
  transfer_status: 'pending' | 'completed' | 'rejected' | 'failed';
  transfer_id?: string;
  failure_reason?: TransferFailureReason;
}

export interface FireServerAnnouncementRequest {
  description: string;
}

export interface PerceptionNode {
  node_id: NodeId;
  type: NodeType;
  label?: string;
  distance: number;
}

export interface PerceptionItem {
  item_id: string;
  name: string;
  quantity: number;
}

export interface PerceptionWeather {
  condition: string;
  temperature_celsius: number;
}

export interface PerceptionResponse {
  world_time: string;
  weather?: PerceptionWeather;
  money: number;
  items: PerceptionItem[];
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

export interface WorldAgentsResponse {
  agents: Array<{
    agent_id: string;
    agent_name: string;
    node_id: NodeId;
    state: AgentState;
  }>;
}

export interface FireServerAnnouncementResponse {
  server_announcement_id: string;
}

export interface CreateServerEventRequest {
  description: string;
}

export interface CreateServerEventResponse {
  server_event_id: string;
}

export interface ListServerEventsResponse {
  events: ServerEvent[];
}

export interface SnapshotResponse extends WorldSnapshot {}
