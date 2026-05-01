import type { ServerAnnouncementInstance } from '../../types/server-announcement.js';

export class ServerAnnouncementStateStore {
  private readonly serverAnnouncements = new Map<string, ServerAnnouncementInstance>();

  set(serverAnnouncement: ServerAnnouncementInstance): ServerAnnouncementInstance {
    this.serverAnnouncements.set(serverAnnouncement.server_announcement_id, serverAnnouncement);
    return serverAnnouncement;
  }

  get(serverAnnouncementId: string): ServerAnnouncementInstance | null {
    return this.serverAnnouncements.get(serverAnnouncementId) ?? null;
  }

  delete(serverAnnouncementId: string): ServerAnnouncementInstance | null {
    const serverAnnouncement = this.serverAnnouncements.get(serverAnnouncementId) ?? null;
    if (serverAnnouncement) {
      this.serverAnnouncements.delete(serverAnnouncementId);
    }
    return serverAnnouncement;
  }

  list(): ServerAnnouncementInstance[] {
    return [...this.serverAnnouncements.values()].sort(
      (left, right) => left.fired_at - right.fired_at || left.server_announcement_id.localeCompare(right.server_announcement_id),
    );
  }
}
