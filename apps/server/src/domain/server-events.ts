import type { WorldEngine } from '../engine/world-engine.js';
import { WorldError } from '../types/api.js';
import type { ActiveServerEvent, ClearedServerEvent, ServerEvent } from '../types/server-event.js';

export function createServerEvent(engine: WorldEngine, description: string): ActiveServerEvent {
  const previousEvents = engine.state.serverEvents.list();
  const event = engine.state.serverEvents.create(description);
  try {
    engine.persistServerEvents();
  } catch (error) {
    engine.state.serverEvents.restoreFromSnapshot(previousEvents);
    const message = error instanceof Error ? error.message : String(error);
    engine.reportError(`server-events.json への永続化に失敗しました (create): ${message}`);
    throw error;
  }
  engine.state.clearInfoCommandFromAllAgents('get_event');
  engine.emitEvent({ type: 'server_event_created', server_event: event });
  return event;
}

export function listServerEvents(engine: WorldEngine, includeCleared = false): ServerEvent[] {
  return includeCleared ? engine.state.serverEvents.list() : engine.state.serverEvents.listActive();
}

export function clearServerEvent(engine: WorldEngine, eventId: string): ClearedServerEvent {
  const previousEvents = engine.state.serverEvents.list();
  const result = engine.state.serverEvents.clear(eventId);
  if (result.status === 'not_found') {
    throw new WorldError(404, 'not_found', 'Server event not found.');
  }
  if (result.status === 'already_cleared') {
    throw new WorldError(409, 'already_cleared', 'Server event is already cleared.');
  }
  try {
    engine.persistServerEvents();
  } catch (error) {
    engine.state.serverEvents.restoreFromSnapshot(previousEvents);
    const message = error instanceof Error ? error.message : String(error);
    engine.reportError(`server-events.json への永続化に失敗しました (clear): ${message}`);
    throw error;
  }
  engine.state.clearInfoCommandFromAllAgents('get_event');
  engine.emitEvent({ type: 'server_event_cleared', server_event: result.event });
  return result.event;
}
