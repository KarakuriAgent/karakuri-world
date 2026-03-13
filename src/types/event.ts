import type { NodeId } from './data-model.js';
import type { ConversationClosureReason, ConversationRejectionReason } from './conversation.js';
import type { ServerEventChoiceConfig } from './server-event.js';

export type EventType =
  | 'agent_joined'
  | 'agent_left'
  | 'movement_started'
  | 'movement_completed'
  | 'action_started'
  | 'action_completed'
  | 'conversation_requested'
  | 'conversation_accepted'
  | 'conversation_rejected'
  | 'conversation_message'
  | 'conversation_ended'
  | 'server_event_fired'
  | 'server_event_selected';

export interface EventBase {
  event_id: string;
  type: EventType;
  occurred_at: number;
}

export interface AgentJoinedEvent extends EventBase {
  type: 'agent_joined';
  agent_id: string;
  agent_name: string;
  node_id: NodeId;
  discord_channel_id: string;
}

export interface AgentLeftEvent extends EventBase {
  type: 'agent_left';
  agent_id: string;
  agent_name: string;
  node_id: NodeId;
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
}

export interface ActionCompletedEvent extends EventBase {
  type: 'action_completed';
  agent_id: string;
  agent_name: string;
  action_id: string;
  action_name: string;
  result_description: string;
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
  event_id_ref: string;
  name: string;
  description: string;
  choices: ServerEventChoiceConfig[];
  delivered_agent_ids: string[];
  pending_agent_ids: string[];
  delayed: boolean;
}

export interface ServerEventSelectedEvent extends EventBase {
  type: 'server_event_selected';
  server_event_id: string;
  event_id_ref: string;
  name: string;
  agent_id: string;
  choice_id: string;
  choice_label: string;
  source_state: 'idle' | 'in_action' | 'in_conversation';
}

export type WorldEvent =
  | AgentJoinedEvent
  | AgentLeftEvent
  | MovementStartedEvent
  | MovementCompletedEvent
  | ActionStartedEvent
  | ActionCompletedEvent
  | ConversationRequestedEvent
  | ConversationAcceptedEvent
  | ConversationRejectedEvent
  | ConversationMessageEvent
  | ConversationEndedEvent
  | ServerEventFiredEvent
  | ServerEventSelectedEvent;
