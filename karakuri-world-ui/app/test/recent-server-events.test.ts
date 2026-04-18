import { describe, expect, it } from 'vitest';

import { getSidebarServerEvents, getSidebarServerEventsState } from '../lib/recent-server-events.js';
import { createFixtureSnapshot } from './fixtures/snapshot.js';

describe('recent server events', () => {
  it('falls back to active server_events when recent_server_events is empty', () => {
    const snapshot = createFixtureSnapshot();
    snapshot.recent_server_events = [];
    snapshot.server_events = [
      {
        server_event_id: 'event-active',
        description: 'Active festival',
        delivered_agent_ids: ['alice'],
        pending_agent_ids: [],
      },
    ];

    expect(getSidebarServerEvents(snapshot)).toEqual([
      {
        server_event_id: 'event-active',
        description: 'Active festival',
        occurred_at: snapshot.generated_at,
        is_active: true,
        is_active_now: true,
      },
    ]);
    expect(getSidebarServerEventsState(snapshot).is_degraded_fallback).toBe(true);
  });
});
