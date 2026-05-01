import { describe, expect, it } from 'vitest';

import { ServerEventStore } from '../../../../src/engine/state/server-event-store.js';
import type { ServerEvent } from '../../../../src/types/server-event.js';

describe('ServerEventStore', () => {
  it('sorts list() by created_at then by server_event_id', () => {
    const store = new ServerEventStore();
    const earlier = store.create('first', 100);
    const later = store.create('second', 200);
    const sameTime = store.create('third', 100);

    const sorted = store.list();
    expect(sorted.map((event) => event.server_event_id)).toEqual(
      [earlier, sameTime].map((event) => event.server_event_id).sort().concat(later.server_event_id),
    );
  });

  it('listActive() excludes cleared events while list() retains them', () => {
    const store = new ServerEventStore();
    const a = store.create('a', 100);
    const b = store.create('b', 200);
    store.clear(a.server_event_id, 300);

    const active = store.listActive();
    expect(active.map((event) => event.server_event_id)).toEqual([b.server_event_id]);
    expect(active.every((event) => event.cleared_at === null)).toBe(true);
    expect(store.list()).toHaveLength(2);
  });

  it('clear() returns "cleared" the first time and "already_cleared" afterwards (idempotent)', () => {
    const store = new ServerEventStore();
    const event = store.create('festival', 100);

    const first = store.clear(event.server_event_id, 200);
    expect(first.status).toBe('cleared');
    if (first.status === 'cleared') {
      expect(first.event.cleared_at).toBe(200);
    }

    const second = store.clear(event.server_event_id, 999);
    expect(second.status).toBe('already_cleared');
    if (second.status === 'already_cleared') {
      expect(second.event.cleared_at).toBe(200);
    }
  });

  it('clear() returns "not_found" for unknown ids', () => {
    const store = new ServerEventStore();
    const result = store.clear('server-event-unknown');
    expect(result.status).toBe('not_found');
  });

  it('restoreFromSnapshot() fully replaces the underlying state and copies events', () => {
    const store = new ServerEventStore();
    store.create('to-be-replaced', 100);

    const mutable: { server_event_id: string; description: string; created_at: number; cleared_at: number | null }[] = [
      { server_event_id: 'server-event-keep-1', description: 'keep1', created_at: 50, cleared_at: null },
      { server_event_id: 'server-event-keep-2', description: 'keep2', created_at: 75, cleared_at: 80 },
    ];
    store.restoreFromSnapshot(mutable as ServerEvent[]);

    expect(store.list().map((event) => event.server_event_id)).toEqual([
      'server-event-keep-1',
      'server-event-keep-2',
    ]);
    expect(store.listActive().map((event) => event.server_event_id)).toEqual(['server-event-keep-1']);

    mutable[0]!.description = 'mutated';
    expect(store.get('server-event-keep-1')?.description).toBe('keep1');
  });

  it('serializeForPersistence() returns only active events', () => {
    const store = new ServerEventStore();
    const a = store.create('a', 100);
    store.create('b', 200);
    store.clear(a.server_event_id, 300);

    const persisted = store.serializeForPersistence();
    expect(persisted.map((event) => event.description)).toEqual(['b']);
    expect(persisted.every((event) => event.cleared_at === null)).toBe(true);
  });
});
