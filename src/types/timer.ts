import type { NodeId } from './data-model.js';

export type TimerType =
  | 'movement'
  | 'action'
  | 'wait'
  | 'conversation_accept'
  | 'conversation_turn'
  | 'conversation_interval'
  | 'server_event_timeout';

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
}

export interface WaitTimer extends TimerBase {
  type: 'wait';
  agent_id: string;
  duration_ms: number;
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
  listener_agent_id: string;
  turn: number;
  message: string;
}

export interface ServerEventTimeoutTimer extends TimerBase {
  type: 'server_event_timeout';
  agent_id: string;
  server_event_id: string;
  event_id: string;
}

export type Timer =
  | MovementTimer
  | ActionTimer
  | WaitTimer
  | ConversationAcceptTimer
  | ConversationTurnTimer
  | ConversationIntervalTimer
  | ServerEventTimeoutTimer;
