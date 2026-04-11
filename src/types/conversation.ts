export type ConversationStatus = 'pending' | 'active' | 'closing';

export type ConversationRejectionReason = 'rejected' | 'timeout' | 'target_logged_out' | 'server_event';

export type ConversationClosureReason =
  | 'max_turns'
  | 'turn_timeout'
  | 'server_event'
  | 'ended_by_agent'
  | 'participant_logged_out';

export type PendingJoinCancelReason = ConversationClosureReason | 'agent_unavailable';

export interface ConversationData {
  conversation_id: string;
  status: ConversationStatus;
  initiator_agent_id: string;
  participant_agent_ids: string[];
  pending_participant_agent_ids: string[];
  current_turn: number;
  current_speaker_agent_id: string;
  initial_message: string;
  last_spoken_turns: Record<string, number>;
  inactive_check_pending_agent_ids: string[];
  resume_speaker_agent_id: string | null;
  closing_reason?: ConversationClosureReason;
}
