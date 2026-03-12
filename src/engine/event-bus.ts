import type { EventType, WorldEvent } from '../types/event.js';

type EventHandler<K extends EventType> = (event: Extract<WorldEvent, { type: K }>) => void;

type AnyEventHandler = (event: WorldEvent) => void;

export class EventBus {
  private readonly handlers = new Map<EventType, Set<(event: WorldEvent) => void>>();
  private readonly anyHandlers = new Set<AnyEventHandler>();

  constructor(private readonly logger: (line: string) => void = console.log) {}

  emit(event: WorldEvent): void {
    this.logger(JSON.stringify(event));

    this.handlers.get(event.type)?.forEach((handler) => {
      handler(event);
    });

    this.anyHandlers.forEach((handler) => {
      handler(event);
    });
  }

  on<K extends EventType>(type: K, handler: EventHandler<K>): () => void {
    const handlers = this.handlers.get(type) ?? new Set<(event: WorldEvent) => void>();
    handlers.add(handler as (event: WorldEvent) => void);
    this.handlers.set(type, handlers);

    return () => {
      handlers.delete(handler as (event: WorldEvent) => void);
      if (handlers.size === 0) {
        this.handlers.delete(type);
      }
    };
  }

  onAny(handler: AnyEventHandler): () => void {
    this.anyHandlers.add(handler);

    return () => {
      this.anyHandlers.delete(handler);
    };
  }
}
