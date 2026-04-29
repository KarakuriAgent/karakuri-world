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
  | { type: 'agent_logged_in' }
  | { type: 'agent_logged_out' }
  | { type: 'movement_started' }
  | { type: 'movement_completed' }
  | { type: 'action_started' }
  | { type: 'action_completed' }
  | { type: 'action_rejected' }
  | { type: 'wait_started' }
  | { type: 'wait_completed' }
  | { type: 'item_use_started' }
  | { type: 'item_use_completed' }
  | { type: 'item_use_venue_rejected' }
  | { type: 'conversation_requested'; initiator_agent_id: string }
  | { type: 'conversation_rejected' }
  | { type: 'conversation_message'; speaker_agent_id: string }
  | { type: 'conversation_join' }
  | { type: 'conversation_leave' }
  | { type: 'conversation_interval_interrupted'; speaker_agent_id: string }
  | { type: 'conversation_ended'; final_speaker_agent_id?: string }
  | { type: 'transfer_requested' }
  | { type: 'transfer_accepted' }
  | { type: 'transfer_rejected' }
  | { type: 'transfer_timeout' }
  | { type: 'transfer_cancelled' }
  | { type: 'transfer_escrow_lost' }
  | { type: 'server_event_fired' };

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
  retryBaseIntervalMs?: number;
  retryMaxIntervalMs?: number;
  retryMaxAttempts?: number;
}

type NonSupportedHistoryEventType =
  | 'idle_reminder_fired'
  | 'map_info_requested'
  | 'world_agents_info_requested'
  | 'perception_requested'
  | 'available_actions_requested'
  | 'conversation_accepted'
  | 'conversation_turn_started'
  | 'conversation_closing'
  | 'conversation_inactive_check'
  | 'conversation_pending_join_cancelled';

type SupportedHistoryEventType = Exclude<EventType, NonSupportedHistoryEventType>;

type ActionHistoryEventType = 'action_started' | 'action_completed' | 'action_rejected';
type ConversationHistoryEventType = Extract<SupportedHistoryEventType, `conversation_${string}`>;

type _SupportedHistoryCoverage = Exclude<EventType, SupportedHistoryEventType | NonSupportedHistoryEventType> extends never ? true : never;
void (true as _SupportedHistoryCoverage);

const DEFAULT_MAX_ENTRIES_PER_BUCKET = 100;
const DEFAULT_MAX_BUFFERED_ENTRIES_PER_AGENT = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_BASE_INTERVAL_MS = 5_000;
const DEFAULT_RETRY_MAX_INTERVAL_MS = 60_000;
const DEFAULT_RETRY_MAX_ATTEMPTS = 10;

function calculateBackoff(baseIntervalMs: number, attempt: number, maxIntervalMs: number): number {
  return Math.min(baseIntervalMs * 2 ** Math.max(attempt - 1, 0), maxIntervalMs);
}

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
    case 'conversation_accepted':
    case 'conversation_turn_started':
    case 'conversation_closing':
    case 'conversation_inactive_check':
    case 'conversation_pending_join_cancelled':
      return false;
    default:
      return true;
  }
}

function resolveHistoryAgentIds(
  event: Extract<WorldEvent, { type: SupportedHistoryEventType }>,
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
    case 'conversation_rejected':
      return dedupeAgentIds([event.initiator_agent_id, event.target_agent_id]);
    case 'conversation_message':
      return dedupeAgentIds([event.speaker_agent_id, ...event.listener_agent_ids]);
    case 'conversation_join':
    case 'conversation_leave':
      return dedupeAgentIds([event.agent_id, ...event.participant_agent_ids]);
    case 'conversation_interval_interrupted':
      return dedupeAgentIds([event.speaker_agent_id, ...event.participant_agent_ids]);
    case 'conversation_ended':
      return dedupeAgentIds(
        event.final_speaker_agent_id
          ? [event.final_speaker_agent_id, ...event.participant_agent_ids]
          : [...event.participant_agent_ids],
      );
    case 'transfer_requested':
    case 'transfer_accepted':
    case 'transfer_rejected':
    case 'transfer_timeout':
    case 'transfer_cancelled':
    case 'transfer_escrow_lost':
      return dedupeAgentIds([event.from_agent_id, event.to_agent_id]);
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
    case 'conversation_requested':
      return { type: event.type, initiator_agent_id: event.initiator_agent_id };
    case 'conversation_message':
    case 'conversation_interval_interrupted':
      return { type: event.type, speaker_agent_id: event.speaker_agent_id };
    case 'conversation_ended':
      return {
        type: event.type,
        ...(event.final_speaker_agent_id ? { final_speaker_agent_id: event.final_speaker_agent_id } : {}),
      };
    default:
      return { type: event.type };
  }
}

function buildSummary(event: Extract<WorldEvent, { type: SupportedHistoryEventType }>): HistorySummary {
  switch (event.type) {
    case 'agent_logged_in':
      return { emoji: '🟢', title: 'ログイン', text: `${event.agent_name} が ${event.node_id} でログインした。` };
    case 'agent_logged_out':
      return { emoji: '🔴', title: 'ログアウト', text: `${event.agent_name} が ${event.node_id} でログアウトした。` };
    case 'movement_started':
      return { emoji: '🚶', title: '移動開始', text: `${event.agent_name} が ${event.to_node_id} へ移動を始めた。` };
    case 'movement_completed':
      return { emoji: '📍', title: '移動完了', text: `${event.agent_name} が ${event.node_id} に到着した。` };
    case 'action_started':
      return { emoji: '✨', title: 'アクション開始', text: `${event.agent_name} が「${event.action_name}」を始めた。` };
    case 'action_completed':
      return { emoji: '✅', title: 'アクション完了', text: `${event.agent_name} が「${event.action_name}」を終えた。` };
    case 'action_rejected':
      return { emoji: '⛔', title: 'アクション不可', text: `${event.agent_name} は「${event.action_name}」を開始できなかった。` };
    case 'wait_started':
      return { emoji: '💤', title: '待機開始', text: `${event.agent_name} が待機を始めた。` };
    case 'wait_completed':
      return { emoji: '⏰', title: '待機完了', text: `${event.agent_name} が待機を終えた。` };
    case 'item_use_started':
      return { emoji: '🧰', title: 'アイテム使用開始', text: `${event.agent_name} が「${event.item_name}」を使い始めた。` };
    case 'item_use_completed':
      return { emoji: '🎒', title: 'アイテム使用完了', text: `${event.agent_name} が「${event.item_name}」を使った。` };
    case 'item_use_venue_rejected':
      return { emoji: '🚫', title: '使用場所が必要', text: `${event.agent_name} が「${event.item_name}」を使うには専用の場所が必要。` };
    case 'conversation_requested':
      return { emoji: '💬', title: '会話を呼びかけ', text: event.message };
    case 'conversation_rejected':
      return { emoji: '🙅', title: '会話拒否', text: '会話は断られた。' };
    case 'conversation_message':
      return { emoji: '🗨️', title: '発話', text: event.message };
    case 'conversation_join':
      return { emoji: '➕', title: '会話に参加', text: `${event.agent_name} が会話に加わった。` };
    case 'conversation_leave':
      return { emoji: '➖', title: '会話から退出', text: `${event.agent_name} が会話から抜けた。` };
    case 'conversation_interval_interrupted':
      return { emoji: '⏸️', title: '会話が割り込まれた', text: event.message };
    case 'conversation_ended':
      return { emoji: '🏁', title: '会話終了', text: event.final_message ?? '会話が終了した。' };
    case 'transfer_requested':
      return { emoji: '🤝', title: '譲渡提案', text: `${event.from_agent_name} が ${event.to_agent_name} に譲渡を提案した。` };
    case 'transfer_accepted':
      return { emoji: '🎁', title: '譲渡成立', text: `${event.to_agent_name} が譲渡を受け取った。` };
    case 'transfer_rejected':
      return { emoji: '↩️', title: '譲渡拒否', text: `${event.to_agent_name} が譲渡を受け取らなかった。` };
    case 'transfer_timeout':
      return { emoji: '⌛', title: '譲渡タイムアウト', text: `${event.to_agent_name} への譲渡が期限切れになった。` };
    case 'transfer_cancelled':
      return { emoji: '⚠️', title: '譲渡取消', text: `${event.to_agent_name} への譲渡が取り消された。` };
    case 'transfer_escrow_lost':
      return { emoji: '🚨', title: '譲渡返却失敗', text: `${event.to_agent_name} との譲渡で返却処理に失敗した。` };
    case 'server_event_fired':
      return { emoji: '📣', title: 'サーバーイベント発生', text: event.description };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function toPersistedHistoryEntry(event: WorldEvent): PersistedHistoryEntry | null {
  if (!isSupportedHistoryEvent(event)) {
    return null;
  }

  const agentIds = resolveHistoryAgentIds(event);
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
  private readonly retryBaseIntervalMs: number;
  private readonly retryMaxIntervalMs: number;
  private readonly retryMaxAttempts: number;
  private readonly histories = new Map<string, AgentHistoryDocument>();
  private readonly pending = new Map<string, PersistedHistoryEntry[]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private pendingVersion = 0;
  private consecutiveFailures = 0;
  private gaveUp = false;
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
    this.retryBaseIntervalMs = config.retryBaseIntervalMs ?? DEFAULT_RETRY_BASE_INTERVAL_MS;
    this.retryMaxIntervalMs = config.retryMaxIntervalMs ?? DEFAULT_RETRY_MAX_INTERVAL_MS;
    this.retryMaxAttempts = config.retryMaxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS;
  }

  recordEvent(event: WorldEvent): void {
    if (this.disposed) {
      return;
    }

    const entry = toPersistedHistoryEntry(event);
    if (!entry) {
      return;
    }

    // A fresh event resets the give-up state so the next publish attempt can run.
    if (this.gaveUp) {
      this.gaveUp = false;
      this.consecutiveFailures = 0;
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

  private scheduleFlush(delayMs = 0): void {
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
    }, Math.max(0, delayMs));
  }

  private async flushPending(): Promise<void> {
    const flushStartVersion = this.pendingVersion;
    let hadFailure = false;

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
          hadFailure = true;
          this.logger.error('AGENT_HISTORY_PUBLISH_FAILED', {
            agent_id: agentId,
            error: describeError(error),
          });
        }
      }
    } finally {
      this.flushPromise = null;

      if (hadFailure) {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= this.retryMaxAttempts) {
          this.gaveUp = true;
          this.logger.error('AGENT_HISTORY_PUBLISH_EXHAUSTED', {
            attempts: this.consecutiveFailures,
          });
        }
      } else {
        this.consecutiveFailures = 0;
      }

      if (!this.disposed && this.pending.size > 0 && !this.gaveUp) {
        const hasNewEvents = this.pendingVersion > flushStartVersion;
        if (hadFailure) {
          this.scheduleFlush(calculateBackoff(this.retryBaseIntervalMs, this.consecutiveFailures, this.retryMaxIntervalMs));
        } else if (hasNewEvents) {
          this.scheduleFlush();
        }
      }
    }
  }
}
