import type { ItemType, NodeId } from './data-model.js';

export type TimerType =
  | 'movement'
  | 'action'
  | 'wait'
  | 'item_use'
  | 'conversation_accept'
  | 'conversation_turn'
  | 'conversation_interval'
  | 'conversation_inactive_check'
  | 'idle_reminder'
  | 'transfer';

export interface TimerBase {
  timer_id: string;
  type: TimerType;
  agent_ids: string[];
  created_at: number;
  fires_at: number;
}

export interface MovementTimer extends TimerBase {
  type: 'movement';
  agent_id: string;
  from_node_id: NodeId;
  to_node_id: NodeId;
  path: NodeId[];
}

export interface ActionTimer extends TimerBase {
  type: 'action';
  agent_id: string;
  action_id: string;
  action_name: string;
  duration_ms: number;
}

export interface WaitTimer extends TimerBase {
  type: 'wait';
  agent_id: string;
  duration_ms: number;
}

export interface ItemUseTimer extends TimerBase {
  type: 'item_use';
  agent_id: string;
  item_id: string;
  item_name: string;
  item_type: ItemType;
}

export interface ConversationAcceptTimer extends TimerBase {
  type: 'conversation_accept';
  conversation_id: string;
  initiator_agent_id: string;
  target_agent_id: string;
}

export interface ConversationTurnTimer extends TimerBase {
  type: 'conversation_turn';
  conversation_id: string;
  current_speaker_agent_id: string;
}

export interface ConversationIntervalTimer extends TimerBase {
  type: 'conversation_interval';
  conversation_id: string;
  speaker_agent_id: string;
  listener_agent_ids: string[];
  next_speaker_agent_id: string;
  turn: number;
  message: string;
}

export interface ConversationInactiveCheckTimer extends TimerBase {
  type: 'conversation_inactive_check';
  conversation_id: string;
  target_agent_ids: string[];
}

export interface IdleReminderTimer extends TimerBase {
  type: 'idle_reminder';
  agent_id: string;
  idle_since: number;
}

export interface TransferTimer extends TimerBase {
  type: 'transfer';
  transfer_id: string;
  from_agent_id: string;
  to_agent_id: string;
  agent_ids: [string, string];
}

export type Timer =
  | MovementTimer
  | ActionTimer
  | WaitTimer
  | ItemUseTimer
  | ConversationAcceptTimer
  | ConversationTurnTimer
  | ConversationIntervalTimer
  | ConversationInactiveCheckTimer
  | IdleReminderTimer
  | TransferTimer;
