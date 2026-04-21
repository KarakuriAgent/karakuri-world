import type { RecentServerEventSnapshot } from '../../types/snapshot.js';

const DEFAULT_CAPACITY = 10;

export class RecentServerEventsStore {
  private readonly capacity: number;
  private readonly entries: RecentServerEventSnapshot[] = [];

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  add(entry: RecentServerEventSnapshot): void {
    const existingIndex = this.entries.findIndex((event) => event.server_event_id === entry.server_event_id);
    if (existingIndex !== -1) {
      this.entries.splice(existingIndex, 1);
    }

    this.entries.unshift({ ...entry });

    if (this.entries.length > this.capacity) {
      this.entries.length = this.capacity;
    }
  }

  has(serverEventId: string): boolean {
    return this.entries.some((event) => event.server_event_id === serverEventId);
  }

  setActive(serverEventId: string, isActive: boolean): void {
    const target = this.entries.find((event) => event.server_event_id === serverEventId);
    if (target) {
      target.is_active = isActive;
    }
  }

  list(): RecentServerEventSnapshot[] {
    return this.entries.map((event) => ({ ...event }));
  }
}
