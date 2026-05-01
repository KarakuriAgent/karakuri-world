import type { WorldEngine } from '../engine/world-engine.js';
import type { AgentState, LoggedInAgent } from '../types/agent.js';
import { createNotificationAcceptedResponse, type NotificationAcceptedResponse } from '../types/api.js';
import type { InfoCommandChoice } from '../types/choices.js';
import type { ConversationData } from '../types/conversation.js';
import type { NodeId } from '../types/data-model.js';
import { requireInfoCommandReadyAgent } from './agent-guards.js';
import { manhattanDistance } from './map-utils.js';
import { getAgentCurrentNode } from './movement.js';
import { isInTransfer } from './transfer.js';

export interface CandidateAgent {
  readonly agent_id: string;
  readonly agent_name: string;
  readonly state: Extract<AgentState, 'idle' | 'in_action'>;
}

declare const candidateKindBrand: unique symbol;
export type ConversationStartCandidate = CandidateAgent & { readonly [candidateKindBrand]: 'conversation_start' };
export type StandaloneTransferCandidate = CandidateAgent & { readonly [candidateKindBrand]: 'standalone_transfer' };

function currentNode(engine: WorldEngine, agent: LoggedInAgent, now: number): NodeId {
  return getAgentCurrentNode(engine, agent, now);
}

function toCandidateAgent(agent: LoggedInAgent): CandidateAgent {
  // 呼び出し側で必ず state in {idle, in_action} に絞ってから渡すため、ここでは型 narrowing のみ実施
  if (agent.state !== 'idle' && agent.state !== 'in_action') {
    throw new Error(`toCandidateAgent received unsupported state: ${agent.state}`);
  }
  return { agent_id: agent.agent_id, agent_name: agent.agent_name, state: agent.state };
}

function asConversationStartCandidate(agent: LoggedInAgent): ConversationStartCandidate {
  return toCandidateAgent(agent) as ConversationStartCandidate;
}

function asStandaloneTransferCandidate(agent: LoggedInAgent): StandaloneTransferCandidate {
  return toCandidateAgent(agent) as StandaloneTransferCandidate;
}

export function listConversationStartCandidates(
  engine: WorldEngine,
  agentId: string,
  now = Date.now(),
): ConversationStartCandidate[] {
  const agent = engine.state.getLoggedIn(agentId);
  if (!agent) {
    return [];
  }
  const nodeId = currentNode(engine, agent, now);
  return engine.state
    .listLoggedIn()
    .filter((candidate) => candidate.agent_id !== agentId)
    .filter((candidate) => ['idle', 'in_action'].includes(candidate.state) && candidate.pending_conversation_id === null)
    .filter((candidate) => manhattanDistance(nodeId, currentNode(engine, candidate, now)) <= 1)
    .sort((left, right) => left.agent_id.localeCompare(right.agent_id))
    .map(asConversationStartCandidate);
}

export function listStandaloneTransferCandidates(
  engine: WorldEngine,
  agentId: string,
  now = Date.now(),
): StandaloneTransferCandidate[] {
  const agent = engine.state.getLoggedIn(agentId);
  if (!agent) {
    return [];
  }
  const nodeId = currentNode(engine, agent, now);
  return engine.state
    .listLoggedIn()
    .filter((candidate) => candidate.agent_id !== agentId)
    .filter(
      (candidate) =>
        ['idle', 'in_action'].includes(candidate.state)
        && candidate.pending_conversation_id === null
        && !isInTransfer(candidate),
    )
    .filter((candidate) => manhattanDistance(nodeId, currentNode(engine, candidate, now)) <= 1)
    .sort((left, right) => left.agent_id.localeCompare(right.agent_id))
    .map(asStandaloneTransferCandidate);
}

export function listJoinableActiveConversations(engine: WorldEngine, agentId: string, now = Date.now()): ConversationData[] {
  const agent = engine.state.getLoggedIn(agentId);
  if (!agent) {
    return [];
  }
  const nodeId = currentNode(engine, agent, now);
  return engine.state.conversations
    .list()
    .filter((conversation) => conversation.status === 'active')
    .filter((conversation) => !conversation.participant_agent_ids.includes(agentId) && !conversation.pending_participant_agent_ids.includes(agentId))
    .filter((conversation) => conversation.participant_agent_ids.length + conversation.pending_participant_agent_ids.length < engine.config.conversation.max_participants)
    .filter((conversation) => conversation.participant_agent_ids.some((participantId) => {
      const participant = engine.state.getLoggedIn(participantId);
      return participant && manhattanDistance(nodeId, currentNode(engine, participant, now)) <= 1;
    }))
    .sort((left, right) => left.conversation_id.localeCompare(right.conversation_id));
}

export function emitInfoRequest(
  engine: WorldEngine,
  agentId: string,
  command: InfoCommandChoice,
): NotificationAcceptedResponse {
  requireInfoCommandReadyAgent(engine, agentId, command);
  engine.state.addExcludedInfoCommand(agentId, command);
  switch (command) {
    case 'get_perception':
      engine.emitEvent({ type: 'perception_requested', agent_id: agentId });
      break;
    case 'get_map':
      engine.emitEvent({ type: 'map_info_requested', agent_id: agentId });
      break;
    case 'get_world_agents':
      engine.emitEvent({ type: 'world_agents_info_requested', agent_id: agentId });
      break;
    case 'get_available_actions':
      engine.emitEvent({ type: 'available_actions_requested', agent_id: agentId });
      break;
    case 'get_status':
      engine.emitEvent({ type: 'status_info_requested', agent_id: agentId });
      break;
    case 'get_nearby_agents':
      engine.emitEvent({ type: 'nearby_agents_info_requested', agent_id: agentId });
      break;
    case 'get_active_conversations':
      engine.emitEvent({ type: 'active_conversations_info_requested', agent_id: agentId });
      break;
    case 'get_event':
      engine.emitEvent({ type: 'server_events_info_requested', agent_id: agentId });
      break;
    default: {
      const exhaustive: never = command;
      throw new Error(`Unhandled info command: ${String(exhaustive)}`);
    }
  }
  return createNotificationAcceptedResponse();
}
