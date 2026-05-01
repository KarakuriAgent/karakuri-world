import { randomUUID } from 'node:crypto';

import type { ActiveServerEvent, ClearedServerEvent, ServerEvent } from '../../types/server-event.js';
import { isServerEventActive } from '../../types/server-event.js';

export type ClearResult =
  | { readonly status: 'cleared'; readonly event: ClearedServerEvent }
  | { readonly status: 'already_cleared'; readonly event: ClearedServerEvent }
  | { readonly status: 'not_found' };

export class ServerEventStore {
  private readonly events = new Map<string, ServerEvent>();

  list(): ServerEvent[] {
    return [...this.events.values()].sort(
      (left, right) => left.created_at - right.created_at || left.server_event_id.localeCompare(right.server_event_id),
    );
  }

  listActive(): ActiveServerEvent[] {
    return this.list().filter(isServerEventActive);
  }

  get(eventId: string): ServerEvent | null {
    return this.events.get(eventId) ?? null;
  }

  create(description: string, now = Date.now()): ActiveServerEvent {
    const event: ActiveServerEvent = {
      server_event_id: `server-event-${randomUUID()}`,
      description,
      created_at: now,
      cleared_at: null,
    };
    this.events.set(event.server_event_id, event);
    return event;
  }

  clear(eventId: string, now = Date.now()): ClearResult {
    const event = this.events.get(eventId);
    if (!event) {
      return { status: 'not_found' };
    }
    if (event.cleared_at !== null) {
      return { status: 'already_cleared', event: event as ClearedServerEvent };
    }
    const cleared: ClearedServerEvent = { ...event, cleared_at: now };
    this.events.set(eventId, cleared);
    return { status: 'cleared', event: cleared };
  }

  restoreFromSnapshot(events: readonly ServerEvent[]): void {
    this.events.clear();
    for (const event of events) {
      this.events.set(event.server_event_id, { ...event });
    }
  }

  serializeForPersistence(): ActiveServerEvent[] {
    return this.listActive();
  }
}
