import { randomUUID } from 'node:crypto';

import type { WorldEngine } from '../engine/world-engine.js';
import type { FireServerAnnouncementResponse } from '../types/api.js';
import type { ServerAnnouncementInstance } from '../types/server-announcement.js';
import { cancelActiveAction } from './actions.js';
import {
  beginClosingConversation,
  cancelPendingConversationForServerAnnouncement,
  detachPendingJoiner,
  detachParticipantFromClosingConversation,
  findConversationByAgent,
  getConversationActionableSpeaker,
} from './conversation.js';
import { cancelActiveItemUse } from './use-item.js';
import { cancelTransfer } from './transfer.js';
import { cancelActiveWait } from './wait.js';

function maybeCleanupServerAnnouncement(engine: WorldEngine, serverAnnouncementId: string): boolean {
  const serverAnnouncement = engine.state.serverAnnouncements.get(serverAnnouncementId);
  if (!serverAnnouncement || serverAnnouncement.pending_agent_ids.length > 0) {
    return false;
  }

  engine.state.serverAnnouncements.delete(serverAnnouncementId);
  engine.state.recentServerAnnouncements.setActive(serverAnnouncementId, false);
  return true;
}

export function fireServerAnnouncement(engine: WorldEngine, description: string): FireServerAnnouncementResponse {
  const serverAnnouncement: ServerAnnouncementInstance = {
    server_announcement_id: `server-announcement-${randomUUID()}`,
    description,
    fired_at: Date.now(),
    delivered_agent_ids: [],
    pending_agent_ids: [],
  };

  for (const agent of engine.state.listLoggedIn()) {
    if (agent.state === 'moving') {
      engine.state.addPendingServerAnnouncement(agent.agent_id, serverAnnouncement.server_announcement_id);
      serverAnnouncement.pending_agent_ids.push(agent.agent_id);
      continue;
    }

    engine.state.setActiveServerAnnouncement(agent.agent_id, serverAnnouncement.server_announcement_id);
    engine.state.clearExcludedInfoCommands(agent.agent_id);
    serverAnnouncement.delivered_agent_ids.push(agent.agent_id);
  }

  engine.state.serverAnnouncements.set(serverAnnouncement);
  engine.state.recentServerAnnouncements.add({
    server_announcement_id: serverAnnouncement.server_announcement_id,
    description: serverAnnouncement.description,
    occurred_at: serverAnnouncement.fired_at,
    is_active: true,
  });
  engine.emitEvent({
    type: 'server_announcement_fired',
    server_announcement_id: serverAnnouncement.server_announcement_id,
    description: serverAnnouncement.description,
    delivered_agent_ids: [...serverAnnouncement.delivered_agent_ids],
    pending_agent_ids: [...serverAnnouncement.pending_agent_ids],
    delayed: false,
  });
  maybeCleanupServerAnnouncement(engine, serverAnnouncement.server_announcement_id);

  return { server_announcement_id: serverAnnouncement.server_announcement_id };
}

export function handlePendingServerAnnouncements(engine: WorldEngine, agentId: string): string[] {
  const agent = engine.state.getLoggedIn(agentId);
  if (!agent) {
    return [];
  }

  const deliveredServerAnnouncementIds: string[] = [];
  for (const serverAnnouncementId of [...agent.pending_server_announcement_ids]) {
    const serverAnnouncement = engine.state.serverAnnouncements.get(serverAnnouncementId);
    engine.state.removePendingServerAnnouncement(agentId, serverAnnouncementId);
    if (!serverAnnouncement) {
      continue;
    }

    serverAnnouncement.pending_agent_ids = serverAnnouncement.pending_agent_ids.filter((id) => id !== agentId);
    if (!serverAnnouncement.delivered_agent_ids.includes(agentId)) {
      serverAnnouncement.delivered_agent_ids.push(agentId);
      serverAnnouncement.delivered_agent_ids.sort();
    }
    engine.state.setActiveServerAnnouncement(agentId, serverAnnouncementId);
    engine.state.clearExcludedInfoCommands(agentId);
    deliveredServerAnnouncementIds.push(serverAnnouncementId);

    if (engine.state.recentServerAnnouncements.has(serverAnnouncementId)) {
      engine.state.recentServerAnnouncements.setActive(serverAnnouncementId, true);
    } else {
      engine.state.recentServerAnnouncements.add({
        server_announcement_id: serverAnnouncement.server_announcement_id,
        description: serverAnnouncement.description,
        occurred_at: serverAnnouncement.fired_at,
        is_active: true,
      });
    }

    engine.emitEvent({
      type: 'server_announcement_fired',
      server_announcement_id: serverAnnouncement.server_announcement_id,
      description: serverAnnouncement.description,
      delivered_agent_ids: [agentId],
      pending_agent_ids: [],
      delayed: true,
    });

    maybeCleanupServerAnnouncement(engine, serverAnnouncementId);
  }

  return deliveredServerAnnouncementIds;
}

export function clearActiveServerAnnouncement(engine: WorldEngine, agentId: string): void {
  const agent = engine.state.getLoggedIn(agentId);
  if (!agent || agent.active_server_announcement_id === null) {
    return;
  }

  engine.state.clearActiveServerAnnouncement(agentId);
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

export function handleServerAnnouncementInterruption(engine: WorldEngine, agentId: string): void {
  const agent = engine.state.getLoggedIn(agentId);
  if (!agent || agent.active_server_announcement_id === null) {
    return;
  }

  if (agent.pending_conversation_id) {
    cancelPendingConversationForServerAnnouncement(engine, agentId);
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
      cancelTransfer(engine, transferId, 'server_announcement');
    }
    clearActiveServerAnnouncement(engine, agentId);
    return;
  } else if (refreshedAgent.state === 'in_conversation') {
    const conversation = findConversationByAgent(engine, agentId, ['active', 'closing']);
    if (conversation) {
      if (detachPendingJoiner(engine, conversation.conversation_id, agentId, false)) {
        engine.emitEvent({
          type: 'conversation_pending_join_cancelled',
          conversation_id: conversation.conversation_id,
          agent_id: agentId,
          reason: 'server_announcement',
        });
        engine.state.setState(agentId, 'idle');
        clearActiveServerAnnouncement(engine, agentId);
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
        beginClosingConversation(engine, conversation.conversation_id, partnerId, 'server_announcement', agentId);
      }
    }
  }

  engine.state.setState(agentId, 'idle');
  clearActiveServerAnnouncement(engine, agentId);
}

export function cleanupServerAnnouncementsForAgent(engine: WorldEngine, agentId: string): void {
  clearActiveServerAnnouncement(engine, agentId);
  for (const serverAnnouncement of engine.state.serverAnnouncements.list()) {
    serverAnnouncement.pending_agent_ids = serverAnnouncement.pending_agent_ids.filter((id) => id !== agentId);
    serverAnnouncement.delivered_agent_ids = serverAnnouncement.delivered_agent_ids.filter((id) => id !== agentId);
    maybeCleanupServerAnnouncement(engine, serverAnnouncement.server_announcement_id);
  }
}
