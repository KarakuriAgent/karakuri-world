import { randomUUID } from 'node:crypto';

import type { WorldEngine } from '../engine/world-engine.js';
import type {
  ConversationAcceptRequest,
  ConversationEndRequest,
  ConversationJoinRequest,
  ConversationLeaveRequest,
  ConversationSpeakRequest,
  ConversationSpeakResponse,
  ConversationStartRequest,
  ConversationStartResponse,
  OkResponse,
} from '../types/api.js';
import { WorldError } from '../types/api.js';
import type { LoggedInAgent } from '../types/agent.js';
import type { ConversationClosureReason, ConversationData, ConversationStatus } from '../types/conversation.js';
import type {
  ConversationAcceptTimer,
  ConversationInactiveCheckTimer,
  ConversationIntervalTimer,
  ConversationTurnTimer,
} from '../types/timer.js';
import { cancelActiveAction } from './actions.js';
import { cancelIdleReminder, startIdleReminder } from './idle-reminder.js';
import { manhattanDistance } from './map-utils.js';
import { clearActiveServerEvent } from './server-events.js';
import { cancelActiveItemUse } from './use-item.js';
import { cancelActiveWait } from './wait.js';

function requireLoggedInAgent(engine: WorldEngine, agentId: string): LoggedInAgent {
  const agent = engine.state.getLoggedIn(agentId);
  if (!agent) {
    throw new WorldError(403, 'not_logged_in', `Agent is not logged in: ${agentId}`);
  }
  return agent;
}

function getConversationParticipants(conversation: ConversationData): string[] {
  return [...conversation.participant_agent_ids];
}

function getOtherParticipants(conversation: ConversationData, agentId: string): string[] {
  return conversation.participant_agent_ids.filter((participantId) => participantId !== agentId);
}

function cancelConversationTimers(engine: WorldEngine, conversationId: string): void {
  engine.timerManager
    .list()
    .filter(
      (timer) =>
        (timer.type === 'conversation_accept'
          || timer.type === 'conversation_turn'
          || timer.type === 'conversation_interval'
          || timer.type === 'conversation_inactive_check')
        && timer.conversation_id === conversationId,
    )
    .forEach((timer) => {
      engine.timerManager.cancel(timer.timer_id);
    });
}

function scheduleTurnTimer(engine: WorldEngine, conversation: ConversationData, speakerAgentId: string): void {
  conversation.current_speaker_agent_id = speakerAgentId;
  engine.timerManager.create({
    type: 'conversation_turn',
    agent_ids: getConversationParticipants(conversation),
    conversation_id: conversation.conversation_id,
    current_speaker_agent_id: speakerAgentId,
    fires_at: Date.now() + engine.config.conversation.turn_timeout_ms,
  });
}

function emitConversationTurnStarted(engine: WorldEngine, conversation: ConversationData, speakerAgentId: string): void {
  engine.emitEvent({
    type: 'conversation_turn_started',
    conversation_id: conversation.conversation_id,
    current_speaker_agent_id: speakerAgentId,
  });
}

function emitConversationClosing(
  engine: WorldEngine,
  conversation: ConversationData,
  reason: Extract<ConversationClosureReason, 'ended_by_agent' | 'max_turns' | 'server_event'>,
): void {
  engine.emitEvent({
    type: 'conversation_closing',
    conversation_id: conversation.conversation_id,
    initiator_agent_id: conversation.initiator_agent_id,
    participant_agent_ids: getConversationParticipants(conversation),
    current_speaker_agent_id: conversation.current_speaker_agent_id,
    reason,
  });
}

function emitConversationLeave(
  engine: WorldEngine,
  conversation: ConversationData,
  agentId: string,
  agentName: string,
  reason: 'voluntary' | 'inactive' | 'logged_out' | 'server_event',
  nextSpeakerAgentId?: string,
  message?: string,
): void {
  engine.emitEvent({
    type: 'conversation_leave',
    conversation_id: conversation.conversation_id,
    agent_id: agentId,
    agent_name: agentName,
    reason,
    participant_agent_ids: getConversationParticipants(conversation),
    ...(message ? { message } : {}),
    ...(nextSpeakerAgentId ? { next_speaker_agent_id: nextSpeakerAgentId } : {}),
  });
}

function toClosingEventReason(
  reason?: ConversationClosureReason,
): Extract<ConversationClosureReason, 'ended_by_agent' | 'max_turns' | 'server_event'> {
  if (reason === 'ended_by_agent' || reason === 'max_turns' || reason === 'server_event') {
    return reason;
  }
  return 'server_event';
}

function emitConversationIntervalInterrupted(
  engine: WorldEngine,
  conversation: ConversationData,
  timer: ConversationIntervalTimer,
  listenerAgentIds: string[],
  nextSpeakerAgentId: string,
): void {
  if (listenerAgentIds.length === 0) {
    return;
  }

  engine.emitEvent({
    type: 'conversation_interval_interrupted',
    conversation_id: conversation.conversation_id,
    speaker_agent_id: timer.speaker_agent_id,
    listener_agent_ids: listenerAgentIds,
    next_speaker_agent_id: nextSpeakerAgentId,
    participant_agent_ids: getConversationParticipants(conversation),
    message: timer.message,
    closing: conversation.status === 'closing' || conversation.closing_reason === 'ended_by_agent',
  });
}

function cleanupParticipant(engine: WorldEngine, conversation: ConversationData, participantId: string, startReminder = true): void {
  const agent = engine.state.getLoggedIn(participantId);
  if (!agent) {
    return;
  }

  const isCurrentConversation = agent.current_conversation_id === conversation.conversation_id;
  if (agent.pending_conversation_id === conversation.conversation_id) {
    engine.state.setPendingConversation(participantId, null);
  }
  if (isCurrentConversation) {
    engine.state.setCurrentConversation(participantId, null);
  }
  if (isCurrentConversation && agent.state === 'in_conversation') {
    engine.state.setState(participantId, 'idle');
    engine.state.setLastAction(participantId, null);
    if (startReminder) {
      startIdleReminder(engine, participantId);
    }
  }
}

function applyPendingJoiners(engine: WorldEngine, conversation: ConversationData): string[] {
  if (conversation.pending_participant_agent_ids.length === 0) {
    return [];
  }

  const pendingJoinerIds = [...conversation.pending_participant_agent_ids];
  conversation.pending_participant_agent_ids = [];
  const appliedJoinerIds: string[] = [];

  for (const joinerId of pendingJoinerIds) {
    const joiner = engine.state.getLoggedIn(joinerId);
    if (!joiner) {
      cleanupParticipant(engine, conversation, joinerId);
      engine.emitEvent({
        type: 'conversation_pending_join_cancelled',
        conversation_id: conversation.conversation_id,
        agent_id: joinerId,
        reason: 'participant_logged_out',
      });
      continue;
    }
    if (
      joiner.current_conversation_id !== conversation.conversation_id
      || joiner.state !== 'in_conversation'
      || conversation.participant_agent_ids.includes(joinerId)
    ) {
      console.error('[conversation] pending joiner state desynchronized, cancelling', {
        conversation_id: conversation.conversation_id,
        agent_id: joinerId,
        agent_state: joiner.state,
        current_conversation_id: joiner.current_conversation_id,
      });
      cleanupParticipant(engine, conversation, joinerId);
      engine.emitEvent({
        type: 'conversation_pending_join_cancelled',
        conversation_id: conversation.conversation_id,
        agent_id: joinerId,
        reason: 'agent_unavailable',
      });
      continue;
    }

    conversation.participant_agent_ids.push(joinerId);
    conversation.last_spoken_turns[joinerId] = conversation.current_turn;
    appliedJoinerIds.push(joinerId);
    engine.emitEvent({
      type: 'conversation_join',
      conversation_id: conversation.conversation_id,
      agent_id: joinerId,
      agent_name: joiner.agent_name,
      participant_agent_ids: getConversationParticipants(conversation),
    });
  }

  return appliedJoinerIds;
}

function discardPendingJoiners(
  engine: WorldEngine,
  conversation: ConversationData,
  reason: ConversationClosureReason,
): void {
  const pendingJoinerIds = [...conversation.pending_participant_agent_ids];
  conversation.pending_participant_agent_ids = [];

  for (const joinerId of pendingJoinerIds) {
    cleanupParticipant(engine, conversation, joinerId);
    engine.emitEvent({
      type: 'conversation_pending_join_cancelled',
      conversation_id: conversation.conversation_id,
      agent_id: joinerId,
      reason,
    });
  }
}

function removePendingJoiner(conversation: ConversationData, agentId: string): void {
  conversation.pending_participant_agent_ids = conversation.pending_participant_agent_ids.filter((pendingAgentId) => pendingAgentId !== agentId);
}

export function detachPendingJoiner(
  engine: WorldEngine,
  conversationId: string,
  agentId: string,
  startReminder = true,
): boolean {
  const conversation = engine.state.conversations.get(conversationId);
  if (
    !conversation
    || conversation.participant_agent_ids.includes(agentId)
    || !conversation.pending_participant_agent_ids.includes(agentId)
  ) {
    return false;
  }

  removePendingJoiner(conversation, agentId);
  cleanupParticipant(engine, conversation, agentId, startReminder);
  return true;
}

function endConversation(
  engine: WorldEngine,
  conversationId: string,
  reason: ConversationClosureReason,
  finalMessage?: string,
  finalSpeakerAgentId?: string,
): void {
  const conversation = engine.state.conversations.get(conversationId);
  if (!conversation) {
    return;
  }

  const participantAgentIds = getConversationParticipants(conversation);
  discardPendingJoiners(engine, conversation, reason);
  cancelConversationTimers(engine, conversationId);
  engine.state.conversations.delete(conversationId);

  for (const participantId of participantAgentIds) {
    cleanupParticipant(engine, conversation, participantId);
  }

  engine.emitEvent({
    type: 'conversation_ended',
    conversation_id: conversation.conversation_id,
    initiator_agent_id: conversation.initiator_agent_id,
    participant_agent_ids: participantAgentIds,
    reason,
    final_message: finalMessage,
    final_speaker_agent_id: finalSpeakerAgentId,
  });
}

function findTurnTimer(engine: WorldEngine, conversationId: string, speakerAgentId: string): ConversationTurnTimer | null {
  return (
    engine.timerManager.find(
      (timer): timer is ConversationTurnTimer =>
        timer.type === 'conversation_turn'
        && timer.conversation_id === conversationId
        && timer.current_speaker_agent_id === speakerAgentId,
    ) ?? null
  );
}

function findInactiveCheckTimer(engine: WorldEngine, conversationId: string): ConversationInactiveCheckTimer | null {
  return (
    engine.timerManager.find(
      (timer): timer is ConversationInactiveCheckTimer =>
        timer.type === 'conversation_inactive_check' && timer.conversation_id === conversationId,
    ) ?? null
  );
}

function findIntervalTimer(engine: WorldEngine, conversationId: string): ConversationIntervalTimer | null {
  return (
    engine.timerManager.find(
      (timer): timer is ConversationIntervalTimer =>
        timer.type === 'conversation_interval' && timer.conversation_id === conversationId,
    ) ?? null
  );
}

function updateLastSpokenTurns(conversation: ConversationData, speakerAgentId: string, nextSpeakerAgentId: string, turn: number): void {
  conversation.last_spoken_turns[speakerAgentId] = turn;
  conversation.last_spoken_turns[nextSpeakerAgentId] = turn;
}

function resolveNextSpeaker(
  conversation: ConversationData,
  currentSpeakerId: string,
  nextSpeakerId?: string,
): string {
  const others = getOtherParticipants(conversation, currentSpeakerId);
  if (!nextSpeakerId) {
    throw new WorldError(400, 'next_speaker_required', 'next_speaker_agent_id is required.');
  }
  if (nextSpeakerId === currentSpeakerId) {
    throw new WorldError(400, 'cannot_nominate_self', 'Cannot nominate yourself as the next speaker.');
  }
  if (!others.includes(nextSpeakerId)) {
    throw new WorldError(400, 'invalid_next_speaker', 'The nominated next speaker is not a participant in this conversation.');
  }
  return nextSpeakerId;
}

function resolveSequentialSpeaker(participants: string[], currentSpeakerId: string): string {
  const currentIndex = participants.indexOf(currentSpeakerId);
  if (currentIndex === -1) {
    return participants[0]!;
  }
  for (let offset = 1; offset <= participants.length; offset += 1) {
    const candidate = participants[(currentIndex + offset) % participants.length];
    if (candidate && candidate !== currentSpeakerId) {
      return candidate;
    }
  }
  return participants[0]!;
}

function resolveLeavingNextSpeaker(
  conversation: ConversationData,
  currentSpeakerId: string,
  remainingParticipantIds: string[],
  nextSpeakerId?: string,
): string {
  if (remainingParticipantIds.length === 0) {
    return currentSpeakerId;
  }
  if (remainingParticipantIds.length === 1) {
    return remainingParticipantIds[0]!;
  }
  if (!nextSpeakerId) {
    const currentIndex = conversation.participant_agent_ids.indexOf(currentSpeakerId);
    if (currentIndex === -1) {
      return remainingParticipantIds[0]!;
    }
    for (let offset = 1; offset <= conversation.participant_agent_ids.length; offset += 1) {
      const candidate = conversation.participant_agent_ids[(currentIndex + offset) % conversation.participant_agent_ids.length];
      if (candidate && remainingParticipantIds.includes(candidate)) {
        return candidate;
      }
    }
    return remainingParticipantIds[0]!;
  }
  if (nextSpeakerId === currentSpeakerId) {
    throw new WorldError(400, 'cannot_nominate_self', 'Cannot nominate yourself as the next speaker.');
  }
  if (!remainingParticipantIds.includes(nextSpeakerId)) {
    throw new WorldError(400, 'invalid_next_speaker', 'The nominated next speaker is not a participant in this conversation.');
  }
  return nextSpeakerId;
}

function resolveClosingNextSpeaker(
  conversation: ConversationData,
  currentSpeakerId: string,
  nextSpeakerId?: string,
): string {
  const remainingParticipantIds = getOtherParticipants(conversation, currentSpeakerId);
  if (remainingParticipantIds.length === 0) {
    return currentSpeakerId;
  }
  if (remainingParticipantIds.length === 1) {
    return remainingParticipantIds[0]!;
  }
  return resolveNextSpeaker(
    {
      ...conversation,
      participant_agent_ids: [currentSpeakerId, ...remainingParticipantIds],
    },
    currentSpeakerId,
    nextSpeakerId,
  );
}

function requireActiveConversation(engine: WorldEngine, agentId: string, statuses: ConversationStatus[]): ConversationData {
  const conversation = findConversationByAgent(engine, agentId, statuses);
  if (!conversation) {
    throw new WorldError(400, 'conversation_not_found', 'No active conversation found for this agent.');
  }
  return conversation;
}

function ensureTurn(engine: WorldEngine, conversation: ConversationData, agentId: string): ConversationTurnTimer {
  if (conversation.current_speaker_agent_id !== agentId) {
    throw new WorldError(409, 'not_your_turn', 'It is not your turn to speak.');
  }
  const turnTimer = findTurnTimer(engine, conversation.conversation_id, agentId);
  if (!turnTimer) {
    throw new WorldError(409, 'not_your_turn', 'It is not your turn to speak.');
  }
  return turnTimer;
}

function ensureMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    throw new WorldError(400, 'invalid_request', 'Conversation message must not be empty.');
  }
  return trimmed;
}

function maybeStartInactiveCheck(engine: WorldEngine, conversation: ConversationData, nextSpeakerAgentId: string): boolean {
  if (conversation.status === 'closing') {
    return false;
  }

  const targetAgentIds = conversation.participant_agent_ids.filter((participantId) => {
    const lastSpokenTurn = conversation.last_spoken_turns[participantId] ?? 0;
    return conversation.current_turn - lastSpokenTurn >= engine.config.conversation.inactive_check_turns;
  });

  if (targetAgentIds.length === 0) {
    return false;
  }

  conversation.inactive_check_pending_agent_ids = [...targetAgentIds];
  conversation.resume_speaker_agent_id = nextSpeakerAgentId;
  engine.emitEvent({
    type: 'conversation_inactive_check',
    conversation_id: conversation.conversation_id,
    target_agent_ids: [...targetAgentIds],
  });
  engine.timerManager.create({
    type: 'conversation_inactive_check',
    agent_ids: [...targetAgentIds],
    conversation_id: conversation.conversation_id,
    target_agent_ids: [...targetAgentIds],
    fires_at: Date.now() + engine.config.conversation.turn_timeout_ms,
  });
  return true;
}

function resolveResumeSpeaker(
  conversation: Pick<ConversationData, 'participant_agent_ids' | 'resume_speaker_agent_id'>,
): string | null {
  const preferred = conversation.resume_speaker_agent_id;
  if (preferred && conversation.participant_agent_ids.includes(preferred)) {
    return preferred;
  }
  if (conversation.participant_agent_ids.length === 0) {
    return null;
  }
  return conversation.participant_agent_ids[0] ?? null;
}

export function getConversationActionableSpeaker(
  conversation: Pick<
    ConversationData,
    'participant_agent_ids' | 'current_speaker_agent_id' | 'inactive_check_pending_agent_ids' | 'resume_speaker_agent_id'
  >,
): string | null {
  if (conversation.participant_agent_ids.length === 0) {
    return null;
  }
  if (conversation.inactive_check_pending_agent_ids.length > 0) {
    return resolveResumeSpeaker(conversation);
  }
  if (conversation.participant_agent_ids.includes(conversation.current_speaker_agent_id)) {
    return conversation.current_speaker_agent_id;
  }
  return resolveResumeSpeaker(conversation);
}

function clearInactiveCheckState(engine: WorldEngine, conversation: ConversationData): void {
  const timer = findInactiveCheckTimer(engine, conversation.conversation_id);
  if (timer) {
    engine.timerManager.cancel(timer.timer_id);
  }
  conversation.inactive_check_pending_agent_ids = [];
  conversation.resume_speaker_agent_id = null;
}

function resolveResumeSpeakerAfterRemoval(
  previousParticipantIds: string[],
  conversation: ConversationData,
  removedAgentId: string,
): string | null {
  if (conversation.participant_agent_ids.length === 0) {
    return null;
  }

  const removedIndex = previousParticipantIds.indexOf(removedAgentId);
  if (removedIndex !== -1) {
    for (let offset = 1; offset < previousParticipantIds.length; offset += 1) {
      const candidate = previousParticipantIds[(removedIndex + offset) % previousParticipantIds.length];
      if (!candidate || !conversation.participant_agent_ids.includes(candidate)) {
        continue;
      }
      if (candidate !== conversation.current_speaker_agent_id) {
        return candidate;
      }
    }
  }

  return resolveResumeSpeaker(conversation);
}

function resumeAfterInactiveCheck(engine: WorldEngine, conversation: ConversationData): void {
  if (conversation.inactive_check_pending_agent_ids.length > 0) {
    return;
  }
  const timer = findInactiveCheckTimer(engine, conversation.conversation_id);
  if (timer) {
    engine.timerManager.cancel(timer.timer_id);
  }
  applyPendingJoiners(engine, conversation);
  const nextSpeakerAgentId = resolveResumeSpeaker(conversation);
  conversation.resume_speaker_agent_id = null;
  if (!nextSpeakerAgentId) {
    endConversation(engine, conversation.conversation_id, conversation.closing_reason ?? 'ended_by_agent');
    return;
  }
  scheduleTurnTimer(engine, conversation, nextSpeakerAgentId);
  emitConversationTurnStarted(engine, conversation, nextSpeakerAgentId);
}

function removeParticipant(conversation: ConversationData, agentId: string): void {
  const previousParticipantIds = [...conversation.participant_agent_ids];
  conversation.participant_agent_ids = conversation.participant_agent_ids.filter((participantId) => participantId !== agentId);
  removePendingJoiner(conversation, agentId);
  delete conversation.last_spoken_turns[agentId];
  conversation.inactive_check_pending_agent_ids = conversation.inactive_check_pending_agent_ids.filter((id) => id !== agentId);
  if (conversation.resume_speaker_agent_id === agentId) {
    conversation.resume_speaker_agent_id = resolveResumeSpeakerAfterRemoval(previousParticipantIds, conversation, agentId);
  }
  if (conversation.current_speaker_agent_id === agentId) {
    conversation.current_speaker_agent_id = resolveResumeSpeaker(conversation) ?? agentId;
  }
}

function concludeOrContinueAfterLeave(
  engine: WorldEngine,
  conversation: ConversationData,
  reason: ConversationClosureReason,
  nextSpeakerAgentId?: string,
  finalMessage?: string,
  finalSpeakerAgentId?: string,
): void {
  applyPendingJoiners(engine, conversation);

  if (conversation.participant_agent_ids.length <= 1) {
    endConversation(engine, conversation.conversation_id, reason, finalMessage, finalSpeakerAgentId);
    return;
  }

  if (
    conversation.inactive_check_pending_agent_ids.length > 0
    || findInactiveCheckTimer(engine, conversation.conversation_id)
  ) {
    resumeAfterInactiveCheck(engine, conversation);
    return;
  }

  const resumedSpeakerAgentId = nextSpeakerAgentId ?? resolveResumeSpeaker(conversation) ?? conversation.participant_agent_ids[0]!;
  scheduleTurnTimer(engine, conversation, resumedSpeakerAgentId);
  emitConversationTurnStarted(engine, conversation, resumedSpeakerAgentId);
}

export function findConversationByAgent(
  engine: WorldEngine,
  agentId: string,
  statuses: ConversationStatus[] = ['pending', 'active', 'closing'],
): ConversationData | null {
  const agent = engine.state.getLoggedIn(agentId);
  if (agent?.current_conversation_id) {
    const currentConversation = engine.state.conversations.get(agent.current_conversation_id);
    if (
      currentConversation
      && statuses.includes(currentConversation.status)
      && (
        currentConversation.participant_agent_ids.includes(agentId)
        || currentConversation.pending_participant_agent_ids.includes(agentId)
      )
    ) {
      return currentConversation;
    }
  }

  return (
    engine.state.conversations
      .list()
      .find(
        (conversation) =>
          statuses.includes(conversation.status)
          && (
            conversation.participant_agent_ids.includes(agentId)
            || conversation.pending_participant_agent_ids.includes(agentId)
          ),
      ) ?? null
  );
}

export function validateConversationStart(engine: WorldEngine, agentId: string, request: ConversationStartRequest): {
  initiator: LoggedInAgent;
  target: LoggedInAgent;
} {
  const initiator = requireLoggedInAgent(engine, agentId);
  if (initiator.state !== 'idle' || initiator.pending_conversation_id) {
    throw new WorldError(409, 'state_conflict', 'Initiator cannot start a conversation right now.');
  }

  ensureMessage(request.message);

  const targetRegistration = engine.state.getById(request.target_agent_id);
  if (!targetRegistration) {
    throw new WorldError(400, 'target_not_found', `Unknown target agent: ${request.target_agent_id}`);
  }

  const target = engine.state.getLoggedIn(request.target_agent_id);
  if (!target || !['idle', 'in_action'].includes(target.state) || target.pending_conversation_id) {
    throw new WorldError(409, 'target_unavailable', 'Target agent cannot receive a conversation right now.');
  }

  if (manhattanDistance(initiator.node_id, target.node_id) > 1) {
    throw new WorldError(400, 'out_of_range', 'Target agent is out of range.');
  }

  return { initiator, target };
}

export function startConversation(
  engine: WorldEngine,
  agentId: string,
  request: ConversationStartRequest,
): ConversationStartResponse {
  const { initiator, target } = validateConversationStart(engine, agentId, request);
  const message = ensureMessage(request.message);
  const conversation: ConversationData = {
    conversation_id: `conversation-${randomUUID()}`,
    status: 'pending',
    initiator_agent_id: initiator.agent_id,
    participant_agent_ids: [initiator.agent_id, target.agent_id],
    pending_participant_agent_ids: [],
    current_turn: 1,
    current_speaker_agent_id: target.agent_id,
    initial_message: message,
    last_spoken_turns: {
      [initiator.agent_id]: 0,
      [target.agent_id]: 0,
    },
    inactive_check_pending_agent_ids: [],
    resume_speaker_agent_id: null,
  };

  engine.state.conversations.set(conversation);
  cancelIdleReminder(engine, initiator.agent_id);
  engine.state.setPendingConversation(initiator.agent_id, conversation.conversation_id);
  engine.state.setPendingConversation(target.agent_id, conversation.conversation_id);
  engine.timerManager.create({
    type: 'conversation_accept',
    agent_ids: [initiator.agent_id, target.agent_id],
    conversation_id: conversation.conversation_id,
    initiator_agent_id: initiator.agent_id,
    target_agent_id: target.agent_id,
    fires_at: Date.now() + engine.config.conversation.accept_timeout_ms,
  });

  engine.emitEvent({
    type: 'conversation_requested',
    conversation_id: conversation.conversation_id,
    initiator_agent_id: initiator.agent_id,
    target_agent_id: target.agent_id,
    message,
  });

  return { conversation_id: conversation.conversation_id };
}

export function acceptConversation(engine: WorldEngine, agentId: string, request: ConversationAcceptRequest): OkResponse {
  const conversation = findConversationByAgent(engine, agentId, ['pending']);
  if (!conversation) {
    throw new WorldError(400, 'conversation_not_found', 'No pending conversation found for this agent.');
  }

  const targetAgentId = conversation.participant_agent_ids.find((participantId) => participantId !== conversation.initiator_agent_id);
  if (targetAgentId !== agentId) {
    throw new WorldError(403, 'not_target', 'Only the target agent can accept this conversation.');
  }

  const replyMessage = ensureMessage(request.message);
  const initiator = engine.state.getLoggedIn(conversation.initiator_agent_id);
  const target = engine.state.getLoggedIn(agentId);
  if (!initiator || !target || !['idle', 'in_action'].includes(target.state)) {
    cancelConversationTimers(engine, conversation.conversation_id);
    engine.state.conversations.delete(conversation.conversation_id);
    if (initiator) {
      engine.state.setPendingConversation(initiator.agent_id, null);
    }
    if (target) {
      engine.state.setPendingConversation(target.agent_id, null);
    }
    throw new WorldError(409, 'target_unavailable', 'Conversation target is no longer available.');
  }

  cancelConversationTimers(engine, conversation.conversation_id);
  if (target.state === 'in_action') {
    cancelActiveAction(engine, target.agent_id);
    cancelActiveWait(engine, target.agent_id);
    cancelActiveItemUse(engine, target.agent_id);
  }

  cancelIdleReminder(engine, initiator.agent_id);
  cancelIdleReminder(engine, target.agent_id);
  engine.state.setPendingConversation(initiator.agent_id, null);
  engine.state.setPendingConversation(target.agent_id, null);
  engine.state.setCurrentConversation(initiator.agent_id, conversation.conversation_id);
  engine.state.setCurrentConversation(target.agent_id, conversation.conversation_id);
  engine.state.setState(initiator.agent_id, 'in_conversation');
  engine.state.setState(target.agent_id, 'in_conversation');
  conversation.status = 'active';

  engine.emitEvent({
    type: 'conversation_accepted',
    conversation_id: conversation.conversation_id,
    initiator_agent_id: initiator.agent_id,
    participant_agent_ids: getConversationParticipants(conversation),
  });

  engine.emitEvent({
    type: 'conversation_message',
    conversation_id: conversation.conversation_id,
    speaker_agent_id: initiator.agent_id,
    listener_agent_ids: [target.agent_id],
    turn: 1,
    message: conversation.initial_message,
  });
  updateLastSpokenTurns(conversation, initiator.agent_id, target.agent_id, 1);

  const turn = 2;
  conversation.current_turn = turn;
  engine.emitEvent({
    type: 'conversation_message',
    conversation_id: conversation.conversation_id,
    speaker_agent_id: target.agent_id,
    listener_agent_ids: [initiator.agent_id],
    turn,
    message: replyMessage,
  });
  updateLastSpokenTurns(conversation, target.agent_id, initiator.agent_id, turn);
  engine.timerManager.create({
    type: 'conversation_interval',
    agent_ids: getConversationParticipants(conversation),
    conversation_id: conversation.conversation_id,
    speaker_agent_id: target.agent_id,
    listener_agent_ids: [initiator.agent_id],
    next_speaker_agent_id: initiator.agent_id,
    turn,
    message: replyMessage,
    fires_at: Date.now() + engine.config.conversation.interval_ms,
  });

  return { status: 'ok' };
}

export function rejectConversation(engine: WorldEngine, agentId: string): OkResponse {
  const conversation = findConversationByAgent(engine, agentId, ['pending']);
  if (!conversation) {
    throw new WorldError(400, 'conversation_not_found', 'No pending conversation found for this agent.');
  }

  const targetAgentId = conversation.participant_agent_ids.find((participantId) => participantId !== conversation.initiator_agent_id);
  if (targetAgentId !== agentId) {
    throw new WorldError(403, 'not_target', 'Only the target agent can reject this conversation.');
  }

  cancelConversationTimers(engine, conversation.conversation_id);
  engine.state.conversations.delete(conversation.conversation_id);

  const initiator = engine.state.getLoggedIn(conversation.initiator_agent_id);
  const target = engine.state.getLoggedIn(agentId);
  if (initiator) {
    engine.state.setPendingConversation(initiator.agent_id, null);
    startIdleReminder(engine, initiator.agent_id);
  }
  if (target) {
    engine.state.setPendingConversation(target.agent_id, null);
  }

  engine.emitEvent({
    type: 'conversation_rejected',
    conversation_id: conversation.conversation_id,
    initiator_agent_id: conversation.initiator_agent_id,
    target_agent_id: agentId,
    reason: 'rejected',
  });

  return { status: 'ok' };
}

export function handleAcceptTimeout(engine: WorldEngine, timer: ConversationAcceptTimer): void {
  const conversation = engine.state.conversations.get(timer.conversation_id);
  if (!conversation || conversation.status !== 'pending') {
    return;
  }

  for (const agentId of timer.agent_ids) {
    clearActiveServerEvent(engine, agentId);
  }

  engine.state.conversations.delete(conversation.conversation_id);
  const initiator = engine.state.getLoggedIn(conversation.initiator_agent_id);
  const target = engine.state.getLoggedIn(timer.target_agent_id);
  if (initiator) {
    engine.state.setPendingConversation(initiator.agent_id, null);
    startIdleReminder(engine, initiator.agent_id);
  }
  if (target) {
    engine.state.setPendingConversation(target.agent_id, null);
  }

  engine.emitEvent({
    type: 'conversation_rejected',
    conversation_id: conversation.conversation_id,
    initiator_agent_id: conversation.initiator_agent_id,
    target_agent_id: timer.target_agent_id,
    reason: 'timeout',
  });
}

export function speak(engine: WorldEngine, agentId: string, request: ConversationSpeakRequest): ConversationSpeakResponse {
  const agent = requireLoggedInAgent(engine, agentId);
  if (agent.state !== 'in_conversation') {
    throw new WorldError(409, 'state_conflict', 'Agent is not in a conversation.');
  }

  const conversation = requireActiveConversation(engine, agentId, ['active', 'closing']);
  const turnTimer = ensureTurn(engine, conversation, agentId);
  const message = ensureMessage(request.message);
  engine.timerManager.cancel(turnTimer.timer_id);

  const nextSpeakerAgentId = conversation.status === 'closing'
    ? resolveClosingNextSpeaker(conversation, agentId, request.next_speaker_agent_id)
    : resolveNextSpeaker(conversation, agentId, request.next_speaker_agent_id);
  const listeners = getOtherParticipants(conversation, agentId);
  const turn = conversation.current_turn + 1;
  conversation.current_turn = turn;
  updateLastSpokenTurns(conversation, agentId, nextSpeakerAgentId, turn);
  engine.emitEvent({
    type: 'conversation_message',
    conversation_id: conversation.conversation_id,
    speaker_agent_id: agentId,
    listener_agent_ids: listeners,
    turn,
    message,
  });
  engine.timerManager.create({
    type: 'conversation_interval',
    agent_ids: getConversationParticipants(conversation),
    conversation_id: conversation.conversation_id,
    speaker_agent_id: agentId,
    listener_agent_ids: listeners,
    next_speaker_agent_id: nextSpeakerAgentId,
    turn,
    message,
    fires_at: Date.now() + engine.config.conversation.interval_ms,
  });

  return { turn };
}

export function endConversationByAgent(engine: WorldEngine, agentId: string, request: ConversationEndRequest): ConversationSpeakResponse {
  const agent = requireLoggedInAgent(engine, agentId);
  if (agent.state !== 'in_conversation') {
    throw new WorldError(409, 'state_conflict', 'Agent is not in a conversation.');
  }

  const conversation = requireActiveConversation(engine, agentId, ['active']);
  const turnTimer = ensureTurn(engine, conversation, agentId);
  const message = ensureMessage(request.message);
  engine.timerManager.cancel(turnTimer.timer_id);

  if (conversation.participant_agent_ids.length <= 2) {
    const otherAgentId = getOtherParticipants(conversation, agentId)[0]!;
    const turn = conversation.current_turn + 1;
    conversation.current_turn = turn;
    clearInactiveCheckState(engine, conversation);
    discardPendingJoiners(engine, conversation, 'ended_by_agent');
    conversation.status = 'closing';
    conversation.closing_reason = 'ended_by_agent';
    conversation.current_speaker_agent_id = otherAgentId;
    updateLastSpokenTurns(conversation, agentId, otherAgentId, turn);
    engine.emitEvent({
      type: 'conversation_message',
      conversation_id: conversation.conversation_id,
      speaker_agent_id: agentId,
      listener_agent_ids: [otherAgentId],
      turn,
      message,
    });
    emitConversationClosing(engine, conversation, 'ended_by_agent');
    engine.timerManager.create({
      type: 'conversation_interval',
      agent_ids: getConversationParticipants(conversation),
      conversation_id: conversation.conversation_id,
      speaker_agent_id: agentId,
      listener_agent_ids: [otherAgentId],
      next_speaker_agent_id: otherAgentId,
      turn,
      message,
      fires_at: Date.now() + engine.config.conversation.interval_ms,
    });
    return { turn };
  }

  const remainingParticipantIds = getOtherParticipants(conversation, agentId);
  const nextSpeakerAgentId = resolveLeavingNextSpeaker(
    conversation,
    agentId,
    remainingParticipantIds,
    request.next_speaker_agent_id,
  );
  const turn = conversation.current_turn + 1;
  conversation.current_turn = turn;

  removeParticipant(conversation, agentId);
  cleanupParticipant(engine, conversation, agentId);
  const listeners = getConversationParticipants(conversation);
  engine.emitEvent({
    type: 'conversation_message',
    conversation_id: conversation.conversation_id,
    speaker_agent_id: agentId,
    listener_agent_ids: listeners,
    turn,
    message,
  });

  engine.emitEvent({
    type: 'conversation_leave',
    conversation_id: conversation.conversation_id,
    agent_id: agentId,
    agent_name: agent.agent_name,
    reason: 'voluntary',
    participant_agent_ids: getConversationParticipants(conversation),
    message,
    next_speaker_agent_id: nextSpeakerAgentId,
  });

  if (conversation.participant_agent_ids.length <= 1 && conversation.pending_participant_agent_ids.length === 0) {
    endConversation(engine, conversation.conversation_id, 'ended_by_agent', message, agentId);
    return { turn };
  }

  conversation.last_spoken_turns[nextSpeakerAgentId] = turn;
  engine.timerManager.create({
    type: 'conversation_interval',
    agent_ids: getConversationParticipants(conversation),
    conversation_id: conversation.conversation_id,
    speaker_agent_id: agentId,
    listener_agent_ids: listeners,
    next_speaker_agent_id: nextSpeakerAgentId,
    turn,
    message,
    fires_at: Date.now() + engine.config.conversation.interval_ms,
  });

  return { turn };
}

export function joinConversation(engine: WorldEngine, agentId: string, request: ConversationJoinRequest): OkResponse {
  const agent = requireLoggedInAgent(engine, agentId);
  const conversation = engine.state.conversations.get(request.conversation_id);
  if (!conversation || conversation.status !== 'active') {
    throw new WorldError(400, 'conversation_not_found', 'No active conversation found.');
  }
  if (conversation.participant_agent_ids.includes(agentId) || conversation.pending_participant_agent_ids.includes(agentId)) {
    throw new WorldError(409, 'state_conflict', 'Agent is already participating in this conversation.');
  }
  if (conversation.participant_agent_ids.length + conversation.pending_participant_agent_ids.length >= engine.config.conversation.max_participants) {
    throw new WorldError(409, 'conversation_full', 'The conversation has reached the maximum participant count.');
  }
  if (!['idle', 'in_action'].includes(agent.state) || agent.pending_conversation_id) {
    throw new WorldError(409, 'state_conflict', 'Agent cannot join a conversation right now.');
  }

  const withinRange = conversation.participant_agent_ids.some((participantId) => {
    const participant = engine.state.getLoggedIn(participantId);
    return participant && manhattanDistance(agent.node_id, participant.node_id) <= 1;
  });
  if (!withinRange) {
    throw new WorldError(400, 'out_of_range', 'Conversation is out of range.');
  }

  if (agent.state === 'in_action') {
    cancelActiveAction(engine, agentId);
    cancelActiveWait(engine, agentId);
    cancelActiveItemUse(engine, agentId);
  }

  cancelIdleReminder(engine, agentId);
  conversation.pending_participant_agent_ids.push(agentId);
  engine.state.setCurrentConversation(agentId, conversation.conversation_id);
  engine.state.setState(agentId, 'in_conversation');
  return { status: 'ok' };
}

export function stayInConversation(engine: WorldEngine, agentId: string): OkResponse {
  const conversation = requireActiveConversation(engine, agentId, ['active']);
  if (!conversation.inactive_check_pending_agent_ids.includes(agentId)) {
    throw new WorldError(409, 'state_conflict', 'Agent is not awaiting an inactive-check response.');
  }
  conversation.inactive_check_pending_agent_ids = conversation.inactive_check_pending_agent_ids.filter((id) => id !== agentId);
  conversation.last_spoken_turns[agentId] = conversation.current_turn;
  resumeAfterInactiveCheck(engine, conversation);
  return { status: 'ok' };
}

export function leaveConversation(engine: WorldEngine, agentId: string, request: ConversationLeaveRequest = {}): OkResponse {
  const conversation = requireActiveConversation(engine, agentId, ['active']);
  if (!conversation.inactive_check_pending_agent_ids.includes(agentId)) {
    throw new WorldError(409, 'state_conflict', 'Agent is not awaiting an inactive-check response.');
  }
  const agent = requireLoggedInAgent(engine, agentId);
  const message = request.message?.trim() || undefined;
  removeParticipant(conversation, agentId);
  cleanupParticipant(engine, conversation, agentId);
  engine.emitEvent({
    type: 'conversation_leave',
    conversation_id: conversation.conversation_id,
    agent_id: agentId,
    agent_name: agent.agent_name,
    reason: 'inactive',
    participant_agent_ids: getConversationParticipants(conversation),
    ...(message ? { message } : {}),
  });
  concludeOrContinueAfterLeave(engine, conversation, conversation.closing_reason ?? 'ended_by_agent');
  return { status: 'ok' };
}

export function handleInactiveCheckTimeout(engine: WorldEngine, timer: ConversationInactiveCheckTimer): void {
  const conversation = engine.state.conversations.get(timer.conversation_id);
  if (!conversation || conversation.status !== 'active') {
    return;
  }

  const pendingAgentIds = [...conversation.inactive_check_pending_agent_ids];
  for (const agentId of pendingAgentIds) {
    const agent = engine.state.getLoggedIn(agentId);
    if (!agent) {
      removeParticipant(conversation, agentId);
      continue;
    }
    removeParticipant(conversation, agentId);
    cleanupParticipant(engine, conversation, agentId);
    engine.emitEvent({
      type: 'conversation_leave',
      conversation_id: conversation.conversation_id,
      agent_id: agentId,
      agent_name: agent.agent_name,
      reason: 'inactive',
      participant_agent_ids: getConversationParticipants(conversation),
    });
  }
  conversation.inactive_check_pending_agent_ids = [];
  concludeOrContinueAfterLeave(engine, conversation, conversation.closing_reason ?? 'ended_by_agent');
}

export function handleConversationInterval(engine: WorldEngine, timer: ConversationIntervalTimer): void {
  const conversation = engine.state.conversations.get(timer.conversation_id);
  if (!conversation) {
    return;
  }

  if (conversation.status === 'active') {
    applyPendingJoiners(engine, conversation);
  }

  let nextSpeakerAgentId: string | null | undefined = conversation.participant_agent_ids.includes(timer.next_speaker_agent_id)
    ? timer.next_speaker_agent_id
    : resolveResumeSpeaker(conversation);
  if (!nextSpeakerAgentId) {
    endConversation(engine, conversation.conversation_id, 'participant_logged_out');
    return;
  }

  if (conversation.status === 'closing') {
    if (conversation.participant_agent_ids.length <= 2) {
      if (
        conversation.closing_reason === 'ended_by_agent'
        && conversation.participant_agent_ids.includes(nextSpeakerAgentId)
        && conversation.current_speaker_agent_id === nextSpeakerAgentId
      ) {
        scheduleTurnTimer(engine, conversation, nextSpeakerAgentId);
        emitConversationTurnStarted(engine, conversation, nextSpeakerAgentId);
      } else {
        endConversation(
          engine,
          conversation.conversation_id,
          conversation.closing_reason ?? 'max_turns',
          timer.message,
          timer.speaker_agent_id,
        );
      }
      return;
    }

    const departingSpeakerId = timer.speaker_agent_id;
    const speaker = engine.state.getLoggedIn(departingSpeakerId);
    if (conversation.participant_agent_ids.includes(departingSpeakerId)) {
      removeParticipant(conversation, departingSpeakerId);
      cleanupParticipant(engine, conversation, departingSpeakerId);
      if (conversation.participant_agent_ids.length <= 1) {
        nextSpeakerAgentId = undefined;
      } else if (!conversation.participant_agent_ids.includes(nextSpeakerAgentId)) {
        nextSpeakerAgentId = resolveResumeSpeaker(conversation);
      }
      emitConversationLeave(
        engine,
        conversation,
        departingSpeakerId,
        speaker?.agent_name ?? departingSpeakerId,
        'voluntary',
        nextSpeakerAgentId ?? undefined,
        timer.message,
      );
    }
    if (conversation.participant_agent_ids.length <= 1) {
      endConversation(
        engine,
        conversation.conversation_id,
        conversation.closing_reason ?? 'max_turns',
        timer.message,
        timer.speaker_agent_id,
      );
      return;
    }
    if (!nextSpeakerAgentId) {
      endConversation(
        engine,
        conversation.conversation_id,
        conversation.closing_reason ?? 'max_turns',
        timer.message,
        timer.speaker_agent_id,
      );
      return;
    }
    scheduleTurnTimer(engine, conversation, nextSpeakerAgentId);
    emitConversationClosing(
      engine,
      conversation,
      conversation.closing_reason === 'server_event' ? 'server_event' : 'max_turns',
    );
    return;
  }

  if (timer.turn >= engine.config.conversation.max_turns || conversation.closing_reason === 'ended_by_agent') {
    clearInactiveCheckState(engine, conversation);
    conversation.status = 'closing';
    conversation.closing_reason ??= 'max_turns';
    scheduleTurnTimer(engine, conversation, nextSpeakerAgentId);
    emitConversationClosing(
      engine,
      conversation,
      conversation.closing_reason === 'ended_by_agent' ? 'ended_by_agent' : 'max_turns',
    );
    return;
  }

  if (maybeStartInactiveCheck(engine, conversation, nextSpeakerAgentId)) {
    return;
  }

  scheduleTurnTimer(engine, conversation, nextSpeakerAgentId);
}

export function handleTurnTimeout(engine: WorldEngine, timer: ConversationTurnTimer): void {
  const conversation = engine.state.conversations.get(timer.conversation_id);
  if (!conversation) {
    return;
  }

  if (conversation.status === 'closing') {
    endConversation(engine, conversation.conversation_id, conversation.closing_reason ?? 'max_turns');
    return;
  }

  if (conversation.closing_reason === 'ended_by_agent') {
    endConversation(engine, conversation.conversation_id, 'ended_by_agent');
    return;
  }

  endConversation(engine, conversation.conversation_id, 'turn_timeout');
}

export function beginClosingConversation(
  engine: WorldEngine,
  conversationId: string,
  speakerAgentId: string,
  reason: Extract<ConversationClosureReason, 'server_event' | 'max_turns'>,
  departingAgentId?: string,
): void {
  const conversation = engine.state.conversations.get(conversationId);
  if (!conversation) {
    return;
  }

  cancelConversationTimers(engine, conversationId);
  clearInactiveCheckState(engine, conversation);
  discardPendingJoiners(engine, conversation, reason);
  conversation.status = 'closing';
  conversation.closing_reason = reason;
  const originalParticipantCount = conversation.participant_agent_ids.length;
  let departingAgentName: string | null = null;
  if (departingAgentId && conversation.participant_agent_ids.includes(departingAgentId)) {
    const departingAgent = engine.state.getLoggedIn(departingAgentId);
    departingAgentName = departingAgent?.agent_name ?? departingAgentId;
    removeParticipant(conversation, departingAgentId);
    cleanupParticipant(engine, conversation, departingAgentId, false);
  }
  const nextSpeakerAgentId = conversation.participant_agent_ids.includes(speakerAgentId)
    ? speakerAgentId
    : conversation.participant_agent_ids.find((participantId) => participantId !== speakerAgentId) ?? conversation.participant_agent_ids[0];
  if (departingAgentId && departingAgentName && originalParticipantCount > 2) {
    emitConversationLeave(
      engine,
      conversation,
      departingAgentId,
      departingAgentName,
      'server_event',
      nextSpeakerAgentId,
    );
  }
  if (!nextSpeakerAgentId) {
    endConversation(engine, conversationId, reason);
    return;
  }
  scheduleTurnTimer(engine, conversation, nextSpeakerAgentId);
  emitConversationClosing(engine, conversation, reason);
}

export function detachParticipantFromClosingConversation(
  engine: WorldEngine,
  conversationId: string,
  agentId: string,
): void {
  const conversation = engine.state.conversations.get(conversationId);
  if (!conversation || conversation.status !== 'closing' || !conversation.participant_agent_ids.includes(agentId)) {
    return;
  }

  const originalParticipantCount = conversation.participant_agent_ids.length;
  const wasCurrentSpeaker = conversation.current_speaker_agent_id === agentId;
  const agent = engine.state.getLoggedIn(agentId);
  removeParticipant(conversation, agentId);
  cleanupParticipant(engine, conversation, agentId, false);

  const nextSpeakerAgentId = wasCurrentSpeaker
    ? resolveResumeSpeaker(conversation) ?? conversation.participant_agent_ids[0]
    : undefined;

  if (originalParticipantCount > 2) {
    emitConversationLeave(
      engine,
      conversation,
      agentId,
      agent?.agent_name ?? agentId,
      'server_event',
      nextSpeakerAgentId,
    );
  }

  if (conversation.participant_agent_ids.length <= 1) {
    endConversation(engine, conversationId, conversation.closing_reason ?? 'server_event');
    return;
  }

  if (!wasCurrentSpeaker) {
    return;
  }

  cancelConversationTimers(engine, conversationId);
  if (!nextSpeakerAgentId) {
    endConversation(engine, conversationId, conversation.closing_reason ?? 'server_event');
    return;
  }

  scheduleTurnTimer(engine, conversation, nextSpeakerAgentId);
  if (conversation.closing_reason === 'server_event') {
    emitConversationClosing(engine, conversation, 'server_event');
    return;
  }

  emitConversationTurnStarted(engine, conversation, nextSpeakerAgentId);
}

export function cancelPendingConversation(engine: WorldEngine, agentId: string): void {
  const conversation = findConversationByAgent(engine, agentId, ['pending']);
  if (!conversation) {
    return;
  }

  cancelConversationTimers(engine, conversation.conversation_id);
  engine.state.conversations.delete(conversation.conversation_id);
  const targetAgentId = conversation.participant_agent_ids.find((participantId) => participantId !== conversation.initiator_agent_id);
  if (!targetAgentId) {
    return;
  }
  const initiator = engine.state.getLoggedIn(conversation.initiator_agent_id);
  const target = engine.state.getLoggedIn(targetAgentId);
  if (initiator) {
    engine.state.setPendingConversation(initiator.agent_id, null);
  }
  if (target) {
    engine.state.setPendingConversation(target.agent_id, null);
  }

  if (targetAgentId === agentId) {
    if (initiator) {
      startIdleReminder(engine, initiator.agent_id);
    }
    engine.emitEvent({
      type: 'conversation_rejected',
      conversation_id: conversation.conversation_id,
      initiator_agent_id: conversation.initiator_agent_id,
      target_agent_id: targetAgentId,
      reason: 'target_logged_out',
    });
  }
}

export function cancelPendingConversationForServerEvent(engine: WorldEngine, agentId: string): void {
  const conversation = findConversationByAgent(engine, agentId, ['pending']);
  if (!conversation) {
    return;
  }

  cancelConversationTimers(engine, conversation.conversation_id);
  engine.state.conversations.delete(conversation.conversation_id);
  const targetAgentId = conversation.participant_agent_ids.find((participantId) => participantId !== conversation.initiator_agent_id);
  if (!targetAgentId) {
    return;
  }
  const initiator = engine.state.getLoggedIn(conversation.initiator_agent_id);
  const target = engine.state.getLoggedIn(targetAgentId);
  if (initiator) {
    engine.state.setPendingConversation(initiator.agent_id, null);
    if (initiator.state === 'idle') {
      startIdleReminder(engine, initiator.agent_id);
    }
  }
  if (target) {
    engine.state.setPendingConversation(target.agent_id, null);
    if (target.state === 'idle') {
      startIdleReminder(engine, target.agent_id);
    }
  }

  engine.emitEvent({
    type: 'conversation_rejected',
    conversation_id: conversation.conversation_id,
    initiator_agent_id: conversation.initiator_agent_id,
    target_agent_id: targetAgentId,
    reason: 'server_event',
  });
}

export function forceEndConversation(engine: WorldEngine, agentId: string): void {
  const conversation = findConversationByAgent(engine, agentId, ['active', 'closing']);
  if (!conversation) {
    return;
  }

  if (detachPendingJoiner(engine, conversation.conversation_id, agentId)) {
    return;
  }

  const intervalTimer = findIntervalTimer(engine, conversation.conversation_id);
  cancelConversationTimers(engine, conversation.conversation_id);
  const agent = engine.getAgentById(agentId);
  const originalParticipantAgentIds = getConversationParticipants(conversation);
  const currentSpeakerAgentId = conversation.current_speaker_agent_id;
  removeParticipant(conversation, agentId);

  if (originalParticipantAgentIds.length > 2) {
    emitConversationLeave(
      engine,
      conversation,
      agentId,
      agent?.agent_name ?? agentId,
      'logged_out',
    );
  }

  if (conversation.participant_agent_ids.length <= 1) {
    const remainingParticipantIds = getConversationParticipants(conversation);
    discardPendingJoiners(engine, conversation, 'participant_logged_out');
    engine.state.conversations.delete(conversation.conversation_id);
    for (const participantId of remainingParticipantIds) {
      cleanupParticipant(engine, conversation, participantId);
    }
    engine.emitEvent({
      type: 'conversation_ended',
      conversation_id: conversation.conversation_id,
      initiator_agent_id: conversation.initiator_agent_id,
      participant_agent_ids: originalParticipantAgentIds,
      reason: 'participant_logged_out',
      final_message: intervalTimer?.message,
      final_speaker_agent_id: intervalTimer?.speaker_agent_id,
    });
    return;
  }

  if (conversation.status === 'active' && conversation.inactive_check_pending_agent_ids.length > 0) {
    engine.timerManager.create({
      type: 'conversation_inactive_check',
      agent_ids: [...conversation.inactive_check_pending_agent_ids],
      conversation_id: conversation.conversation_id,
      target_agent_ids: [...conversation.inactive_check_pending_agent_ids],
      fires_at: Date.now() + engine.config.conversation.turn_timeout_ms,
    });
    return;
  }

  const nextSpeakerAgentId = intervalTimer && intervalTimer.next_speaker_agent_id !== agentId && conversation.participant_agent_ids.includes(intervalTimer.next_speaker_agent_id)
    ? intervalTimer.next_speaker_agent_id
    : currentSpeakerAgentId !== agentId && conversation.participant_agent_ids.includes(currentSpeakerAgentId)
      ? currentSpeakerAgentId
      : resolveSequentialSpeaker(originalParticipantAgentIds, agentId);
  if (!nextSpeakerAgentId) {
    endConversation(engine, conversation.conversation_id, 'participant_logged_out');
    return;
  }
  if (intervalTimer) {
    emitConversationIntervalInterrupted(
      engine,
      conversation,
      intervalTimer,
      intervalTimer.listener_agent_ids.filter((listenerAgentId) =>
        listenerAgentId !== agentId && conversation.participant_agent_ids.includes(listenerAgentId)),
      nextSpeakerAgentId,
    );
  }
  scheduleTurnTimer(engine, conversation, nextSpeakerAgentId);
  if (conversation.closing_reason === 'server_event') {
    emitConversationClosing(engine, conversation, 'server_event');
    return;
  }
  emitConversationTurnStarted(engine, conversation, nextSpeakerAgentId);
}
