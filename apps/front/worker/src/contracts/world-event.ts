import type { AgentState, NodeId } from './world-snapshot.js';
import type { EventType as BackendEventType } from '../../../../server/src/types/event.js';

export type ItemType = 'general' | 'food' | 'drink' | 'venue';
export type ConversationRejectionReason = 'rejected' | 'timeout' | 'target_logged_out' | 'server_event';
export type ConversationClosureReason =
  | 'max_turns'
  | 'turn_timeout'
  | 'server_event'
  | 'ended_by_agent'
  | 'participant_logged_out';
export type PendingJoinCancelReason = ConversationClosureReason | 'agent_unavailable';
export type TransferMode = 'standalone' | 'in_conversation';
export type TransferRejectReason =
  | { kind: 'rejected_by_receiver' }
  | { kind: 'unanswered_speak' }
  | { kind: 'inventory_full'; dropped: ReadonlyArray<AgentItem> };
export type TransferCancelReason =
  | 'server_event'
  | 'sender_logged_out'
  | 'receiver_logged_out'
  | 'conversation_closing'
  | 'error';

export interface AgentItem {
  item_id: string;
  quantity: number;
  [key: string]: unknown;
}

export type EventType =
  | 'agent_logged_in'
  | 'agent_logged_out'
  | 'movement_started'
  | 'movement_completed'
  | 'action_started'
  | 'action_completed'
  | 'action_rejected'
  | 'wait_started'
  | 'wait_completed'
  | 'item_use_started'
  | 'item_use_completed'
  | 'item_use_venue_rejected'
  | 'conversation_requested'
  | 'conversation_accepted'
  | 'conversation_rejected'
  | 'conversation_message'
  | 'conversation_join'
  | 'conversation_leave'
  | 'conversation_inactive_check'
  | 'conversation_interval_interrupted'
  | 'conversation_turn_started'
  | 'conversation_closing'
  | 'conversation_ended'
  | 'conversation_pending_join_cancelled'
  | 'transfer_requested'
  | 'transfer_accepted'
  | 'transfer_rejected'
  | 'transfer_timeout'
  | 'transfer_cancelled'
  | 'transfer_escrow_lost'
  | 'server_event_fired'
  | 'idle_reminder_fired'
  | 'map_info_requested'
  | 'world_agents_info_requested'
  | 'perception_requested'
  | 'available_actions_requested';

type _BackendWorkerEventTypeParity = [Exclude<BackendEventType, EventType>, Exclude<EventType, BackendEventType>] extends [
  never,
  never,
]
  ? true
  : never;
const _backendWorkerEventTypeParity: _BackendWorkerEventTypeParity = true;

export interface EventBase {
  event_id: string;
  type: EventType;
  occurred_at: number;
}

export interface AgentLoggedInEvent extends EventBase {
  type: 'agent_logged_in';
  agent_id: string;
  agent_name: string;
  node_id: NodeId;
  discord_channel_id: string;
}

export interface AgentLoggedOutEvent extends EventBase {
  type: 'agent_logged_out';
  agent_id: string;
  agent_name: string;
  node_id: NodeId;
  discord_channel_id: string;
  cancelled_state: AgentState;
  cancelled_action_name?: string;
}

export interface MovementStartedEvent extends EventBase {
  type: 'movement_started';
  agent_id: string;
  agent_name: string;
  from_node_id: NodeId;
  to_node_id: NodeId;
  path: NodeId[];
  arrives_at: number;
}

export interface MovementCompletedEvent extends EventBase {
  type: 'movement_completed';
  agent_id: string;
  agent_name: string;
  node_id: NodeId;
  delivered_server_event_ids: string[];
}

export interface ActionStartedEvent extends EventBase {
  type: 'action_started';
  agent_id: string;
  agent_name: string;
  action_id: string;
  action_name: string;
  duration_ms: number;
  completes_at: number;
  cost_money?: number;
  items_consumed?: AgentItem[];
}

export interface ActionCompletedEvent extends EventBase {
  type: 'action_completed';
  agent_id: string;
  agent_name: string;
  action_id: string;
  action_name: string;
  cost_money?: number;
  reward_money?: number;
  money_balance?: number;
  items_granted?: AgentItem[];
  items_dropped?: AgentItem[];
}

export interface ActionRejectedEvent extends EventBase {
  type: 'action_rejected';
  agent_id: string;
  agent_name: string;
  action_id: string;
  action_name: string;
  rejection_reason: string;
}

export interface WaitStartedEvent extends EventBase {
  type: 'wait_started';
  agent_id: string;
  agent_name: string;
  duration_ms: number;
  completes_at: number;
}

export interface WaitCompletedEvent extends EventBase {
  type: 'wait_completed';
  agent_id: string;
  agent_name: string;
  duration_ms: number;
}

export interface ItemUseStartedEvent extends EventBase {
  type: 'item_use_started';
  agent_id: string;
  agent_name: string;
  item_id: string;
  item_name: string;
  completes_at: number;
}

export interface ItemUseCompletedEvent extends EventBase {
  type: 'item_use_completed';
  agent_id: string;
  agent_name: string;
  item_id: string;
  item_name: string;
  item_type: ItemType;
}

export interface ItemUseVenueRejectedEvent extends EventBase {
  type: 'item_use_venue_rejected';
  agent_id: string;
  agent_name: string;
  item_id: string;
  item_name: string;
  venue_hints: string[];
}

export interface ConversationRequestedEvent extends EventBase {
  type: 'conversation_requested';
  conversation_id: string;
  initiator_agent_id: string;
  target_agent_id: string;
  message: string;
}

export interface ConversationAcceptedEvent extends EventBase {
  type: 'conversation_accepted';
  conversation_id: string;
  initiator_agent_id: string;
  participant_agent_ids: string[];
}

export interface ConversationRejectedEvent extends EventBase {
  type: 'conversation_rejected';
  conversation_id: string;
  initiator_agent_id: string;
  target_agent_id: string;
  reason: ConversationRejectionReason;
}

export interface ConversationMessageEvent extends EventBase {
  type: 'conversation_message';
  conversation_id: string;
  speaker_agent_id: string;
  listener_agent_ids: string[];
  turn: number;
  message: string;
}

export interface ConversationJoinEvent extends EventBase {
  type: 'conversation_join';
  conversation_id: string;
  agent_id: string;
  agent_name: string;
  participant_agent_ids: string[];
}

export interface ConversationLeaveEvent extends EventBase {
  type: 'conversation_leave';
  conversation_id: string;
  agent_id: string;
  agent_name: string;
  reason: 'voluntary' | 'inactive' | 'logged_out' | 'server_event';
  participant_agent_ids: string[];
  message?: string;
  next_speaker_agent_id?: string;
}

export interface ConversationInactiveCheckEvent extends EventBase {
  type: 'conversation_inactive_check';
  conversation_id: string;
  target_agent_ids: string[];
}

export interface ConversationIntervalInterruptedEvent extends EventBase {
  type: 'conversation_interval_interrupted';
  conversation_id: string;
  speaker_agent_id: string;
  listener_agent_ids: string[];
  next_speaker_agent_id: string;
  participant_agent_ids: string[];
  message: string;
  closing: boolean;
}

export interface ConversationTurnStartedEvent extends EventBase {
  type: 'conversation_turn_started';
  conversation_id: string;
  current_speaker_agent_id: string;
}

export interface ConversationClosingEvent extends EventBase {
  type: 'conversation_closing';
  conversation_id: string;
  initiator_agent_id: string;
  participant_agent_ids: string[];
  current_speaker_agent_id: string;
  reason: Extract<ConversationClosureReason, 'ended_by_agent' | 'max_turns' | 'server_event'>;
}

export interface ConversationEndedEvent extends EventBase {
  type: 'conversation_ended';
  conversation_id: string;
  initiator_agent_id: string;
  participant_agent_ids: string[];
  reason: ConversationClosureReason;
  final_message?: string;
  final_speaker_agent_id?: string;
}

export interface ConversationPendingJoinCancelledEvent extends EventBase {
  type: 'conversation_pending_join_cancelled';
  conversation_id: string;
  agent_id: string;
  reason: PendingJoinCancelReason;
}

interface TransferEventBase extends EventBase {
  transfer_id: string;
  from_agent_id: string;
  from_agent_name: string;
  to_agent_id: string;
  to_agent_name: string;
  items: ReadonlyArray<AgentItem>;
  money: number;
  mode: TransferMode;
}

export interface TransferRequestedEvent extends TransferEventBase {
  type: 'transfer_requested';
  expires_at: number;
}

export interface TransferAcceptedEvent extends TransferEventBase {
  type: 'transfer_accepted';
  items_granted: ReadonlyArray<AgentItem>;
  items_dropped: ReadonlyArray<AgentItem>;
  money_received: number;
  from_money_balance?: number;
  to_money_balance: number;
}

export interface TransferRejectedEvent extends TransferEventBase {
  type: 'transfer_rejected';
  reason: TransferRejectReason;
}

export interface TransferTimeoutEvent extends TransferEventBase {
  type: 'transfer_timeout';
}

export interface TransferCancelledEvent extends TransferEventBase {
  type: 'transfer_cancelled';
  reason: TransferCancelReason;
}

export interface TransferEscrowLostEvent extends TransferEventBase {
  type: 'transfer_escrow_lost';
  reason: 'registration_writeback_failed' | 'startup_recovery_failed';
  recovery_log_path?: string;
}

export interface ServerEventFiredEvent extends EventBase {
  type: 'server_event_fired';
  server_event_id: string;
  description: string;
  delivered_agent_ids: string[];
  pending_agent_ids: string[];
  delayed: boolean;
}

export interface IdleReminderFiredEvent extends EventBase {
  type: 'idle_reminder_fired';
  agent_id: string;
  agent_name: string;
  idle_since: number;
}

export interface MapInfoRequestedEvent extends EventBase {
  type: 'map_info_requested';
  agent_id: string;
}

export interface WorldAgentsInfoRequestedEvent extends EventBase {
  type: 'world_agents_info_requested';
  agent_id: string;
}

export interface PerceptionRequestedEvent extends EventBase {
  type: 'perception_requested';
  agent_id: string;
}

export interface AvailableActionsRequestedEvent extends EventBase {
  type: 'available_actions_requested';
  agent_id: string;
}

export type WorldEvent =
  | AgentLoggedInEvent
  | AgentLoggedOutEvent
  | MovementStartedEvent
  | MovementCompletedEvent
  | ActionStartedEvent
  | ActionCompletedEvent
  | ActionRejectedEvent
  | WaitStartedEvent
  | WaitCompletedEvent
  | ItemUseStartedEvent
  | ItemUseCompletedEvent
  | ItemUseVenueRejectedEvent
  | ConversationRequestedEvent
  | ConversationAcceptedEvent
  | ConversationRejectedEvent
  | ConversationMessageEvent
  | ConversationJoinEvent
  | ConversationLeaveEvent
  | ConversationInactiveCheckEvent
  | ConversationIntervalInterruptedEvent
  | ConversationTurnStartedEvent
  | ConversationClosingEvent
  | ConversationEndedEvent
  | ConversationPendingJoinCancelledEvent
  | TransferRequestedEvent
  | TransferAcceptedEvent
  | TransferRejectedEvent
  | TransferTimeoutEvent
  | TransferCancelledEvent
  | TransferEscrowLostEvent
  | ServerEventFiredEvent
  | IdleReminderFiredEvent
  | MapInfoRequestedEvent
  | WorldAgentsInfoRequestedEvent
  | PerceptionRequestedEvent
  | AvailableActionsRequestedEvent;
