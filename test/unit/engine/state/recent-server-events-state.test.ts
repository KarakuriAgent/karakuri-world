import { describe, expect, it } from 'vitest';

import { RecentServerEventsStore } from '../../../../src/engine/state/recent-server-events-state.js';

describe('RecentServerEventsStore', () => {
  it('inserts new entries at the front in insertion order', () => {
    const store = new RecentServerEventsStore();
    store.add({ server_event_id: 'e1', description: 'first', occurred_at: 1, is_active: true });
    store.add({ server_event_id: 'e2', description: 'second', occurred_at: 2, is_active: true });

    expect(store.list().map((event) => event.server_event_id)).toEqual(['e2', 'e1']);
  });

  it('moves an existing entry to the front when re-added and refreshes its payload', () => {
    const store = new RecentServerEventsStore();
    store.add({ server_event_id: 'e1', description: 'first', occurred_at: 1, is_active: false });
    store.add({ server_event_id: 'e2', description: 'second', occurred_at: 2, is_active: true });
    store.add({ server_event_id: 'e1', description: 'first-again', occurred_at: 3, is_active: true });

    expect(store.list()).toEqual([
      { server_event_id: 'e1', description: 'first-again', occurred_at: 3, is_active: true },
      { server_event_id: 'e2', description: 'second', occurred_at: 2, is_active: true },
    ]);
  });

  it('caps the ring buffer at the configured capacity, dropping the oldest entries', () => {
    const store = new RecentServerEventsStore(3);
    for (let index = 0; index < 5; index += 1) {
      store.add({
        server_event_id: `e${index}`,
        description: String(index),
        occurred_at: index,
        is_active: true,
      });
    }

    expect(store.list().map((event) => event.server_event_id)).toEqual(['e4', 'e3', 'e2']);
  });

  it('defaults the capacity to 10', () => {
    const store = new RecentServerEventsStore();
    for (let index = 0; index < 12; index += 1) {
      store.add({
        server_event_id: `e${index}`,
        description: String(index),
        occurred_at: index,
        is_active: true,
      });
    }

    expect(store.list()).toHaveLength(10);
    expect(store.list()[0]?.server_event_id).toBe('e11');
    expect(store.list()[9]?.server_event_id).toBe('e2');
  });

  it('reports membership via has() and leaves list() cloned so mutations do not leak state', () => {
    const store = new RecentServerEventsStore();
    store.add({ server_event_id: 'e1', description: 'first', occurred_at: 1, is_active: true });

    expect(store.has('e1')).toBe(true);
    expect(store.has('missing')).toBe(false);

    const snapshot = store.list();
    snapshot[0]!.description = 'mutated';
    expect(store.list()[0]!.description).toBe('first');
  });

  it('updates is_active in place without reordering the entry', () => {
    const store = new RecentServerEventsStore();
    store.add({ server_event_id: 'e1', description: 'first', occurred_at: 1, is_active: true });
    store.add({ server_event_id: 'e2', description: 'second', occurred_at: 2, is_active: true });

    store.setActive('e1', false);

    expect(store.list()).toEqual([
      { server_event_id: 'e2', description: 'second', occurred_at: 2, is_active: true },
      { server_event_id: 'e1', description: 'first', occurred_at: 1, is_active: false },
    ]);
  });

  it('ignores setActive calls for missing entries', () => {
    const store = new RecentServerEventsStore();
    store.add({ server_event_id: 'e1', description: 'first', occurred_at: 1, is_active: true });

    store.setActive('missing', false);

    expect(store.list()).toEqual([
      { server_event_id: 'e1', description: 'first', occurred_at: 1, is_active: true },
    ]);
  });
});
