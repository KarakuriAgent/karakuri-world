import type {
  SpectatorRecentServerEvent,
  SpectatorSnapshot,
} from '../../worker/src/contracts/spectator-snapshot.js';

export interface SidebarServerEvent extends SpectatorRecentServerEvent {
  is_active_now: boolean;
}

export function getOutstandingServerEventCount(snapshot?: SpectatorSnapshot): number {
  return snapshot?.server_events.length ?? 0;
}

export function getSidebarServerEvents(snapshot?: SpectatorSnapshot): SidebarServerEvent[] {
  if (!snapshot) {
    return [];
  }

  const activeServerEventIds = new Set(snapshot.server_events.map((serverEvent) => serverEvent.server_event_id));

  return snapshot.recent_server_events.slice(0, 3).map((event) => ({
    ...event,
    is_active_now: activeServerEventIds.has(event.server_event_id),
  }));
}
