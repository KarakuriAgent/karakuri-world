import { randomUUID } from 'node:crypto';

import type { WorldEngine } from '../engine/world-engine.js';
import type {
  ConversationAcceptRequest,
  ConversationRejectRequest,
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
  ConversationIntervalTimer,
  ConversationTurnTimer,
} from '../types/timer.js';
import { cancelActiveAction } from './actions.js';
import { cancelIdleReminder, startIdleReminder } from './idle-reminder.js';
import { manhattanDistance } from './map-utils.js';
import { cancelActiveWait } from './wait.js';

function requireLoggedInAgent(engine: WorldEngine, agentId: string): LoggedInAgent {
  const agent = engine.state.getLoggedIn(agentId);
  if (!agent) {
    throw new WorldError(403, 'not_logged_in', `Agent is not logged in: ${agentId}`);
  }
  return agent;
}

function getConversationParticipants(conversation: ConversationData): string[] {
  return [conversation.initiator_agent_id, conversation.target_agent_id];
}

function getOtherAgentId(conversation: ConversationData, agentId: string): string {
  return conversation.initiator_agent_id === agentId ? conversation.target_agent_id : conversation.initiator_agent_id;
}

function cancelConversationTimers(engine: WorldEngine, conversationId: string): void {
  engine.timerManager
    .list()
    .filter(
      (timer) =>
        (timer.type === 'conversation_accept' || timer.type === 'conversation_turn' || timer.type === 'conversation_interval') &&
        timer.conversation_id === conversationId,
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

  cancelConversationTimers(engine, conversationId);
  engine.state.conversations.delete(conversationId);

  for (const participantId of getConversationParticipants(conversation)) {
    const agent = engine.state.getLoggedIn(participantId);
    if (!agent) {
      continue;
    }

    engine.state.setState(participantId, 'idle');
    engine.state.setPendingConversation(participantId, null);
    engine.state.setLastAction(participantId, null);
    startIdleReminder(engine, participantId);
  }

  engine.emitEvent({
    type: 'conversation_ended',
    conversation_id: conversation.conversation_id,
    initiator_agent_id: conversation.initiator_agent_id,
    target_agent_id: conversation.target_agent_id,
    reason,
    final_message: finalMessage,
    final_speaker_agent_id: finalSpeakerAgentId,
  });
}

function findTurnTimer(engine: WorldEngine, conversationId: string, speakerAgentId: string): ConversationTurnTimer | null {
  return (
    engine.timerManager.find(
      (timer): timer is ConversationTurnTimer =>
        timer.type === 'conversation_turn' &&
        timer.conversation_id === conversationId &&
        timer.current_speaker_agent_id === speakerAgentId,
    ) ?? null
  );
}

export function findConversationByAgent(
  engine: WorldEngine,
  agentId: string,
  statuses: ConversationStatus[] = ['pending', 'active', 'closing'],
): ConversationData | null {
  return (
    engine.state.conversations
      .list()
      .find(
        (conversation) =>
          statuses.includes(conversation.status) &&
          (conversation.initiator_agent_id === agentId || conversation.target_agent_id === agentId),
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

  if (!request.message.trim()) {
    throw new WorldError(400, 'invalid_request', 'Conversation message must not be empty.');
  }

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
  const conversation: ConversationData = {
    conversation_id: `conversation-${randomUUID()}`,
    status: 'pending',
    initiator_agent_id: initiator.agent_id,
    target_agent_id: target.agent_id,
    current_turn: 1,
    current_speaker_agent_id: target.agent_id,
    initial_message: request.message.trim(),
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
    message: conversation.initial_message,
  });

  return { conversation_id: conversation.conversation_id };
}

export function acceptConversation(engine: WorldEngine, agentId: string, request: ConversationAcceptRequest): OkResponse {
  const conversation = engine.state.conversations.get(request.conversation_id);
  if (!conversation || conversation.status !== 'pending') {
    throw new WorldError(400, 'conversation_not_found', `Conversation not found: ${request.conversation_id}`);
  }

  if (conversation.target_agent_id !== agentId) {
    throw new WorldError(403, 'not_target', 'Only the target agent can accept this conversation.');
  }

  const initiator = engine.state.getLoggedIn(conversation.initiator_agent_id);
  const target = engine.state.getLoggedIn(conversation.target_agent_id);
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
  }

  cancelIdleReminder(engine, initiator.agent_id);
  cancelIdleReminder(engine, target.agent_id);
  engine.state.setPendingConversation(initiator.agent_id, null);
  engine.state.setPendingConversation(target.agent_id, null);
  engine.state.setState(initiator.agent_id, 'in_conversation');
  engine.state.setState(target.agent_id, 'in_conversation');
  conversation.status = 'active';
  scheduleTurnTimer(engine, conversation, target.agent_id);

  engine.emitEvent({
    type: 'conversation_accepted',
    conversation_id: conversation.conversation_id,
    initiator_agent_id: initiator.agent_id,
    target_agent_id: target.agent_id,
  });

  return { status: 'ok' };
}

export function rejectConversation(engine: WorldEngine, agentId: string, request: ConversationRejectRequest): OkResponse {
  const conversation = engine.state.conversations.get(request.conversation_id);
  if (!conversation || conversation.status !== 'pending') {
    throw new WorldError(400, 'conversation_not_found', `Conversation not found: ${request.conversation_id}`);
  }

  if (conversation.target_agent_id !== agentId) {
    throw new WorldError(403, 'not_target', 'Only the target agent can reject this conversation.');
  }

  cancelConversationTimers(engine, conversation.conversation_id);
  engine.state.conversations.delete(conversation.conversation_id);

  const initiator = engine.state.getLoggedIn(conversation.initiator_agent_id);
  const target = engine.state.getLoggedIn(conversation.target_agent_id);
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
    target_agent_id: conversation.target_agent_id,
    reason: 'rejected',
  });

  return { status: 'ok' };
}

export function handleAcceptTimeout(engine: WorldEngine, timer: ConversationAcceptTimer): void {
  const conversation = engine.state.conversations.get(timer.conversation_id);
  if (!conversation || conversation.status !== 'pending') {
    return;
  }

  engine.state.conversations.delete(conversation.conversation_id);
  const initiator = engine.state.getLoggedIn(conversation.initiator_agent_id);
  const target = engine.state.getLoggedIn(conversation.target_agent_id);
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
    target_agent_id: conversation.target_agent_id,
    reason: 'timeout',
  });
}

export function speak(engine: WorldEngine, agentId: string, request: ConversationSpeakRequest): ConversationSpeakResponse {
  const agent = requireLoggedInAgent(engine, agentId);
  if (agent.state !== 'in_conversation') {
    throw new WorldError(409, 'state_conflict', 'Agent is not in a conversation.');
  }

  if (!request.message.trim()) {
    throw new WorldError(400, 'invalid_request', 'Conversation message must not be empty.');
  }

  const conversation = engine.state.conversations.get(request.conversation_id);
  if (!conversation || !['active', 'closing'].includes(conversation.status)) {
    throw new WorldError(400, 'conversation_not_found', `Conversation not found: ${request.conversation_id}`);
  }

  if (!getConversationParticipants(conversation).includes(agentId)) {
    throw new WorldError(400, 'conversation_not_found', `Conversation not found: ${request.conversation_id}`);
  }

  if (conversation.current_speaker_agent_id !== agentId) {
    throw new WorldError(409, 'not_your_turn', 'It is not your turn to speak.');
  }

  const turnTimer = findTurnTimer(engine, conversation.conversation_id, agentId);
  if (!turnTimer) {
    throw new WorldError(409, 'not_your_turn', 'It is not your turn to speak.');
  }

  engine.timerManager.cancel(turnTimer.timer_id);
  const otherAgentId = getOtherAgentId(conversation, agentId);
  const turn = conversation.current_turn + 1;
  const message = request.message.trim();
  conversation.current_turn = turn;
  engine.emitEvent({
    type: 'conversation_message',
    conversation_id: conversation.conversation_id,
    speaker_agent_id: agentId,
    listener_agent_id: otherAgentId,
    turn,
    message,
  });
  engine.timerManager.create({
    type: 'conversation_interval',
    agent_ids: getConversationParticipants(conversation),
    conversation_id: conversation.conversation_id,
    speaker_agent_id: agentId,
    listener_agent_id: otherAgentId,
    turn,
    message,
    fires_at: Date.now() + engine.config.conversation.interval_ms,
  });

  return { turn };
}

export function handleConversationInterval(engine: WorldEngine, timer: ConversationIntervalTimer): void {
  const conversation = engine.state.conversations.get(timer.conversation_id);
  if (!conversation) {
    return;
  }

  const speaker = engine.state.getLoggedIn(timer.speaker_agent_id);
  const listener = engine.state.getLoggedIn(timer.listener_agent_id);
  if (!speaker || !listener) {
    endConversation(engine, conversation.conversation_id, 'partner_logged_out');
    return;
  }

  if (conversation.status === 'closing') {
    endConversation(
      engine,
      conversation.conversation_id,
      conversation.closing_reason ?? 'max_turns',
      timer.message,
      timer.speaker_agent_id,
    );
    return;
  }

  if (timer.turn >= engine.config.conversation.max_turns) {
    conversation.status = 'closing';
    conversation.closing_reason = 'max_turns';
    scheduleTurnTimer(engine, conversation, timer.listener_agent_id);
    return;
  }

  scheduleTurnTimer(engine, conversation, timer.listener_agent_id);
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

  endConversation(engine, conversation.conversation_id, 'turn_timeout');
}

export function beginClosingConversation(
  engine: WorldEngine,
  conversationId: string,
  speakerAgentId: string,
  reason: Extract<ConversationClosureReason, 'server_event' | 'max_turns'>,
): void {
  const conversation = engine.state.conversations.get(conversationId);
  if (!conversation) {
    return;
  }

  cancelConversationTimers(engine, conversationId);
  conversation.status = 'closing';
  conversation.closing_reason = reason;
  scheduleTurnTimer(engine, conversation, speakerAgentId);
}

export function cancelPendingConversation(engine: WorldEngine, agentId: string): void {
  const conversation = findConversationByAgent(engine, agentId, ['pending']);
  if (!conversation) {
    return;
  }

  cancelConversationTimers(engine, conversation.conversation_id);
  engine.state.conversations.delete(conversation.conversation_id);
  const initiator = engine.state.getLoggedIn(conversation.initiator_agent_id);
  const target = engine.state.getLoggedIn(conversation.target_agent_id);
  if (initiator) {
    engine.state.setPendingConversation(initiator.agent_id, null);
  }
  if (target) {
    engine.state.setPendingConversation(target.agent_id, null);
  }

  if (conversation.target_agent_id === agentId) {
    if (initiator) {
      startIdleReminder(engine, initiator.agent_id);
    }
    engine.emitEvent({
      type: 'conversation_rejected',
      conversation_id: conversation.conversation_id,
      initiator_agent_id: conversation.initiator_agent_id,
      target_agent_id: conversation.target_agent_id,
      reason: 'target_logged_out',
    });
  }
}

export function forceEndConversation(engine: WorldEngine, agentId: string): void {
  const conversation = findConversationByAgent(engine, agentId, ['active', 'closing']);
  if (!conversation) {
    return;
  }

  endConversation(engine, conversation.conversation_id, 'partner_logged_out');
}
