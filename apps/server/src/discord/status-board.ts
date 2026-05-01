import type { WorldEngine } from '../engine/world-engine.js';
import type { EventType } from '../types/event.js';
import type { Timer } from '../types/timer.js';
import { formatStatusBoard } from './status-board-formatter.js';

export interface StatusBoardMessage {
  id: string;
}

export interface StatusBoardChannel {
  fetchMessages(): Promise<StatusBoardMessage[]>;
  bulkDelete(messageIds: string[]): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
  sendMessage(content: string): Promise<StatusBoardMessage>;
  sendMessageWithImage(content: string, image: Buffer, filename: string): Promise<StatusBoardMessage>;
}

const STATUS_TRIGGERING_EVENTS = new Set<EventType>([
  'agent_logged_in',
  'agent_logged_out',
  'movement_started',
  'movement_completed',
  'action_started',
  'action_completed',
  'wait_started',
  'wait_completed',
  'item_use_started',
  'item_use_completed',
  'conversation_accepted',
  'conversation_message',
  'conversation_turn_started',
  'conversation_closing',
  'conversation_rejected',
  'conversation_join',
  'conversation_leave',
  'conversation_inactive_check',
  'conversation_ended',
  'conversation_pending_join_cancelled',
  'transfer_requested',
  'transfer_accepted',
  'transfer_rejected',
  'transfer_timeout',
  'transfer_cancelled',
  'transfer_escrow_lost',
  'server_announcement_fired',
  'server_event_created',
  'server_event_cleared',
]);

export class StatusBoard {
  private unsubscribe: (() => void) | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private transitionTimer: ReturnType<typeof setTimeout> | null = null;
  private transitionRefreshRecalcQueued = false;
  private refreshInProgress = false;
  private dirtyWhileRefreshing = false;
  private immediateRefreshQueued = false;
  private refreshPromise: Promise<void> | null = null;
  private disposed = false;
  private lastMessages: string[] = [];
  private lastMessageIds: string[] = [];

  constructor(
    private readonly engine: WorldEngine,
    private readonly channel: StatusBoardChannel,
    private readonly options: {
      debounceMs: number;
      mapImage: Buffer | null;
      onError?: (message: string) => void;
    },
  ) {}

  register(): () => void {
    if (this.unsubscribe) {
      return this.unsubscribe;
    }

    this.disposed = false;
    const disposeEventSubscription = this.engine.eventBus.onAny((event) => {
      if (STATUS_TRIGGERING_EVENTS.has(event.type)) {
        this.scheduleRefresh();
        this.scheduleTransitionRefreshRecalculation();
      }
    });

    this.unsubscribe = () => {
      disposeEventSubscription();
      this.unsubscribe = null;
    };

    this.startRefresh();
    return this.unsubscribe;
  }

  async dispose(options?: { postStoppedMessage?: boolean }): Promise<void> {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.transitionTimer) {
      clearTimeout(this.transitionTimer);
      this.transitionTimer = null;
    }
    this.dirtyWhileRefreshing = false;
    this.immediateRefreshQueued = false;
    this.transitionRefreshRecalcQueued = false;
    this.unsubscribe?.();

    try {
      await this.refreshPromise;
    } catch (error) {
      // startRefresh() catches and logs errors from performRefresh().
      // Log here to surface unexpected failures from the promise chain itself.
      console.warn('Status board refresh promise rejected during dispose.', error);
    }

    if (options?.postStoppedMessage === false) {
      return;
    }

    try {
      this.lastMessageIds = await this.replaceMessages(['ワールド停止中'], false, await this.channel.fetchMessages());
      this.lastMessages = ['ワールド停止中'];
    } catch (error) {
      console.error('Failed to post stopped status board.', error);
    }
  }

  private scheduleRefresh(): void {
    this.queueRefresh(false);
  }

  private scheduleTransitionRefreshRecalculation(): void {
    if (this.disposed || this.transitionRefreshRecalcQueued) {
      return;
    }

    this.transitionRefreshRecalcQueued = true;
    queueMicrotask(() => {
      this.transitionRefreshRecalcQueued = false;
      if (this.disposed) {
        return;
      }

      this.scheduleNextTransitionRefresh();
    });
  }

  private queueRefresh(immediate: boolean): void {
    if (this.disposed) {
      return;
    }

    if (this.refreshInProgress) {
      this.dirtyWhileRefreshing = true;
      this.immediateRefreshQueued ||= immediate;
      return;
    }

    if (immediate) {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      this.startRefresh();
      return;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.startRefresh();
    }, this.options.debounceMs);
  }

  private startRefresh(): void {
    if (this.refreshInProgress || this.disposed) {
      return;
    }

    const refreshStartedAt = Date.now();
    const nextTransitionRefreshAt = this.getNextTransitionRefreshAt(refreshStartedAt);
    this.refreshInProgress = true;
    this.dirtyWhileRefreshing = false;
    this.refreshPromise = this.performRefresh()
      .catch((error) => {
        console.error('Failed to refresh status board.', error);
        this.options.onError?.(`ステータスボードの更新に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        const refreshCompletedAt = Date.now();
        const missedTransitionDuringRefresh = this.didTransitionBoundaryElapseDuringRefresh(
          nextTransitionRefreshAt,
          refreshStartedAt,
          refreshCompletedAt,
        );
        this.refreshInProgress = false;
        this.refreshPromise = null;
        if (!this.disposed && (this.dirtyWhileRefreshing || missedTransitionDuringRefresh)) {
          const shouldRefreshImmediately = missedTransitionDuringRefresh || this.immediateRefreshQueued;
          this.dirtyWhileRefreshing = false;
          this.immediateRefreshQueued = false;
          this.queueRefresh(shouldRefreshImmediately);
          return;
        }

        this.scheduleNextTransitionRefresh();
      });
  }

  private async performRefresh(): Promise<void> {
    const snapshot = this.engine.getSnapshot();
    const messages = formatStatusBoard(snapshot, this.engine.config.timezone);
    const existingMessages = await this.channel.fetchMessages();
    if (this.canSkipRefresh(messages, existingMessages)) {
      return;
    }

    this.lastMessageIds = await this.replaceMessages(
      messages,
      Boolean(this.options.mapImage),
      existingMessages,
    );
    this.lastMessages = [...messages];
  }

  private scheduleNextTransitionRefresh(): void {
    if (this.transitionTimer) {
      clearTimeout(this.transitionTimer);
      this.transitionTimer = null;
    }

    if (this.disposed) {
      return;
    }

    const refreshAt = this.getNextTransitionRefreshAt(Date.now());
    if (refreshAt === null) {
      return;
    }

    const delay = Math.max(0, refreshAt - Date.now());
    this.transitionTimer = setTimeout(() => {
      this.transitionTimer = null;
      this.queueRefresh(true);
    }, delay);
  }

  private getNextTransitionRefreshAt(now: number): number | null {
    const candidates = this.engine.timerManager
      .list()
      .map((timer) => this.getTimerRefreshAt(timer, now))
      .filter((value): value is number => value !== null);
    const weatherRefreshAt = this.getWeatherRefreshAt(now);
    if (weatherRefreshAt !== null) {
      candidates.push(weatherRefreshAt);
    }

    return candidates.length > 0 ? Math.min(...candidates) : null;
  }

  private getWeatherRefreshAt(now: number): number | null {
    if (!this.engine.config.weather) {
      return null;
    }

    const intervalMs = this.engine.config.weather.interval_ms ?? 1_800_000;
    const weather = this.engine.getWeatherState();
    return (weather?.fetched_at ?? now) + intervalMs + 1;
  }

  private getTimerRefreshAt(timer: Timer, now: number): number | null {
    switch (timer.type) {
      case 'movement':
        return this.getMovementRefreshAt(timer, now);
      case 'action':
      case 'wait':
      case 'item_use':
      case 'conversation_interval':
      case 'conversation_turn':
      case 'transfer':
        // +1ms: refresh after the timer fires so the snapshot reflects the completed state.
        return timer.fires_at + 1;
      case 'conversation_accept':
      case 'conversation_inactive_check':
      case 'idle_reminder':
        return null;
    }
  }

  private getMovementRefreshAt(timer: Extract<Timer, { type: 'movement' }>, now: number): number {
    const stepDuration = this.engine.config.movement.duration_ms;
    if (stepDuration <= 0 || timer.path.length === 0) {
      return timer.fires_at + 1;
    }

    const startedAt = timer.fires_at - timer.path.length * stepDuration;
    const nextStep = Math.max(1, Math.floor((now - startedAt) / stepDuration) + 1);
    const nextBoundary = startedAt + nextStep * stepDuration;
    return nextBoundary >= timer.fires_at ? timer.fires_at + 1 : Math.max(now, nextBoundary);
  }

  private didTransitionBoundaryElapseDuringRefresh(
    transitionRefreshAt: number | null,
    refreshStartedAt: number,
    refreshCompletedAt: number,
  ): boolean {
    return (
      transitionRefreshAt !== null &&
      transitionRefreshAt > refreshStartedAt &&
      transitionRefreshAt <= refreshCompletedAt
    );
  }

  private messagesEqual(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((message, index) => message === right[index]);
  }

  private canSkipRefresh(messages: string[], existingMessages: StatusBoardMessage[]): boolean {
    if (!this.messagesEqual(messages, this.lastMessages)) {
      return false;
    }

    if (this.lastMessageIds.length !== messages.length) {
      return false;
    }

    if (existingMessages.length !== this.lastMessageIds.length) {
      return false;
    }

    const existingMessageIds = new Set(existingMessages.map((message) => message.id));
    return this.lastMessageIds.every((messageId) => existingMessageIds.has(messageId));
  }

  private async replaceMessages(
    messages: string[],
    attachMapImage: boolean,
    existingMessages: StatusBoardMessage[],
  ): Promise<string[]> {
    if (existingMessages.length > 0) {
      const messageIds = existingMessages.map((message) => message.id);
      try {
        await this.channel.bulkDelete(messageIds);
      } catch (bulkDeleteError) {
        console.warn(`Bulk delete failed for ${messageIds.length} messages, falling back to individual deletes.`, bulkDeleteError);
        for (const message of existingMessages) {
          try {
            await this.channel.deleteMessage(message.id);
          } catch (error) {
            console.warn(`Failed to delete message ${message.id}.`, error);
          }
        }
      }
    }

    const sentMessageIds: string[] = [];
    try {
      for (const [index, message] of messages.entries()) {
        let sentMessage: StatusBoardMessage;
        if (index === 0 && attachMapImage && this.options.mapImage) {
          sentMessage = await this.channel.sendMessageWithImage(message, this.options.mapImage, 'world-map.png');
        } else {
          sentMessage = await this.channel.sendMessage(message);
        }
        sentMessageIds.push(sentMessage.id);
      }
    } catch (error) {
      this.lastMessageIds = sentMessageIds;
      this.lastMessages = [];
      throw error;
    }

    return sentMessageIds;
  }
}
