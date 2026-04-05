import { randomUUID } from 'node:crypto';

import type { WorldEngine } from '../engine/world-engine.js';
import type { FireServerEventResponse } from '../types/api.js';
import type { ServerEventInstance } from '../types/server-event.js';
import { cancelActiveAction } from './actions.js';
import { beginClosingConversation, cancelPendingConversationForServerEvent, findConversationByAgent } from './conversation.js';
import { cancelActiveItemUse } from './use-item.js';
import { cancelActiveWait } from './wait.js';

function maybeCleanupServerEvent(engine: WorldEngine, serverEventId: string): boolean {
  const serverEvent = engine.state.serverEvents.get(serverEventId);
  if (!serverEvent || serverEvent.pending_agent_ids.length > 0) {
    return false;
  }

  engine.state.serverEvents.delete(serverEventId);
  return true;
}

export function fireServerEvent(engine: WorldEngine, description: string): FireServerEventResponse {
  const serverEvent: ServerEventInstance = {
    server_event_id: `server-event-${randomUUID()}`,
    description,
    fired_at: Date.now(),
    delivered_agent_ids: [],
    pending_agent_ids: [],
  };

  for (const agent of engine.state.listLoggedIn()) {
    if (agent.state === 'moving') {
      engine.state.addPendingServerEvent(agent.agent_id, serverEvent.server_event_id);
      serverEvent.pending_agent_ids.push(agent.agent_id);
      continue;
    }

    engine.state.setActiveServerEvent(agent.agent_id, serverEvent.server_event_id);
    serverEvent.delivered_agent_ids.push(agent.agent_id);
  }

  engine.state.serverEvents.set(serverEvent);
  engine.emitEvent({
    type: 'server_event_fired',
    server_event_id: serverEvent.server_event_id,
    description: serverEvent.description,
    delivered_agent_ids: [...serverEvent.delivered_agent_ids],
    pending_agent_ids: [...serverEvent.pending_agent_ids],
    delayed: false,
  });
  maybeCleanupServerEvent(engine, serverEvent.server_event_id);

  return { server_event_id: serverEvent.server_event_id };
}

export function handlePendingServerEvents(engine: WorldEngine, agentId: string): string[] {
  const agent = engine.state.getLoggedIn(agentId);
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
    engine.state.setActiveServerEvent(agentId, serverEventId);
    deliveredServerEventIds.push(serverEventId);

    engine.emitEvent({
      type: 'server_event_fired',
      server_event_id: serverEvent.server_event_id,
      description: serverEvent.description,
      delivered_agent_ids: [agentId],
      pending_agent_ids: [],
      delayed: true,
    });

    maybeCleanupServerEvent(engine, serverEventId);
  }

  return deliveredServerEventIds;
}

export function clearActiveServerEvent(engine: WorldEngine, agentId: string): void {
  const agent = engine.state.getLoggedIn(agentId);
  if (!agent || agent.active_server_event_id === null) {
    return;
  }

  engine.state.clearActiveServerEvent(agentId);
}

export function handleServerEventInterruption(engine: WorldEngine, agentId: string): void {
  const agent = engine.state.getLoggedIn(agentId);
  if (!agent || agent.active_server_event_id === null) {
    return;
  }

  if (agent.pending_conversation_id) {
    cancelPendingConversationForServerEvent(engine, agentId);
  }

  const refreshedAgent = engine.state.getLoggedIn(agentId);
  if (!refreshedAgent) {
    return;
  }

  if (refreshedAgent.state === 'in_action') {
    cancelActiveAction(engine, agentId);
    cancelActiveWait(engine, agentId);
    cancelActiveItemUse(engine, agentId);
  } else if (refreshedAgent.state === 'in_conversation') {
    const conversation = findConversationByAgent(engine, agentId, ['active', 'closing']);
    if (conversation && conversation.status !== 'closing') {
      if (refreshedAgent.pending_conversation_id === conversation.conversation_id) {
        engine.state.setPendingConversation(agentId, null);
      }
      const partnerId = conversation.initiator_agent_id === agentId
        ? conversation.target_agent_id
        : conversation.initiator_agent_id;
      beginClosingConversation(engine, conversation.conversation_id, partnerId, 'server_event');
    }
  }

  engine.state.setState(agentId, 'idle');
  clearActiveServerEvent(engine, agentId);
}

export function cleanupServerEventsForAgent(engine: WorldEngine, agentId: string): void {
  clearActiveServerEvent(engine, agentId);
  for (const serverEvent of engine.state.serverEvents.list()) {
    serverEvent.pending_agent_ids = serverEvent.pending_agent_ids.filter((id) => id !== agentId);
    serverEvent.delivered_agent_ids = serverEvent.delivered_agent_ids.filter((id) => id !== agentId);
    maybeCleanupServerEvent(engine, serverEvent.server_event_id);
  }
}
