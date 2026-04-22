import { describe, expect, it } from 'vitest';

import { getSidebarServerEvents } from '../lib/recent-server-events.js';
import { createFixtureSnapshot } from './fixtures/snapshot.js';

describe('recent server events', () => {
  it('returns an empty array when recent_server_events is empty', () => {
    const snapshot = createFixtureSnapshot();
    snapshot.recent_server_events = [];

    expect(getSidebarServerEvents(snapshot)).toEqual([]);
  });

  it('returns up to 3 recent server events', () => {
    const snapshot = createFixtureSnapshot();
    snapshot.recent_server_events = [
      {
        server_event_id: 'event-1',
        description: 'First event',
        occurred_at: 1_780_000_000_000,
        is_active: true,
      },
      {
        server_event_id: 'event-2',
        description: 'Second event',
        occurred_at: 1_780_000_010_000,
        is_active: false,
      },
      {
        server_event_id: 'event-3',
        description: 'Third event',
        occurred_at: 1_780_000_020_000,
        is_active: true,
      },
      {
        server_event_id: 'event-4',
        description: 'Fourth event (should be truncated)',
        occurred_at: 1_780_000_030_000,
        is_active: false,
      },
    ];

    const events = getSidebarServerEvents(snapshot);
    expect(events).toHaveLength(3);
    expect(events[0].server_event_id).toBe('event-1');
    expect(events[1].server_event_id).toBe('event-2');
    expect(events[2].server_event_id).toBe('event-3');
  });

  it('returns undefined snapshot returns empty array', () => {
    expect(getSidebarServerEvents(undefined)).toEqual([]);
  });
});
