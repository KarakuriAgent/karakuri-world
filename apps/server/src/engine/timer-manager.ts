import type { Timer, TimerBase, TimerType } from '../types/timer.js';

type TimerHandler<K extends TimerType> = (timer: Extract<Timer, { type: K }>) => void;
type TimerCreateInput = Timer extends infer T ? (T extends Timer ? Omit<T, 'timer_id' | 'created_at'> : never) : never;
type MaterializedTimer<T extends TimerCreateInput> = T & Pick<TimerBase, 'timer_id' | 'created_at'>;

interface TimerRecord {
  timer: Timer;
  timeout: NodeJS.Timeout;
}

export class TimerManager {
  private readonly timers = new Map<string, TimerRecord>();
  private readonly handlers = new Map<TimerType, Set<(timer: Timer) => void>>();
  private sequence = 0;

  create<T extends TimerCreateInput>(timer: T): MaterializedTimer<T> {
    const materializedTimer = {
      ...timer,
      timer_id: `timer-${++this.sequence}`,
      created_at: Date.now(),
    };

    const delay = Math.max(0, materializedTimer.fires_at - Date.now());
    const timeout = setTimeout(() => {
      this.fire(materializedTimer.timer_id);
    }, delay);

    this.timers.set(materializedTimer.timer_id, {
      timer: materializedTimer,
      timeout,
    });

    return materializedTimer;
  }

  cancel(timerId: string): Timer | null {
    const record = this.timers.get(timerId);
    if (!record) {
      return null;
    }

    clearTimeout(record.timeout);
    this.timers.delete(timerId);
    return record.timer;
  }

  cancelByAgent(agentId: string): Timer[] {
    const timers = this.getByAgent(agentId);
    timers.forEach((timer) => {
      this.cancel(timer.timer_id);
    });
    return timers;
  }

  cancelByType(agentId: string, type: TimerType): Timer[] {
    const timers = this.getByAgent(agentId).filter((timer) => timer.type === type);
    timers.forEach((timer) => {
      this.cancel(timer.timer_id);
    });
    return timers;
  }

  getByAgent(agentId: string): Timer[] {
    return this.list().filter((timer) => timer.agent_ids.includes(agentId));
  }

  list(): Timer[] {
    return [...this.timers.values()]
      .map((record) => record.timer)
      .sort((left, right) => left.fires_at - right.fires_at);
  }

  clearAll(): void {
    for (const record of this.timers.values()) {
      clearTimeout(record.timeout);
    }
    this.timers.clear();
  }

  find<T extends Timer>(predicate: (timer: Timer) => timer is T): T | undefined;
  find(predicate: (timer: Timer) => boolean): Timer | undefined;
  find(predicate: ((timer: Timer) => boolean) | ((timer: Timer) => timer is Timer)): Timer | undefined {
    return this.list().find(predicate);
  }

  onFire<K extends TimerType>(type: K, handler: TimerHandler<K>): () => void {
    const handlers = this.handlers.get(type) ?? new Set<(timer: Timer) => void>();
    handlers.add(handler as (timer: Timer) => void);
    this.handlers.set(type, handlers);

    return () => {
      handlers.delete(handler as (timer: Timer) => void);
      if (handlers.size === 0) {
        this.handlers.delete(type);
      }
    };
  }

  private fire(timerId: string): void {
    const record = this.timers.get(timerId);
    if (!record) {
      return;
    }

    this.timers.delete(timerId);
    const handlers = this.handlers.get(record.timer.type);
    handlers?.forEach((handler) => {
      handler(record.timer);
    });
  }
}
