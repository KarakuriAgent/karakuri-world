import type { EventType } from '../types/event.js';
import type { WorldSnapshot } from '../types/snapshot.js';

export interface SnapshotPublisherLogger {
  error(message: string, context?: Record<string, unknown>): void;
}

export interface SnapshotPublisherConfig {
  workerBaseUrl: URL;
  authKey: string;
  buildSnapshot?: () => WorldSnapshot;
  debounceMs?: number;
  retryMaxAttempts?: number;
  retryBaseIntervalMs?: number;
  retryMaxIntervalMs?: number;
  requestTimeoutMs?: number;
  logger?: SnapshotPublisherLogger;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface SnapshotPublisherStats {
  pending: boolean;
  lastPublishedAt?: number;
  consecutiveFailures: number;
  gaveUp: boolean;
  state: 'idle' | 'pending' | 'retrying' | 'failed';
}

export type PublishResult =
  | { type: 'success'; publishedAt: number }
  | { type: 'failed'; attempt: number; error: string }
  | { type: 'gave_up'; lastError: string };

type PublishListener = (result: PublishResult) => void;
type ScheduledPublishKind = 'debounce' | 'retry';

type SnapshotTriggerEventType =
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
  | 'conversation_interval_interrupted'
  | 'conversation_turn_started'
  | 'conversation_closing'
  | 'conversation_ended'
  | 'transfer_requested'
  | 'transfer_accepted'
  | 'transfer_rejected'
  | 'transfer_timeout'
  | 'transfer_cancelled'
  | 'transfer_escrow_lost'
  | 'server_announcement_fired'
  | 'server_event_created'
  | 'server_event_cleared';

type NonTriggerEventType =
  | 'conversation_inactive_check'
  | 'conversation_pending_join_cancelled'
  | 'idle_reminder_fired'
  | 'map_info_requested'
  | 'world_agents_info_requested'
  | 'status_info_requested'
  | 'nearby_agents_info_requested'
  | 'active_conversations_info_requested'
  | 'server_events_info_requested'
  | 'perception_requested'
  | 'available_actions_requested';

type _SnapshotTriggerCoverage = Exclude<EventType, SnapshotTriggerEventType | NonTriggerEventType> extends never
  ? true
  : never;

type _SnapshotTriggerNoOverlap = Extract<SnapshotTriggerEventType, NonTriggerEventType> extends never ? true : never;

void (true as _SnapshotTriggerCoverage);
void (true as _SnapshotTriggerNoOverlap);

const DEFAULT_DEBOUNCE_MS = 1_000;
const DEFAULT_RETRY_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_INTERVAL_MS = 5_000;
const DEFAULT_RETRY_MAX_INTERVAL_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

function calculateBackoff(baseIntervalMs: number, attempt: number, maxIntervalMs: number): number {
  return Math.min(baseIntervalMs * 2 ** Math.max(attempt - 1, 0), maxIntervalMs);
}

function defaultLogger(): SnapshotPublisherLogger {
  return {
    error(message, context) {
      console.error(message, context);
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isSnapshotTriggerEvent(type: EventType): boolean {
  switch (type) {
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
    case 'conversation_requested':
    case 'conversation_accepted':
    case 'conversation_rejected':
    case 'conversation_message':
    case 'conversation_join':
    case 'conversation_leave':
    case 'conversation_interval_interrupted':
    case 'conversation_turn_started':
    case 'conversation_closing':
    case 'conversation_ended':
    case 'transfer_requested':
    case 'transfer_accepted':
    case 'transfer_rejected':
    case 'transfer_timeout':
    case 'transfer_cancelled':
    case 'transfer_escrow_lost':
    case 'server_announcement_fired':
    case 'server_event_created':
    case 'server_event_cleared':
      return true;
    case 'conversation_inactive_check':
    case 'conversation_pending_join_cancelled':
    case 'idle_reminder_fired':
    case 'map_info_requested':
    case 'world_agents_info_requested':
    case 'status_info_requested':
    case 'nearby_agents_info_requested':
    case 'active_conversations_info_requested':
    case 'server_events_info_requested':
    case 'perception_requested':
    case 'available_actions_requested':
      return false;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

export class SnapshotPublisher {
  private readonly publishUrl: URL;
  private readonly debounceMs: number;
  private readonly retryMaxAttempts: number;
  private readonly retryBaseIntervalMs: number;
  private readonly retryMaxIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly logger: SnapshotPublisherLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly listeners = new Set<PublishListener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scheduledKind: ScheduledPublishKind | null = null;
  private inFlightPromise: Promise<void> | null = null;
  private dirty = false;
  private disposed = false;
  private gaveUp = false;
  private consecutiveFailures = 0;
  private lastPublishedAt?: number;
  private buildSnapshotCallback: (() => WorldSnapshot) | null;

  constructor(config: SnapshotPublisherConfig) {
    this.publishUrl = new URL('/api/publish-snapshot', config.workerBaseUrl);
    this.debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.retryMaxAttempts = config.retryMaxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS;
    this.retryBaseIntervalMs = config.retryBaseIntervalMs ?? DEFAULT_RETRY_BASE_INTERVAL_MS;
    this.retryMaxIntervalMs = config.retryMaxIntervalMs ?? DEFAULT_RETRY_MAX_INTERVAL_MS;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.logger = config.logger ?? defaultLogger();
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? (() => Date.now());
    this.buildSnapshotCallback = config.buildSnapshot ?? null;

    if (!config.authKey.trim()) {
      throw new Error('SnapshotPublisher authKey is required');
    }

    this.authKey = config.authKey;
  }

  private readonly authKey: string;

  setBuildSnapshot(buildSnapshot: () => WorldSnapshot): void {
    this.buildSnapshotCallback = buildSnapshot;
  }

  requestPublish(): void {
    if (this.disposed) {
      return;
    }

    this.dirty = true;
    if (this.gaveUp) {
      this.consecutiveFailures = 0;
    }
    this.gaveUp = false;
    if (this.inFlightPromise || this.scheduledKind === 'retry') {
      return;
    }

    this.schedule(this.debounceMs, 'debounce');
  }

  onPublish(listener: PublishListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStats(): SnapshotPublisherStats {
    const pending = this.dirty || this.timer !== null || this.inFlightPromise !== null;
    const state = this.gaveUp ? 'failed' : this.consecutiveFailures > 0 ? 'retrying' : pending ? 'pending' : 'idle';

    return {
      pending,
      consecutiveFailures: this.consecutiveFailures,
      gaveUp: this.gaveUp,
      state,
      ...(this.lastPublishedAt !== undefined ? { lastPublishedAt: this.lastPublishedAt } : {}),
    };
  }

  async dispose(timeoutMs = 10_000): Promise<void> {
    this.disposed = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.scheduledKind = null;
    }

    if (this.dirty && !this.gaveUp) {
      this.inFlightPromise ??= (async () => {
        const shouldPublish = this.dirty;
        this.dirty = false;

        if (!shouldPublish) {
          return;
        }

        try {
          await this.publishOnce();
          this.consecutiveFailures = 0;
          this.lastPublishedAt = this.now();
          this.emit({ type: 'success', publishedAt: this.lastPublishedAt });
        } catch (error) {
          const message = describeError(error);
          this.logger.error('SNAPSHOT_PUBLISH_DISPOSE_FAILED', { error: message });
          this.emit({ type: 'gave_up', lastError: message });
        } finally {
          this.inFlightPromise = null;
        }
      })();
    }

    if (!this.inFlightPromise) {
      return;
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        this.inFlightPromise,
        new Promise<void>((resolve) => {
          timeoutHandle = setTimeout(resolve, timeoutMs);
          timeoutHandle.unref?.();
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private schedule(delayMs: number, kind: ScheduledPublishKind): void {
    if (this.disposed || this.gaveUp) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.scheduledKind = kind;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduledKind = null;
      this.inFlightPromise ??= this.publishLoop();
      void this.inFlightPromise.catch((error) => {
        this.logger.error('SNAPSHOT_PUBLISH_UNCAUGHT', { error: describeError(error) });
      });
    }, Math.max(0, delayMs));
  }

  private emit(result: PublishResult): void {
    for (const listener of this.listeners) {
      try {
        listener(result);
      } catch (error) {
        this.logger.error('SNAPSHOT_PUBLISH_LISTENER_FAILED', {
          error: describeError(error),
          result: result.type,
        });
      }
    }
  }

  private async publishLoop(): Promise<void> {
    try {
      while (!this.disposed && this.dirty && !this.gaveUp) {
        this.dirty = false;
        const attempt = this.consecutiveFailures + 1;

        try {
          await this.publishOnce();
          this.consecutiveFailures = 0;
          this.lastPublishedAt = this.now();
          this.emit({ type: 'success', publishedAt: this.lastPublishedAt });
        } catch (error) {
          const message = describeError(error);
          this.consecutiveFailures = attempt;
          this.emit({ type: 'failed', attempt, error: message });

          if (attempt >= this.retryMaxAttempts) {
            this.gaveUp = true;
            this.emit({ type: 'gave_up', lastError: message });
            this.logger.error('SNAPSHOT_PUBLISH_EXHAUSTED', {
              attempt,
              error: message,
            });
            return;
          }

          this.dirty = true;
          this.schedule(calculateBackoff(this.retryBaseIntervalMs, attempt, this.retryMaxIntervalMs), 'retry');
          return;
        }
      }
    } finally {
      this.inFlightPromise = null;

      if (!this.disposed && this.dirty && !this.gaveUp && !this.timer) {
        this.schedule(0, 'debounce');
      }
    }
  }

  private async publishOnce(): Promise<void> {
    if (!this.buildSnapshotCallback) {
      throw new Error('SnapshotPublisher buildSnapshot callback is not configured');
    }

    const snapshot = this.buildSnapshotCallback();
    const response = await this.fetchImpl(this.publishUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`publish snapshot failed with HTTP ${response.status}`);
    }
  }
}
