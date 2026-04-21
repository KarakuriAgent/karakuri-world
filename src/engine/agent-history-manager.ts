import type { EventType, WorldEvent } from '../types/event.js';

export interface AgentHistoryManagerLogger {
  error(message: string, context?: Record<string, unknown>): void;
}

export interface HistorySummary {
  emoji: string;
  title: string;
  text: string;
}

export type PersistedHistoryDetail =
  | Pick<Extract<WorldEvent, { type: 'agent_logged_in' }>, 'type' | 'agent_id' | 'agent_name' | 'node_id'>
  | Pick<Extract<WorldEvent, { type: 'agent_logged_out' }>, 'type' | 'agent_id' | 'agent_name' | 'node_id' | 'cancelled_state' | 'cancelled_action_name'>
  | Pick<Extract<WorldEvent, { type: 'movement_started' }>, 'type' | 'agent_id' | 'agent_name' | 'from_node_id' | 'to_node_id' | 'path' | 'arrives_at'>
  | Pick<Extract<WorldEvent, { type: 'movement_completed' }>, 'type' | 'agent_id' | 'agent_name' | 'node_id' | 'delivered_server_event_ids'>
  | Pick<Extract<WorldEvent, { type: 'action_started' }>, 'type' | 'agent_id' | 'agent_name' | 'action_id' | 'action_name' | 'duration_ms' | 'completes_at'>
  | Pick<Extract<WorldEvent, { type: 'action_completed' }>, 'type' | 'agent_id' | 'agent_name' | 'action_id' | 'action_name'>
  | Pick<Extract<WorldEvent, { type: 'action_rejected' }>, 'type' | 'agent_id' | 'agent_name' | 'action_id' | 'action_name' | 'rejection_reason'>
  | Pick<Extract<WorldEvent, { type: 'wait_started' }>, 'type' | 'agent_id' | 'agent_name' | 'duration_ms' | 'completes_at'>
  | Pick<Extract<WorldEvent, { type: 'wait_completed' }>, 'type' | 'agent_id' | 'agent_name' | 'duration_ms'>
  | Pick<Extract<WorldEvent, { type: 'item_use_started' }>, 'type' | 'agent_id' | 'agent_name' | 'item_id' | 'item_name' | 'completes_at'>
  | Pick<Extract<WorldEvent, { type: 'item_use_completed' }>, 'type' | 'agent_id' | 'agent_name' | 'item_id' | 'item_name' | 'item_type'>
  | Pick<Extract<WorldEvent, { type: 'item_use_venue_rejected' }>, 'type' | 'agent_id' | 'agent_name' | 'item_id' | 'item_name' | 'venue_hints'>
  | Pick<Extract<WorldEvent, { type: 'conversation_requested' }>, 'type' | 'conversation_id' | 'initiator_agent_id' | 'target_agent_id' | 'message'>
  | Pick<Extract<WorldEvent, { type: 'conversation_accepted' }>, 'type' | 'conversation_id' | 'initiator_agent_id' | 'participant_agent_ids'>
  | Pick<Extract<WorldEvent, { type: 'conversation_rejected' }>, 'type' | 'conversation_id' | 'initiator_agent_id' | 'target_agent_id' | 'reason'>
  | Pick<Extract<WorldEvent, { type: 'conversation_message' }>, 'type' | 'conversation_id' | 'speaker_agent_id' | 'listener_agent_ids' | 'turn' | 'message'>
  | Pick<Extract<WorldEvent, { type: 'conversation_join' }>, 'type' | 'conversation_id' | 'agent_id' | 'agent_name' | 'participant_agent_ids'>
  | Pick<Extract<WorldEvent, { type: 'conversation_leave' }>, 'type' | 'conversation_id' | 'agent_id' | 'agent_name' | 'reason' | 'participant_agent_ids' | 'message' | 'next_speaker_agent_id'>
  | Pick<Extract<WorldEvent, { type: 'conversation_inactive_check' }>, 'type' | 'conversation_id' | 'target_agent_ids'>
  | Pick<Extract<WorldEvent, { type: 'conversation_interval_interrupted' }>, 'type' | 'conversation_id' | 'speaker_agent_id' | 'listener_agent_ids' | 'next_speaker_agent_id' | 'participant_agent_ids' | 'message' | 'closing'>
  | Pick<Extract<WorldEvent, { type: 'conversation_turn_started' }>, 'type' | 'conversation_id' | 'current_speaker_agent_id'>
  | Pick<Extract<WorldEvent, { type: 'conversation_closing' }>, 'type' | 'conversation_id' | 'initiator_agent_id' | 'participant_agent_ids' | 'current_speaker_agent_id' | 'reason'>
  | Pick<Extract<WorldEvent, { type: 'conversation_ended' }>, 'type' | 'conversation_id' | 'initiator_agent_id' | 'participant_agent_ids' | 'reason' | 'final_message' | 'final_speaker_agent_id'>
  | Pick<Extract<WorldEvent, { type: 'conversation_pending_join_cancelled' }>, 'type' | 'conversation_id' | 'agent_id' | 'reason'>
  | Pick<Extract<WorldEvent, { type: 'server_event_fired' }>, 'type' | 'server_event_id' | 'description' | 'delivered_agent_ids' | 'pending_agent_ids' | 'delayed'>;

export interface PersistedHistoryEntry {
  event_id: string;
  type: PersistedHistoryDetail['type'];
  occurred_at: number;
  agent_ids: string[];
  conversation_id?: string;
  summary: HistorySummary;
  detail: PersistedHistoryDetail;
}

export interface AgentHistoryDocument {
  agent_id: string;
  updated_at: number;
  items: PersistedHistoryEntry[];
  recent_actions: PersistedHistoryEntry[];
  recent_conversations: PersistedHistoryEntry[];
}

export interface AgentHistoryManagerConfig {
  workerBaseUrl: URL;
  authKey: string;
  fetchImpl?: typeof fetch;
  logger?: AgentHistoryManagerLogger;
  maxEntriesPerBucket?: number;
  maxBufferedEntriesPerAgent?: number;
  requestTimeoutMs?: number;
  resolveConversationParticipantAgentIds?: (conversationId: string) => string[];
}

type SupportedHistoryEventType = Exclude<
  EventType,
  'idle_reminder_fired' | 'map_info_requested' | 'world_agents_info_requested' | 'perception_requested' | 'available_actions_requested'
>;

type ActionHistoryEventType = 'action_started' | 'action_completed' | 'action_rejected';
type ConversationHistoryEventType = Extract<SupportedHistoryEventType, `conversation_${string}`>;

type _SupportedHistoryCoverage = Exclude<EventType, SupportedHistoryEventType | 'idle_reminder_fired' | 'map_info_requested' | 'world_agents_info_requested' | 'perception_requested' | 'available_actions_requested'> extends never ? true : never;
void (true as _SupportedHistoryCoverage);

const DEFAULT_MAX_ENTRIES_PER_BUCKET = 100;
const DEFAULT_MAX_BUFFERED_ENTRIES_PER_AGENT = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

function defaultLogger(): AgentHistoryManagerLogger {
  return {
    error(message, context) {
      console.error(message, context);
    },
  };
}

function dedupeAgentIds(agentIds: string[]): string[] {
  return [...new Set(agentIds.filter((agentId) => agentId.length > 0))];
}

function sortEntries(entries: PersistedHistoryEntry[]): PersistedHistoryEntry[] {
  return [...entries].sort((left, right) => right.occurred_at - left.occurred_at || right.event_id.localeCompare(left.event_id));
}

function appendUnique(entries: PersistedHistoryEntry[], nextEntry: PersistedHistoryEntry, limit: number): PersistedHistoryEntry[] {
  if (entries.some((entry) => entry.event_id === nextEntry.event_id)) {
    return sortEntries(entries).slice(0, limit);
  }

  return sortEntries([nextEntry, ...entries]).slice(0, limit);
}

function cloneEntry(entry: PersistedHistoryEntry): PersistedHistoryEntry {
  return {
    ...entry,
    agent_ids: [...entry.agent_ids],
    ...(entry.conversation_id ? { conversation_id: entry.conversation_id } : {}),
    summary: { ...entry.summary },
    detail: { ...entry.detail },
  };
}

function createEmptyHistory(agentId: string): AgentHistoryDocument {
  return {
    agent_id: agentId,
    updated_at: 0,
    items: [],
    recent_actions: [],
    recent_conversations: [],
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isActionHistoryType(type: PersistedHistoryEntry['type']): type is ActionHistoryEventType {
  return type === 'action_started' || type === 'action_completed' || type === 'action_rejected';
}

function isConversationHistoryType(type: PersistedHistoryEntry['type']): type is ConversationHistoryEventType {
  return type.startsWith('conversation_');
}

function isSupportedHistoryEvent(event: WorldEvent): event is Extract<WorldEvent, { type: SupportedHistoryEventType }> {
  switch (event.type) {
    case 'idle_reminder_fired':
    case 'map_info_requested':
    case 'world_agents_info_requested':
    case 'perception_requested':
    case 'available_actions_requested':
      return false;
    default:
      return true;
  }
}

function resolveHistoryAgentIds(
  event: Extract<WorldEvent, { type: SupportedHistoryEventType }>,
  resolveConversationParticipantAgentIds?: (conversationId: string) => string[],
): string[] {
  switch (event.type) {
    case 'agent_logged_in':
    case 'agent_logged_out':
    case 'movement_started':
    case 'movement_completed':
    case 'action_started':
    case 'action_completed':
    case 'action_rejected':
    case 'wait_started':
    case 'wait_completed':
    case 'item_use_started':
    case 'item_use_completed':
    case 'item_use_venue_rejected':
      return [event.agent_id];
    case 'conversation_requested':
      return dedupeAgentIds([event.initiator_agent_id, event.target_agent_id]);
    case 'conversation_accepted':
      return dedupeAgentIds([event.initiator_agent_id, ...event.participant_agent_ids]);
    case 'conversation_rejected':
      return dedupeAgentIds([event.initiator_agent_id, event.target_agent_id]);
    case 'conversation_message':
      return dedupeAgentIds([event.speaker_agent_id, ...event.listener_agent_ids]);
    case 'conversation_join':
    case 'conversation_leave':
      return dedupeAgentIds([event.agent_id, ...event.participant_agent_ids]);
    case 'conversation_inactive_check':
      return dedupeAgentIds([
        ...event.target_agent_ids,
        ...(resolveConversationParticipantAgentIds?.(event.conversation_id) ?? []),
      ]);
    case 'conversation_interval_interrupted':
      return dedupeAgentIds([event.speaker_agent_id, ...event.participant_agent_ids]);
    case 'conversation_turn_started':
      return dedupeAgentIds([
        event.current_speaker_agent_id,
        ...(resolveConversationParticipantAgentIds?.(event.conversation_id) ?? []),
      ]);
    case 'conversation_closing':
      return dedupeAgentIds([event.current_speaker_agent_id, ...event.participant_agent_ids]);
    case 'conversation_ended':
      return dedupeAgentIds(
        event.final_speaker_agent_id
          ? [event.final_speaker_agent_id, ...event.participant_agent_ids]
          : [...event.participant_agent_ids],
      );
    case 'conversation_pending_join_cancelled':
      return [event.agent_id];
    case 'server_event_fired':
      return dedupeAgentIds([...event.delivered_agent_ids, ...event.pending_agent_ids]);
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function sanitizeDetail(event: Extract<WorldEvent, { type: SupportedHistoryEventType }>): PersistedHistoryDetail {
  switch (event.type) {
    case 'agent_logged_in':
      return {
        type: event.type,
        agent_id: event.agent_id,
        agent_name: event.agent_name,
        node_id: event.node_id,
      };
    case 'agent_logged_out':
      return {
        type: event.type,
        agent_id: event.agent_id,
        agent_name: event.agent_name,
        node_id: event.node_id,
        cancelled_state: event.cancelled_state,
        ...(event.cancelled_action_name ? { cancelled_action_name: event.cancelled_action_name } : {}),
      };
    case 'movement_started':
      return {
        type: event.type,
        agent_id: event.agent_id,
        agent_name: event.agent_name,
        from_node_id: event.from_node_id,
        to_node_id: event.to_node_id,
        path: [...event.path],
        arrives_at: event.arrives_at,
      };
    case 'movement_completed':
      return {
        type: event.type,
        agent_id: event.agent_id,
        agent_name: event.agent_name,
        node_id: event.node_id,
        delivered_server_event_ids: [...event.delivered_server_event_ids],
      };
    case 'action_started':
      return {
        type: event.type,
        agent_id: event.agent_id,
        agent_name: event.agent_name,
        action_id: event.action_id,
        action_name: event.action_name,
        duration_ms: event.duration_ms,
        completes_at: event.completes_at,
      };
    case 'action_completed':
      return {
        type: event.type,
        agent_id: event.agent_id,
        agent_name: event.agent_name,
        action_id: event.action_id,
        action_name: event.action_name,
      };
    case 'action_rejected':
      return {
        type: event.type,
        agent_id: event.agent_id,
        agent_name: event.agent_name,
        action_id: event.action_id,
        action_name: event.action_name,
        rejection_reason: event.rejection_reason,
      };
    case 'wait_started':
      return {
        type: event.type,
        agent_id: event.agent_id,
        agent_name: event.agent_name,
        duration_ms: event.duration_ms,
        completes_at: event.completes_at,
      };
    case 'wait_completed':
      return {
        type: event.type,
        agent_id: event.agent_id,
        agent_name: event.agent_name,
        duration_ms: event.duration_ms,
      };
    case 'item_use_started':
      return {
        type: event.type,
        agent_id: event.agent_id,
        agent_name: event.agent_name,
        item_id: event.item_id,
        item_name: event.item_name,
        completes_at: event.completes_at,
      };
    case 'item_use_completed':
      return {
        type: event.type,
        agent_id: event.agent_id,
        agent_name: event.agent_name,
        item_id: event.item_id,
        item_name: event.item_name,
        item_type: event.item_type,
      };
    case 'item_use_venue_rejected':
      return {
        type: event.type,
        agent_id: event.agent_id,
        agent_name: event.agent_name,
        item_id: event.item_id,
        item_name: event.item_name,
        venue_hints: [...event.venue_hints],
      };
    case 'conversation_requested':
      return {
        type: event.type,
        conversation_id: event.conversation_id,
        initiator_agent_id: event.initiator_agent_id,
        target_agent_id: event.target_agent_id,
        message: event.message,
      };
    case 'conversation_accepted':
      return {
        type: event.type,
        conversation_id: event.conversation_id,
        initiator_agent_id: event.initiator_agent_id,
        participant_agent_ids: [...event.participant_agent_ids],
      };
    case 'conversation_rejected':
      return {
        type: event.type,
        conversation_id: event.conversation_id,
        initiator_agent_id: event.initiator_agent_id,
        target_agent_id: event.target_agent_id,
        reason: event.reason,
      };
    case 'conversation_message':
      return {
        type: event.type,
        conversation_id: event.conversation_id,
        speaker_agent_id: event.speaker_agent_id,
        listener_agent_ids: [...event.listener_agent_ids],
        turn: event.turn,
        message: event.message,
      };
    case 'conversation_join':
      return {
        type: event.type,
        conversation_id: event.conversation_id,
        agent_id: event.agent_id,
        agent_name: event.agent_name,
        participant_agent_ids: [...event.participant_agent_ids],
      };
    case 'conversation_leave':
      return {
        type: event.type,
        conversation_id: event.conversation_id,
        agent_id: event.agent_id,
        agent_name: event.agent_name,
        reason: event.reason,
        participant_agent_ids: [...event.participant_agent_ids],
        ...(event.message ? { message: event.message } : {}),
        ...(event.next_speaker_agent_id ? { next_speaker_agent_id: event.next_speaker_agent_id } : {}),
      };
    case 'conversation_inactive_check':
      return {
        type: event.type,
        conversation_id: event.conversation_id,
        target_agent_ids: [...event.target_agent_ids],
      };
    case 'conversation_interval_interrupted':
      return {
        type: event.type,
        conversation_id: event.conversation_id,
        speaker_agent_id: event.speaker_agent_id,
        listener_agent_ids: [...event.listener_agent_ids],
        next_speaker_agent_id: event.next_speaker_agent_id,
        participant_agent_ids: [...event.participant_agent_ids],
        message: event.message,
        closing: event.closing,
      };
    case 'conversation_turn_started':
      return {
        type: event.type,
        conversation_id: event.conversation_id,
        current_speaker_agent_id: event.current_speaker_agent_id,
      };
    case 'conversation_closing':
      return {
        type: event.type,
        conversation_id: event.conversation_id,
        initiator_agent_id: event.initiator_agent_id,
        participant_agent_ids: [...event.participant_agent_ids],
        current_speaker_agent_id: event.current_speaker_agent_id,
        reason: event.reason,
      };
    case 'conversation_ended':
      return {
        type: event.type,
        conversation_id: event.conversation_id,
        initiator_agent_id: event.initiator_agent_id,
        participant_agent_ids: [...event.participant_agent_ids],
        reason: event.reason,
        ...(event.final_message ? { final_message: event.final_message } : {}),
        ...(event.final_speaker_agent_id ? { final_speaker_agent_id: event.final_speaker_agent_id } : {}),
      };
    case 'conversation_pending_join_cancelled':
      return {
        type: event.type,
        conversation_id: event.conversation_id,
        agent_id: event.agent_id,
        reason: event.reason,
      };
    case 'server_event_fired':
      return {
        type: event.type,
        server_event_id: event.server_event_id,
        description: event.description,
        delivered_agent_ids: [...event.delivered_agent_ids],
        pending_agent_ids: [...event.pending_agent_ids],
        delayed: event.delayed,
      };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function buildSummary(event: Extract<WorldEvent, { type: SupportedHistoryEventType }>): HistorySummary {
  switch (event.type) {
    case 'agent_logged_in':
      return { emoji: '🟢', title: 'Logged in', text: `${event.agent_name} logged in at ${event.node_id}.` };
    case 'agent_logged_out':
      return { emoji: '🔴', title: 'Logged out', text: `${event.agent_name} logged out from ${event.node_id}.` };
    case 'movement_started':
      return { emoji: '🚶', title: 'Move started', text: `${event.agent_name} started moving to ${event.to_node_id}.` };
    case 'movement_completed':
      return { emoji: '📍', title: 'Move completed', text: `${event.agent_name} arrived at ${event.node_id}.` };
    case 'action_started':
      return { emoji: '✨', title: 'Action started', text: `${event.agent_name} started ${event.action_name}.` };
    case 'action_completed':
      return { emoji: '✅', title: 'Action completed', text: `${event.agent_name} completed ${event.action_name}.` };
    case 'action_rejected':
      return { emoji: '⛔', title: 'Action rejected', text: `${event.agent_name} could not start ${event.action_name}.` };
    case 'wait_started':
      return { emoji: '💤', title: 'Wait started', text: `${event.agent_name} started waiting.` };
    case 'wait_completed':
      return { emoji: '⏰', title: 'Wait completed', text: `${event.agent_name} finished waiting.` };
    case 'item_use_started':
      return { emoji: '🧰', title: 'Item use started', text: `${event.agent_name} started using ${event.item_name}.` };
    case 'item_use_completed':
      return { emoji: '🎒', title: 'Item use completed', text: `${event.agent_name} used ${event.item_name}.` };
    case 'item_use_venue_rejected':
      return { emoji: '🚫', title: 'Venue required', text: `${event.agent_name} needs a venue for ${event.item_name}.` };
    case 'conversation_requested':
      return { emoji: '💬', title: 'Conversation requested', text: event.message };
    case 'conversation_accepted':
      return { emoji: '🤝', title: 'Conversation accepted', text: `Conversation ${event.conversation_id} started.` };
    case 'conversation_rejected':
      return { emoji: '🙅', title: 'Conversation rejected', text: `Conversation ${event.conversation_id} was rejected.` };
    case 'conversation_message':
      return { emoji: '🗨️', title: 'Message sent', text: event.message };
    case 'conversation_join':
      return { emoji: '➕', title: 'Joined conversation', text: `${event.agent_name} joined conversation ${event.conversation_id}.` };
    case 'conversation_leave':
      return { emoji: '➖', title: 'Left conversation', text: `${event.agent_name} left conversation ${event.conversation_id}.` };
    case 'conversation_inactive_check':
      return { emoji: '⏳', title: 'Inactive check', text: `Conversation ${event.conversation_id} requested a stay/leave response.` };
    case 'conversation_interval_interrupted':
      return { emoji: '⏸️', title: 'Conversation interrupted', text: event.message };
    case 'conversation_turn_started':
      return { emoji: '🎤', title: 'Turn started', text: `${event.current_speaker_agent_id} is now speaking.` };
    case 'conversation_closing':
      return { emoji: '🔚', title: 'Conversation closing', text: `Conversation ${event.conversation_id} is closing.` };
    case 'conversation_ended':
      return { emoji: '🏁', title: 'Conversation ended', text: event.final_message ?? `Conversation ${event.conversation_id} ended.` };
    case 'conversation_pending_join_cancelled':
      return { emoji: '🚷', title: 'Pending join cancelled', text: `${event.agent_id} could not join conversation ${event.conversation_id}.` };
    case 'server_event_fired':
      return { emoji: '📣', title: 'Server event fired', text: event.description };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function toPersistedHistoryEntry(
  event: WorldEvent,
  resolveConversationParticipantAgentIds?: (conversationId: string) => string[],
): PersistedHistoryEntry | null {
  if (!isSupportedHistoryEvent(event)) {
    return null;
  }

  const agentIds = resolveHistoryAgentIds(event, resolveConversationParticipantAgentIds);
  if (agentIds.length === 0) {
    return null;
  }

  return {
    event_id: event.event_id,
    type: event.type,
    occurred_at: event.occurred_at,
    agent_ids: agentIds,
    ...('conversation_id' in event ? { conversation_id: event.conversation_id } : {}),
    summary: buildSummary(event),
    detail: sanitizeDetail(event),
  };
}

export class AgentHistoryManager {
  private readonly publishUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: AgentHistoryManagerLogger;
  private readonly maxEntriesPerBucket: number;
  private readonly maxBufferedEntriesPerAgent: number;
  private readonly requestTimeoutMs: number;
  private readonly resolveConversationParticipantAgentIds?: (conversationId: string) => string[];
  private readonly histories = new Map<string, AgentHistoryDocument>();
  private readonly pending = new Map<string, PersistedHistoryEntry[]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private pendingVersion = 0;
  private disposed = false;

  constructor(private readonly config: AgentHistoryManagerConfig) {
    if (!config.authKey.trim()) {
      throw new Error('AgentHistoryManager authKey is required');
    }

    this.publishUrl = new URL('/api/publish-agent-history', config.workerBaseUrl);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.logger = config.logger ?? defaultLogger();
    this.maxEntriesPerBucket = config.maxEntriesPerBucket ?? DEFAULT_MAX_ENTRIES_PER_BUCKET;
    this.maxBufferedEntriesPerAgent = config.maxBufferedEntriesPerAgent ?? DEFAULT_MAX_BUFFERED_ENTRIES_PER_AGENT;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.resolveConversationParticipantAgentIds = config.resolveConversationParticipantAgentIds;
  }

  recordEvent(event: WorldEvent): void {
    if (this.disposed) {
      return;
    }

    const entry = toPersistedHistoryEntry(event, this.resolveConversationParticipantAgentIds);
    if (!entry) {
      return;
    }

    for (const agentId of entry.agent_ids) {
      const current = this.histories.get(agentId) ?? createEmptyHistory(agentId);
      const clonedEntry = cloneEntry(entry);
      const next: AgentHistoryDocument = {
        ...current,
        updated_at: Math.max(current.updated_at, entry.occurred_at),
        items: isActionHistoryType(entry.type) || isConversationHistoryType(entry.type)
          ? [...current.items]
          : appendUnique(current.items, clonedEntry, this.maxEntriesPerBucket),
        recent_actions: isActionHistoryType(entry.type)
          ? appendUnique(current.recent_actions, clonedEntry, this.maxEntriesPerBucket)
          : [...current.recent_actions],
        recent_conversations: isConversationHistoryType(entry.type)
          ? appendUnique(current.recent_conversations, clonedEntry, this.maxEntriesPerBucket)
          : [...current.recent_conversations],
      };
      this.histories.set(agentId, next);

      const pendingEntries = this.pending.get(agentId) ?? [];
      const mergedPending = pendingEntries.some((pendingEntry) => pendingEntry.event_id === entry.event_id)
        ? pendingEntries
        : [...pendingEntries, cloneEntry(entry)];

      if (mergedPending.length > this.maxBufferedEntriesPerAgent) {
        const overflowCount = mergedPending.length - this.maxBufferedEntriesPerAgent;
        this.logger.error('HISTORY_BUFFER_OVERFLOW', { agent_id: agentId, dropped: overflowCount });
        this.pending.set(agentId, mergedPending.slice(overflowCount));
      } else {
        this.pending.set(agentId, mergedPending);
      }

      this.pendingVersion += 1;
    }

    this.scheduleFlush();
  }

  getHistory(agentId: string): AgentHistoryDocument {
    const history = this.histories.get(agentId) ?? createEmptyHistory(agentId);
    return {
      ...history,
      items: history.items.map(cloneEntry),
      recent_actions: history.recent_actions.map(cloneEntry),
      recent_conversations: history.recent_conversations.map(cloneEntry),
    };
  }

  async dispose(timeoutMs = 10_000): Promise<void> {
    this.disposed = true;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.flushPromise ??= this.flushPending();

    let resolveTimeout!: () => void;
    const timeoutPromise = new Promise<void>((resolve) => {
      resolveTimeout = resolve;
    });
    let disposeTimeout: ReturnType<typeof setTimeout> | null = setTimeout(resolveTimeout, timeoutMs);
    disposeTimeout.unref?.();

    try {
      await Promise.race([this.flushPromise, timeoutPromise]);
    } finally {
      if (disposeTimeout) {
        clearTimeout(disposeTimeout);
        disposeTimeout = null;
      }
    }
  }

  private scheduleFlush(): void {
    if (this.disposed) {
      return;
    }

    if (this.flushPromise) {
      return;
    }

    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPromise ??= this.flushPending();
      void this.flushPromise.catch((error) => {
        this.logger.error('AGENT_HISTORY_FLUSH_UNCAUGHT', { error: describeError(error) });
      });
    }, 0);
  }

  private async flushPending(): Promise<void> {
    const flushStartVersion = this.pendingVersion;

    try {
      for (const [agentId, entries] of [...this.pending.entries()]) {
        if (entries.length === 0) {
          continue;
        }

        try {
          const response = await this.fetchImpl(this.publishUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.config.authKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              agent_id: agentId,
              events: entries,
            }),
            signal: AbortSignal.timeout(this.requestTimeoutMs),
          });

          if (!response.ok) {
            throw new Error(`publish agent history failed with HTTP ${response.status}`);
          }

          const remaining = this.pending.get(agentId)?.filter(
            (pendingEntry) => !entries.some((sentEntry) => sentEntry.event_id === pendingEntry.event_id),
          ) ?? [];

          if (remaining.length === 0) {
            this.pending.delete(agentId);
          } else {
            this.pending.set(agentId, remaining);
          }
        } catch (error) {
          this.logger.error('AGENT_HISTORY_PUBLISH_FAILED', {
            agent_id: agentId,
            error: describeError(error),
          });
        }
      }
    } finally {
      this.flushPromise = null;

      if (!this.disposed && this.pending.size > 0 && this.pendingVersion > flushStartVersion) {
        this.scheduleFlush();
      }
    }
  }
}
