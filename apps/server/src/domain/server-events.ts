import { randomUUID } from 'node:crypto';

import type { WorldEngine } from '../engine/world-engine.js';
import type { FireServerEventResponse } from '../types/api.js';
import type { ServerEventInstance } from '../types/server-event.js';
import { cancelActiveAction } from './actions.js';
import {
  beginClosingConversation,
  cancelPendingConversationForServerEvent,
  detachPendingJoiner,
  detachParticipantFromClosingConversation,
  findConversationByAgent,
  getConversationActionableSpeaker,
} from './conversation.js';
import { cancelActiveItemUse } from './use-item.js';
import { cancelTransfer } from './transfer.js';
import { cancelActiveWait } from './wait.js';

function maybeCleanupServerEvent(engine: WorldEngine, serverEventId: string): boolean {
  const serverEvent = engine.state.serverEvents.get(serverEventId);
  if (!serverEvent || serverEvent.pending_agent_ids.length > 0) {
    return false;
  }

  engine.state.serverEvents.delete(serverEventId);
  engine.state.recentServerEvents.setActive(serverEventId, false);
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
    engine.state.clearExcludedInfoCommands(agent.agent_id);
    serverEvent.delivered_agent_ids.push(agent.agent_id);
  }

  engine.state.serverEvents.set(serverEvent);
  engine.state.recentServerEvents.add({
    server_event_id: serverEvent.server_event_id,
    description: serverEvent.description,
    occurred_at: serverEvent.fired_at,
    is_active: true,
  });
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
    engine.state.clearExcludedInfoCommands(agentId);
    deliveredServerEventIds.push(serverEventId);

    if (engine.state.recentServerEvents.has(serverEventId)) {
      engine.state.recentServerEvents.setActive(serverEventId, true);
    } else {
      engine.state.recentServerEvents.add({
        server_event_id: serverEvent.server_event_id,
        description: serverEvent.description,
        occurred_at: serverEvent.fired_at,
        is_active: true,
      });
    }

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

function getNextConversationSpeakerAfterInterruption(
  participantAgentIds: string[],
  interruptedAgentId: string,
  skipAgentId?: string,
): string | null {
  if (participantAgentIds.length === 0) {
    return null;
  }

  const interruptedIndex = participantAgentIds.indexOf(interruptedAgentId);
  if (interruptedIndex !== -1) {
    for (let offset = 1; offset < participantAgentIds.length; offset += 1) {
      const candidate = participantAgentIds[(interruptedIndex + offset) % participantAgentIds.length];
      if (candidate && candidate !== interruptedAgentId && candidate !== skipAgentId) {
        return candidate;
      }
    }
  }

  return participantAgentIds.find((participantId) => participantId !== interruptedAgentId && participantId !== skipAgentId)
    ?? participantAgentIds.find((participantId) => participantId !== interruptedAgentId)
    ?? null;
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
  } else if (refreshedAgent.state === 'in_transfer') {
    const transferId = refreshedAgent.active_transfer_id ?? refreshedAgent.pending_transfer_id;
    if (transferId) {
      cancelTransfer(engine, transferId, 'server_event');
    }
    clearActiveServerEvent(engine, agentId);
    return;
  } else if (refreshedAgent.state === 'in_conversation') {
    const conversation = findConversationByAgent(engine, agentId, ['active', 'closing']);
    if (conversation) {
      if (detachPendingJoiner(engine, conversation.conversation_id, agentId, false)) {
        engine.emitEvent({
          type: 'conversation_pending_join_cancelled',
          conversation_id: conversation.conversation_id,
          agent_id: agentId,
          reason: 'server_event',
        });
        engine.state.setState(agentId, 'idle');
        clearActiveServerEvent(engine, agentId);
        return;
      }

      const actionableSpeakerAgentId = getConversationActionableSpeaker(conversation);
      const partnerId = actionableSpeakerAgentId && actionableSpeakerAgentId !== agentId
        ? actionableSpeakerAgentId
        : conversation.participant_agent_ids.find((participantId) => participantId !== agentId)
          ?? getNextConversationSpeakerAfterInterruption(
            conversation.participant_agent_ids,
            agentId,
            conversation.inactive_check_pending_agent_ids.length > 0 ? conversation.current_speaker_agent_id : undefined,
          )
          ?? conversation.current_speaker_agent_id;
      if (conversation.status === 'closing') {
        detachParticipantFromClosingConversation(engine, conversation.conversation_id, agentId);
      } else {
        if (refreshedAgent.pending_conversation_id === conversation.conversation_id) {
          engine.state.setPendingConversation(agentId, null);
        }
        beginClosingConversation(engine, conversation.conversation_id, partnerId, 'server_event', agentId);
      }
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
