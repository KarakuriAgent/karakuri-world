import { describe, expect, expectTypeOf, it } from 'vitest';

import type { EventType as BackendEventType } from '../../../server/src/types/event.js';
import { PERSISTED_SPECTATOR_EVENT_TYPES, type PersistedSpectatorEventType } from '../src/contracts/persisted-spectator-event.js';
import type { EventType as WorkerEventType } from '../src/contracts/world-event.js';
import {
  KNOWN_WORLD_EVENT_TYPES,
  NON_PERSISTED_WORLD_EVENT_TYPES,
} from '../src/relay/bridge.js';

const BACKEND_NON_PERSISTED_EVENT_TYPES = [
  'idle_reminder_fired',
  'map_info_requested',
  'world_agents_info_requested',
  'status_info_requested',
  'nearby_agents_info_requested',
  'active_conversations_info_requested',
  'perception_requested',
  'available_actions_requested',
] as const satisfies readonly Exclude<BackendEventType, PersistedSpectatorEventType>[];

describe('worker event contracts', () => {
  it('keeps the worker event union pinned to the backend event union', () => {
    expectTypeOf<WorkerEventType>().toEqualTypeOf<BackendEventType>();
  });

  it('keeps persisted spectator event types identical to bridge known world event types', () => {
    expectTypeOf<(typeof KNOWN_WORLD_EVENT_TYPES)[number]>().toEqualTypeOf<PersistedSpectatorEventType>();
    expect([...KNOWN_WORLD_EVENT_TYPES]).toEqual([...PERSISTED_SPECTATOR_EVENT_TYPES]);
  });

  it('keeps the explicit non-persisted backend events aligned with worker classification', () => {
    expectTypeOf<(typeof BACKEND_NON_PERSISTED_EVENT_TYPES)[number]>().toEqualTypeOf<
      Exclude<BackendEventType, PersistedSpectatorEventType>
    >();
    expect([...NON_PERSISTED_WORLD_EVENT_TYPES]).toEqual([...BACKEND_NON_PERSISTED_EVENT_TYPES]);
  });
});
