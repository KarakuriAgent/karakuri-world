import { randomUUID } from 'node:crypto';

import type { WorldEngine } from '../engine/world-engine.js';
import type { FireServerEventResponse, OkResponse, ServerEventSelectRequest } from '../types/api.js';
import { WorldError } from '../types/api.js';
import type { ServerEventInstance } from '../types/server-event.js';
import type { ServerEventTimeoutTimer } from '../types/timer.js';
import { cancelActiveAction } from './actions.js';
import { beginClosingConversation, findConversationByAgent } from './conversation.js';
import { cancelActiveWait } from './wait.js';

function createTimeoutTimer(engine: WorldEngine, agentId: string, serverEvent: ServerEventInstance): void {
  engine.timerManager.create({
    type: 'server_event_timeout',
    agent_ids: [agentId],
    agent_id: agentId,
    server_event_id: serverEvent.server_event_id,
    event_id: serverEvent.event_id,
    fires_at: Date.now() + serverEvent.timeout_ms,
  });
}

function maybeCleanupServerEvent(engine: WorldEngine, serverEventId: string): void {
  const hasPending = engine.state
    .listJoined()
    .some((agent) => agent.pending_server_event_ids.includes(serverEventId));
  const hasTimeout = engine.timerManager
    .list()
    .some((timer) => timer.type === 'server_event_timeout' && timer.server_event_id === serverEventId);

  if (!hasPending && !hasTimeout) {
    engine.state.serverEvents.delete(serverEventId);
  }
}

export function fireServerEvent(engine: WorldEngine, eventId: string): FireServerEventResponse {
  const configEvent = engine.config.server_events.find((serverEvent) => serverEvent.event_id === eventId);
  if (!configEvent) {
    throw new WorldError(404, 'event_not_found', `Unknown server event: ${eventId}`);
  }

  const serverEvent: ServerEventInstance = {
    server_event_id: `server-event-${randomUUID()}`,
    event_id: configEvent.event_id,
    name: configEvent.name,
    description: configEvent.description,
    choices: structuredClone(configEvent.choices),
    timeout_ms: configEvent.timeout_ms,
    fired_at: Date.now(),
    delivered_agent_ids: [],
    pending_agent_ids: [],
  };

  for (const agent of engine.state.listJoined()) {
    if (agent.state === 'moving') {
      engine.state.addPendingServerEvent(agent.agent_id, serverEvent.server_event_id);
      serverEvent.pending_agent_ids.push(agent.agent_id);
      continue;
    }

    createTimeoutTimer(engine, agent.agent_id, serverEvent);
    serverEvent.delivered_agent_ids.push(agent.agent_id);
  }

  engine.state.serverEvents.set(serverEvent);
  engine.emitEvent({
    type: 'server_event_fired',
    server_event_id: serverEvent.server_event_id,
    event_id_ref: serverEvent.event_id,
    name: serverEvent.name,
    description: serverEvent.description,
    choices: serverEvent.choices,
    delivered_agent_ids: [...serverEvent.delivered_agent_ids],
    pending_agent_ids: [...serverEvent.pending_agent_ids],
    delayed: false,
  });

  return { server_event_id: serverEvent.server_event_id };
}

export function handlePendingServerEvents(engine: WorldEngine, agentId: string): string[] {
  const agent = engine.state.getJoined(agentId);
  if (!agent) {
    return [];
  }

  const deliveredServerEventIds: string[] = [];
  for (const serverEventId of [...agent.pending_server_event_ids]) {
    const serverEvent = engine.state.serverEvents.get(serverEventId);
    engine.state.removePendingServerEvent(agentId, serverEventId);
    if (!serverEvent) {
      continue;
    }

    serverEvent.pending_agent_ids = serverEvent.pending_agent_ids.filter((id) => id !== agentId);
    if (!serverEvent.delivered_agent_ids.includes(agentId)) {
      serverEvent.delivered_agent_ids.push(agentId);
      serverEvent.delivered_agent_ids.sort();
    }
    createTimeoutTimer(engine, agentId, serverEvent);
    deliveredServerEventIds.push(serverEventId);

    engine.emitEvent({
      type: 'server_event_fired',
      server_event_id: serverEvent.server_event_id,
      event_id_ref: serverEvent.event_id,
      name: serverEvent.name,
      description: serverEvent.description,
      choices: serverEvent.choices,
      delivered_agent_ids: [agentId],
      pending_agent_ids: [],
      delayed: true,
    });
  }

  return deliveredServerEventIds.sort();
}

export function selectServerEvent(engine: WorldEngine, agentId: string, request: ServerEventSelectRequest): OkResponse {
  const agent = engine.state.getJoined(agentId);
  if (!agent) {
    throw new WorldError(403, 'not_joined', `Agent is not joined: ${agentId}`);
  }

  const sourceState = agent.state;
  if (sourceState !== 'idle' && sourceState !== 'in_action' && sourceState !== 'in_conversation') {
    throw new WorldError(409, 'state_conflict', 'Agent cannot select a server event right now.');
  }

  const conversation = sourceState === 'in_conversation' ? findConversationByAgent(engine, agentId, ['active', 'closing']) : null;
  if (conversation?.status === 'closing') {
    throw new WorldError(400, 'conversation_closing', 'Conversation is already in closing state.');
  }

  const serverEvent = engine.state.serverEvents.get(request.server_event_id);
  if (!serverEvent) {
    throw new WorldError(400, 'event_not_found', `Server event not found: ${request.server_event_id}`);
  }

  const choice = serverEvent.choices.find((candidate) => candidate.choice_id === request.choice_id);
  if (!choice) {
    throw new WorldError(400, 'invalid_choice', `Invalid server event choice: ${request.choice_id}`);
  }

  const timeoutTimer = engine.timerManager.find(
    (timer): timer is ServerEventTimeoutTimer =>
      timer.type === 'server_event_timeout' &&
      timer.agent_id === agentId &&
      timer.server_event_id === request.server_event_id,
  );
  if (!timeoutTimer) {
    throw new WorldError(400, 'event_not_found', `Server event not found: ${request.server_event_id}`);
  }

  engine.timerManager.cancel(timeoutTimer.timer_id);
  if (sourceState === 'in_action') {
    cancelActiveAction(engine, agentId);
    cancelActiveWait(engine, agentId);
  } else if (sourceState === 'in_conversation' && conversation) {
    beginClosingConversation(engine, conversation.conversation_id, agentId, 'server_event');
  }

  engine.emitEvent({
    type: 'server_event_selected',
    server_event_id: serverEvent.server_event_id,
    event_id_ref: serverEvent.event_id,
    name: serverEvent.name,
    agent_id: agentId,
    choice_id: choice.choice_id,
    choice_label: choice.label,
    source_state: sourceState,
  });

  maybeCleanupServerEvent(engine, serverEvent.server_event_id);
  return { status: 'ok' };
}

export function handleServerEventTimeout(engine: WorldEngine, timer: ServerEventTimeoutTimer): void {
  maybeCleanupServerEvent(engine, timer.server_event_id);
}

export function cleanupServerEventsForAgent(engine: WorldEngine, agentId: string): void {
  for (const serverEvent of engine.state.serverEvents.list()) {
    serverEvent.pending_agent_ids = serverEvent.pending_agent_ids.filter((id) => id !== agentId);
    serverEvent.delivered_agent_ids = serverEvent.delivered_agent_ids.filter((id) => id !== agentId);
    maybeCleanupServerEvent(engine, serverEvent.server_event_id);
  }
}
