import type { ServerEventInstance } from '../../types/server-event.js';

export class ServerEventStateStore {
  private readonly serverEvents = new Map<string, ServerEventInstance>();

  set(serverEvent: ServerEventInstance): ServerEventInstance {
    this.serverEvents.set(serverEvent.server_event_id, serverEvent);
    return serverEvent;
  }

  get(serverEventId: string): ServerEventInstance | null {
    return this.serverEvents.get(serverEventId) ?? null;
  }

  delete(serverEventId: string): ServerEventInstance | null {
    const serverEvent = this.serverEvents.get(serverEventId) ?? null;
    if (serverEvent) {
      this.serverEvents.delete(serverEventId);
    }
    return serverEvent;
  }

  list(): ServerEventInstance[] {
    return [...this.serverEvents.values()].sort((left, right) => left.server_event_id.localeCompare(right.server_event_id));
  }
}
