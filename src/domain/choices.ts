import type { WorldEngine } from '../engine/world-engine.js';
import { WorldError } from '../types/api.js';
import { manhattanDistance } from './map-utils.js';
import { formatActionSourceLine, getAvailableActionSources } from './actions.js';
import { findConversationByAgent } from './conversation.js';
import { getAgentCurrentNode } from './movement.js';

export function buildChoicesText(
  engine: WorldEngine,
  agentId: string,
  options: { forceShowActions?: boolean } = {},
): string {
  const agent = engine.state.getLoggedIn(agentId);
  if (!agent) {
    throw new WorldError(403, 'not_logged_in', `Agent is not logged in: ${agentId}`);
  }

  const now = Date.now();
  const currentNodeId = getAgentCurrentNode(engine, agent, now);
  const canStartInterruptibleCommand = options.forceShowActions || (agent.state === 'idle' && agent.pending_conversation_id === null);
  const canStartConversation = agent.state === 'idle' && agent.pending_conversation_id === null;
  const canJoinConversation = agent.pending_conversation_id === null
    && (agent.state === 'idle' || (options.forceShowActions && agent.state === 'in_action'));
  const actionLines = canStartInterruptibleCommand
    ? getAvailableActionSources(engine, agentId).map(
        (source) => `- action: ${formatActionSourceLine(source, engine.config.items ?? [])}`,
      )
    : [];
  const conversationStartLines = canStartConversation
    ? engine.state
        .listLoggedIn()
        .filter((candidate) => candidate.agent_id !== agentId)
        .map((candidate) => ({
          ...candidate,
          current_node_id: getAgentCurrentNode(engine, candidate, now),
        }))
        .filter(
          (candidate) =>
            ['idle', 'in_action'].includes(candidate.state)
            && candidate.pending_conversation_id === null
            && manhattanDistance(currentNodeId, candidate.current_node_id) <= 1,
        )
        .sort((left, right) => left.agent_id.localeCompare(right.agent_id))
        .map(
          (candidate) =>
            `- conversation_start: ${candidate.agent_name} に話しかける (target_agent_id: ${candidate.agent_id}, message: 最初のメッセージ)`,
        )
    : [];

  const conversationJoinLines = canJoinConversation
    ? engine.state.conversations
        .list()
        .filter((conversation) => conversation.status === 'active')
        .filter((conversation) => !conversation.participant_agent_ids.includes(agentId) && !conversation.pending_participant_agent_ids.includes(agentId))
        .filter((conversation) => conversation.participant_agent_ids.length + conversation.pending_participant_agent_ids.length < engine.config.conversation.max_participants)
        .filter((conversation) => conversation.participant_agent_ids.some((participantId) => {
          const participant = engine.state.getLoggedIn(participantId);
          return participant && manhattanDistance(currentNodeId, getAgentCurrentNode(engine, participant, now)) <= 1;
        }))
        .sort((left, right) => left.conversation_id.localeCompare(right.conversation_id))
        .map((conversation) => {
          const participantNames = conversation.participant_agent_ids
            .map((participantId) => engine.getAgentById(participantId)?.agent_name ?? participantId)
            .join(' と ');
          return `- conversation_join: ${participantNames} の会話に参加する (conversation_id: ${conversation.conversation_id})`;
        })
    : [];

  const conversationLines = [...conversationStartLines, ...conversationJoinLines];

  const hasItems = canStartInterruptibleCommand && agent.items.some((item) => item.quantity > 0);
  const useItemLine = hasItems
    ? ['- use-item: アイテムを使用する (item_id: アイテムID)']
    : [];

  const commandLines = canStartInterruptibleCommand
    ? [
        ...actionLines,
        ...useItemLine,
        '- move: ノードIDを指定して移動する (target_node_id: ノードID)',
        '- wait: その場で待機する (duration: 1〜6、10分単位)',
        ...conversationLines,
      ]
    : [];

  const lines = [
    ...commandLines,
    '- get_map: マップ全体の情報を取得する',
    '- get_world_agents: 全エージェントの位置と状態を取得する',
  ];

  return `選択肢:\n${lines.join('\n')}`;
}
