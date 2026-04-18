import type {
  SpectatorRecentServerEvent,
  SpectatorSnapshot,
} from '../../worker/src/contracts/spectator-snapshot.js';

export interface SidebarServerEvent extends SpectatorRecentServerEvent {
  is_active_now: boolean;
}

export interface SidebarServerEventsState {
  events: SidebarServerEvent[];
  is_degraded_fallback: boolean;
}

export function getOutstandingServerEventCount(snapshot?: SpectatorSnapshot): number {
  return snapshot?.server_events.length ?? 0;
}

export function getSidebarServerEventsState(snapshot?: SpectatorSnapshot): SidebarServerEventsState {
  if (!snapshot) {
    return {
      events: [],
      is_degraded_fallback: false,
    };
  }

  const activeServerEventIds = new Set(snapshot.server_events.map((serverEvent) => serverEvent.server_event_id));
  const recentServerEvents = snapshot.recent_server_events.slice(0, 3).map((event) => ({
    ...event,
    is_active_now: activeServerEventIds.has(event.server_event_id),
  }));

  if (recentServerEvents.length > 0) {
    return {
      events: recentServerEvents,
      is_degraded_fallback: false,
    };
  }

  return {
    events: snapshot.server_events.slice(0, 3).map((event) => ({
      server_event_id: event.server_event_id,
      description: event.description,
      occurred_at: snapshot.generated_at,
      is_active: true,
      is_active_now: true,
    })),
    is_degraded_fallback: snapshot.server_events.length > 0,
  };
}

export function getSidebarServerEvents(snapshot?: SpectatorSnapshot): SidebarServerEvent[] {
  return getSidebarServerEventsState(snapshot).events;
}
