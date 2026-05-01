import type { RecentServerAnnouncementSnapshot } from '../../types/snapshot.js';

const DEFAULT_CAPACITY = 10;

export class RecentServerAnnouncementsStore {
  private readonly capacity: number;
  private readonly entries: RecentServerAnnouncementSnapshot[] = [];

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  add(entry: RecentServerAnnouncementSnapshot): void {
    const existingIndex = this.entries.findIndex((event) => event.server_announcement_id === entry.server_announcement_id);
    if (existingIndex !== -1) {
      this.entries.splice(existingIndex, 1);
    }

    this.entries.unshift({ ...entry });

    if (this.entries.length > this.capacity) {
      this.entries.length = this.capacity;
    }
  }

  has(serverAnnouncementId: string): boolean {
    return this.entries.some((event) => event.server_announcement_id === serverAnnouncementId);
  }

  setActive(serverAnnouncementId: string, isActive: boolean): void {
    const target = this.entries.find((event) => event.server_announcement_id === serverAnnouncementId);
    if (target) {
      target.is_active = isActive;
    }
  }

  list(): RecentServerAnnouncementSnapshot[] {
    return this.entries.map((event) => ({ ...event }));
  }
}
