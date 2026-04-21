import type {
  SpectatorRecentServerEvent,
  SpectatorSnapshot,
} from '../../worker/src/contracts/spectator-snapshot.js';

export type SidebarServerEvent = SpectatorRecentServerEvent;

export function getSidebarServerEvents(snapshot?: SpectatorSnapshot): SidebarServerEvent[] {
  if (!snapshot) {
    return [];
  }

  return snapshot.recent_server_events.slice(0, 3);
}
