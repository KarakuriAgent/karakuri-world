import type { AgentItem, AgentState } from './agent.js';
import type { ConversationClosureReason, ConversationRejectionReason } from './conversation.js';
import type { ItemType, NodeId } from './data-model.js';

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
  | 'conversation_closing'
  | 'conversation_ended'
  | 'server_event_fired'
  | 'idle_reminder_fired'
  | 'map_info_requested'
  | 'world_agents_info_requested'
  | 'perception_requested'
  | 'available_actions_requested';

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
  target_agent_id: string;
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
  listener_agent_id: string;
  turn: number;
  message: string;
}

export interface ConversationClosingEvent extends EventBase {
  type: 'conversation_closing';
  conversation_id: string;
  initiator_agent_id: string;
  target_agent_id: string;
  current_speaker_agent_id: string;
  reason: Extract<ConversationClosureReason, 'ended_by_agent' | 'max_turns' | 'server_event'>;
}

export interface ConversationEndedEvent extends EventBase {
  type: 'conversation_ended';
  conversation_id: string;
  initiator_agent_id: string;
  target_agent_id: string;
  reason: ConversationClosureReason;
  final_message?: string;
  final_speaker_agent_id?: string;
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
  | ConversationClosingEvent
  | ConversationEndedEvent
  | ServerEventFiredEvent
  | IdleReminderFiredEvent
  | MapInfoRequestedEvent
  | WorldAgentsInfoRequestedEvent
  | PerceptionRequestedEvent
  | AvailableActionsRequestedEvent;
