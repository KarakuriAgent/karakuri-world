import type { WorldEvent } from './world-event.js';

type WorldEventOfType<TType extends WorldEvent['type']> = Extract<WorldEvent, { type: TType }>;
type PersistedEventPick<TType extends WorldEvent['type'], TKeys extends keyof WorldEventOfType<TType>> = Pick<
  WorldEventOfType<TType>,
  TKeys
>;

export type PersistedSpectatorAgentLoggedInEvent = PersistedEventPick<
  'agent_logged_in',
  'type' | 'agent_id' | 'agent_name' | 'node_id'
>;
export type PersistedSpectatorAgentLoggedOutEvent = PersistedEventPick<
  'agent_logged_out',
  'type' | 'agent_id' | 'agent_name' | 'node_id' | 'cancelled_state' | 'cancelled_action_name'
>;
export type PersistedSpectatorMovementStartedEvent = PersistedEventPick<
  'movement_started',
  'type' | 'agent_id' | 'agent_name' | 'from_node_id' | 'to_node_id' | 'path' | 'arrives_at'
>;
export type PersistedSpectatorMovementCompletedEvent = PersistedEventPick<
  'movement_completed',
  'type' | 'agent_id' | 'agent_name' | 'node_id' | 'delivered_server_event_ids'
>;
export type PersistedSpectatorActionStartedEvent = PersistedEventPick<
  'action_started',
  'type' | 'agent_id' | 'agent_name' | 'action_id' | 'action_name' | 'duration_ms' | 'completes_at'
>;
export type PersistedSpectatorActionCompletedEvent = PersistedEventPick<
  'action_completed',
  'type' | 'agent_id' | 'agent_name' | 'action_id' | 'action_name'
>;
export type PersistedSpectatorActionRejectedEvent = PersistedEventPick<
  'action_rejected',
  'type' | 'agent_id' | 'agent_name' | 'action_id' | 'action_name' | 'rejection_reason'
>;
export type PersistedSpectatorWaitStartedEvent = PersistedEventPick<
  'wait_started',
  'type' | 'agent_id' | 'agent_name' | 'duration_ms' | 'completes_at'
>;
export type PersistedSpectatorWaitCompletedEvent = PersistedEventPick<
  'wait_completed',
  'type' | 'agent_id' | 'agent_name' | 'duration_ms'
>;
export type PersistedSpectatorItemUseStartedEvent = PersistedEventPick<
  'item_use_started',
  'type' | 'agent_id' | 'agent_name' | 'item_id' | 'item_name' | 'completes_at'
>;
export type PersistedSpectatorItemUseCompletedEvent = PersistedEventPick<
  'item_use_completed',
  'type' | 'agent_id' | 'agent_name' | 'item_id' | 'item_name' | 'item_type'
>;
export type PersistedSpectatorItemUseVenueRejectedEvent = PersistedEventPick<
  'item_use_venue_rejected',
  'type' | 'agent_id' | 'agent_name' | 'item_id' | 'item_name' | 'venue_hints'
>;
export type PersistedSpectatorConversationRequestedEvent = PersistedEventPick<
  'conversation_requested',
  'type' | 'conversation_id' | 'initiator_agent_id' | 'target_agent_id' | 'message'
>;
export type PersistedSpectatorConversationAcceptedEvent = PersistedEventPick<
  'conversation_accepted',
  'type' | 'conversation_id' | 'initiator_agent_id' | 'participant_agent_ids'
>;
export type PersistedSpectatorConversationRejectedEvent = PersistedEventPick<
  'conversation_rejected',
  'type' | 'conversation_id' | 'initiator_agent_id' | 'target_agent_id' | 'reason'
>;
export type PersistedSpectatorConversationMessageEvent = PersistedEventPick<
  'conversation_message',
  'type' | 'conversation_id' | 'speaker_agent_id' | 'listener_agent_ids' | 'turn' | 'message'
>;
export type PersistedSpectatorConversationJoinEvent = PersistedEventPick<
  'conversation_join',
  'type' | 'conversation_id' | 'agent_id' | 'agent_name' | 'participant_agent_ids'
>;
export type PersistedSpectatorConversationLeaveEvent = PersistedEventPick<
  'conversation_leave',
  'type' | 'conversation_id' | 'agent_id' | 'agent_name' | 'reason' | 'participant_agent_ids' | 'message' | 'next_speaker_agent_id'
>;
export type PersistedSpectatorConversationInactiveCheckEvent = PersistedEventPick<
  'conversation_inactive_check',
  'type' | 'conversation_id' | 'target_agent_ids'
>;
export type PersistedSpectatorConversationIntervalInterruptedEvent = PersistedEventPick<
  'conversation_interval_interrupted',
  'type' | 'conversation_id' | 'speaker_agent_id' | 'listener_agent_ids' | 'next_speaker_agent_id' | 'participant_agent_ids' | 'message' | 'closing'
>;
export type PersistedSpectatorConversationTurnStartedEvent = PersistedEventPick<
  'conversation_turn_started',
  'type' | 'conversation_id' | 'current_speaker_agent_id'
>;
export type PersistedSpectatorConversationClosingEvent = PersistedEventPick<
  'conversation_closing',
  'type' | 'conversation_id' | 'initiator_agent_id' | 'participant_agent_ids' | 'current_speaker_agent_id' | 'reason'
>;
export type PersistedSpectatorConversationEndedEvent = PersistedEventPick<
  'conversation_ended',
  'type' | 'conversation_id' | 'initiator_agent_id' | 'participant_agent_ids' | 'reason' | 'final_message' | 'final_speaker_agent_id'
>;
export type PersistedSpectatorConversationPendingJoinCancelledEvent = PersistedEventPick<
  'conversation_pending_join_cancelled',
  'type' | 'conversation_id' | 'agent_id' | 'reason'
>;
export type PersistedSpectatorTransferRequestedEvent = PersistedEventPick<
  'transfer_requested',
  'type' | 'transfer_id' | 'from_agent_id' | 'from_agent_name' | 'to_agent_id' | 'to_agent_name' | 'item' | 'money' | 'mode' | 'expires_at'
>;
export type PersistedSpectatorTransferAcceptedEvent = PersistedEventPick<
  'transfer_accepted',
  'type' | 'transfer_id' | 'from_agent_id' | 'from_agent_name' | 'to_agent_id' | 'to_agent_name' | 'item' | 'money' | 'mode' | 'item_granted' | 'item_dropped' | 'money_received' | 'from_money_balance' | 'to_money_balance'
>;
export type PersistedSpectatorTransferRejectedEvent = PersistedEventPick<
  'transfer_rejected',
  'type' | 'transfer_id' | 'from_agent_id' | 'from_agent_name' | 'to_agent_id' | 'to_agent_name' | 'item' | 'money' | 'mode' | 'reason'
>;
export type PersistedSpectatorTransferTimeoutEvent = PersistedEventPick<
  'transfer_timeout',
  'type' | 'transfer_id' | 'from_agent_id' | 'from_agent_name' | 'to_agent_id' | 'to_agent_name' | 'item' | 'money' | 'mode'
>;
export type PersistedSpectatorTransferCancelledEvent = PersistedEventPick<
  'transfer_cancelled',
  'type' | 'transfer_id' | 'from_agent_id' | 'from_agent_name' | 'to_agent_id' | 'to_agent_name' | 'item' | 'money' | 'mode' | 'reason'
>;
export type PersistedSpectatorTransferEscrowLostEvent = PersistedEventPick<
  'transfer_escrow_lost',
  'type' | 'transfer_id' | 'from_agent_id' | 'from_agent_name' | 'to_agent_id' | 'to_agent_name' | 'item' | 'money' | 'mode' | 'reason' | 'recovery_log_path'
>;
export type PersistedSpectatorServerEventFiredEvent = PersistedEventPick<
  'server_event_fired',
  'type' | 'server_event_id' | 'description' | 'delivered_agent_ids' | 'pending_agent_ids' | 'delayed'
>;

export type PersistedSpectatorEvent =
  | PersistedSpectatorAgentLoggedInEvent
  | PersistedSpectatorAgentLoggedOutEvent
  | PersistedSpectatorMovementStartedEvent
  | PersistedSpectatorMovementCompletedEvent
  | PersistedSpectatorActionStartedEvent
  | PersistedSpectatorActionCompletedEvent
  | PersistedSpectatorActionRejectedEvent
  | PersistedSpectatorWaitStartedEvent
  | PersistedSpectatorWaitCompletedEvent
  | PersistedSpectatorItemUseStartedEvent
  | PersistedSpectatorItemUseCompletedEvent
  | PersistedSpectatorItemUseVenueRejectedEvent
  | PersistedSpectatorConversationRequestedEvent
  | PersistedSpectatorConversationAcceptedEvent
  | PersistedSpectatorConversationRejectedEvent
  | PersistedSpectatorConversationMessageEvent
  | PersistedSpectatorConversationJoinEvent
  | PersistedSpectatorConversationLeaveEvent
  | PersistedSpectatorConversationInactiveCheckEvent
  | PersistedSpectatorConversationIntervalInterruptedEvent
  | PersistedSpectatorConversationTurnStartedEvent
  | PersistedSpectatorConversationClosingEvent
  | PersistedSpectatorConversationEndedEvent
  | PersistedSpectatorConversationPendingJoinCancelledEvent
  | PersistedSpectatorTransferRequestedEvent
  | PersistedSpectatorTransferAcceptedEvent
  | PersistedSpectatorTransferRejectedEvent
  | PersistedSpectatorTransferTimeoutEvent
  | PersistedSpectatorTransferCancelledEvent
  | PersistedSpectatorTransferEscrowLostEvent
  | PersistedSpectatorServerEventFiredEvent;

export type PersistedSpectatorEventType = PersistedSpectatorEvent['type'];

export interface EventSanitizerHooks {
  onUnknownEventType?: (eventType: string, event: Record<string, unknown>) => void;
  onUnknownFields?: (eventType: PersistedSpectatorEventType, fields: string[]) => void;
}

const PERSISTED_EVENT_FIELDS = {
  agent_logged_in: ['type', 'agent_id', 'agent_name', 'node_id'],
  agent_logged_out: ['type', 'agent_id', 'agent_name', 'node_id', 'cancelled_state', 'cancelled_action_name'],
  movement_started: ['type', 'agent_id', 'agent_name', 'from_node_id', 'to_node_id', 'path', 'arrives_at'],
  movement_completed: ['type', 'agent_id', 'agent_name', 'node_id', 'delivered_server_event_ids'],
  action_started: ['type', 'agent_id', 'agent_name', 'action_id', 'action_name', 'duration_ms', 'completes_at'],
  action_completed: ['type', 'agent_id', 'agent_name', 'action_id', 'action_name'],
  action_rejected: ['type', 'agent_id', 'agent_name', 'action_id', 'action_name', 'rejection_reason'],
  wait_started: ['type', 'agent_id', 'agent_name', 'duration_ms', 'completes_at'],
  wait_completed: ['type', 'agent_id', 'agent_name', 'duration_ms'],
  item_use_started: ['type', 'agent_id', 'agent_name', 'item_id', 'item_name', 'completes_at'],
  item_use_completed: ['type', 'agent_id', 'agent_name', 'item_id', 'item_name', 'item_type'],
  item_use_venue_rejected: ['type', 'agent_id', 'agent_name', 'item_id', 'item_name', 'venue_hints'],
  conversation_requested: ['type', 'conversation_id', 'initiator_agent_id', 'target_agent_id', 'message'],
  conversation_accepted: ['type', 'conversation_id', 'initiator_agent_id', 'participant_agent_ids'],
  conversation_rejected: ['type', 'conversation_id', 'initiator_agent_id', 'target_agent_id', 'reason'],
  conversation_message: ['type', 'conversation_id', 'speaker_agent_id', 'listener_agent_ids', 'turn', 'message'],
  conversation_join: ['type', 'conversation_id', 'agent_id', 'agent_name', 'participant_agent_ids'],
  conversation_leave: [
    'type',
    'conversation_id',
    'agent_id',
    'agent_name',
    'reason',
    'participant_agent_ids',
    'message',
    'next_speaker_agent_id',
  ],
  conversation_inactive_check: ['type', 'conversation_id', 'target_agent_ids'],
  conversation_interval_interrupted: [
    'type',
    'conversation_id',
    'speaker_agent_id',
    'listener_agent_ids',
    'next_speaker_agent_id',
    'participant_agent_ids',
    'message',
    'closing',
  ],
  conversation_turn_started: ['type', 'conversation_id', 'current_speaker_agent_id'],
  conversation_closing: [
    'type',
    'conversation_id',
    'initiator_agent_id',
    'participant_agent_ids',
    'current_speaker_agent_id',
    'reason',
  ],
  conversation_ended: [
    'type',
    'conversation_id',
    'initiator_agent_id',
    'participant_agent_ids',
    'reason',
    'final_message',
    'final_speaker_agent_id',
  ],
  conversation_pending_join_cancelled: ['type', 'conversation_id', 'agent_id', 'reason'],
  transfer_requested: ['type', 'transfer_id', 'from_agent_id', 'from_agent_name', 'to_agent_id', 'to_agent_name', 'item', 'money', 'mode', 'expires_at'],
  transfer_accepted: ['type', 'transfer_id', 'from_agent_id', 'from_agent_name', 'to_agent_id', 'to_agent_name', 'item', 'money', 'mode', 'item_granted', 'item_dropped', 'money_received', 'from_money_balance', 'to_money_balance'],
  transfer_rejected: ['type', 'transfer_id', 'from_agent_id', 'from_agent_name', 'to_agent_id', 'to_agent_name', 'item', 'money', 'mode', 'reason'],
  transfer_timeout: ['type', 'transfer_id', 'from_agent_id', 'from_agent_name', 'to_agent_id', 'to_agent_name', 'item', 'money', 'mode'],
  transfer_cancelled: ['type', 'transfer_id', 'from_agent_id', 'from_agent_name', 'to_agent_id', 'to_agent_name', 'item', 'money', 'mode', 'reason'],
  transfer_escrow_lost: ['type', 'transfer_id', 'from_agent_id', 'from_agent_name', 'to_agent_id', 'to_agent_name', 'item', 'money', 'mode', 'reason', 'recovery_log_path'],
  server_event_fired: ['type', 'server_event_id', 'description', 'delivered_agent_ids', 'pending_agent_ids', 'delayed'],
} as const satisfies Record<PersistedSpectatorEventType, readonly string[]>;

export const PERSISTED_SPECTATOR_EVENT_TYPES = Object.freeze(
  Object.keys(PERSISTED_EVENT_FIELDS) as PersistedSpectatorEventType[],
);

const PERSISTED_EVENT_TYPES = new Set<PersistedSpectatorEventType>(PERSISTED_SPECTATOR_EVENT_TYPES);
const EVENT_METADATA_FIELDS = new Set(['event_id', 'occurred_at']);

export function isPersistedSpectatorEventType(value: string): value is PersistedSpectatorEventType {
  return PERSISTED_EVENT_TYPES.has(value as PersistedSpectatorEventType);
}

function sanitizeWithHooks(event: WorldEvent, hooks?: EventSanitizerHooks): PersistedSpectatorEvent | null {
  if (!PERSISTED_EVENT_TYPES.has(event.type as PersistedSpectatorEventType)) {
    hooks?.onUnknownEventType?.(String(event.type), event as unknown as Record<string, unknown>);
    return null;
  }

  const eventType = event.type as PersistedSpectatorEventType;
  const allowedFields = PERSISTED_EVENT_FIELDS[eventType];
  const knownFields = new Set<string>([...allowedFields, ...EVENT_METADATA_FIELDS]);
  const unknownFields = Object.keys(event).filter((field) => !knownFields.has(field));

  if (unknownFields.length > 0) {
    hooks?.onUnknownFields?.(eventType, unknownFields);
  }

  const sanitizedEntries = allowedFields.flatMap((field) => {
    const value = event[field as keyof typeof event];
    return value === undefined ? [] : [[field, value] as const];
  });

  return Object.fromEntries(sanitizedEntries) as PersistedSpectatorEvent;
}

export function sanitize(event: WorldEvent): PersistedSpectatorEvent | null {
  return sanitizeWithHooks(event);
}

export function createEventSanitizer(hooks: EventSanitizerHooks) {
  return (event: WorldEvent): PersistedSpectatorEvent | null => sanitizeWithHooks(event, hooks);
}
