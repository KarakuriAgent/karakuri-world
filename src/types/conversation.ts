export type ConversationStatus = 'pending' | 'active' | 'closing';

export type ConversationRejectionReason = 'rejected' | 'timeout' | 'target_logged_out' | 'server_event';

export type ConversationClosureReason =
  | 'max_turns'
  | 'turn_timeout'
  | 'server_event'
  | 'ended_by_agent'
  | 'partner_logged_out';

export interface ConversationData {
  conversation_id: string;
  status: ConversationStatus;
  initiator_agent_id: string;
  target_agent_id: string;
  current_turn: number;
  current_speaker_agent_id: string;
  initial_message: string;
  closing_reason?: ConversationClosureReason;
}
