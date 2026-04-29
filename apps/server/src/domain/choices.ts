import type { WorldEngine } from '../engine/world-engine.js';
import { WorldError } from '../types/api.js';
import type { InfoCommandChoice } from '../types/choices.js';
import { manhattanDistance } from './map-utils.js';
import { formatActionSourceLine, getAvailableActionSourcesWithOptions } from './actions.js';
import { findConversationByAgent } from './conversation.js';
import { getAgentCurrentNode } from './movement.js';
import { isInTransfer } from './transfer.js';

export interface BuildChoicesTextOptions {
  forceShowActions?: boolean;
  excludeInfoCommands?: readonly InfoCommandChoice[];
  excludedActionIds?: readonly string[];
  excludedItemIds?: readonly string[];
  includeStoredRejectedAction?: boolean;
  includeStoredUsedItem?: boolean;
}

export interface BuiltChoicesPrompt {
  text: string;
  suppressedActionIds: string[];
  suppressedItemIds: string[];
}

export function buildChoicesPrompt(
  engine: WorldEngine,
  agentId: string,
  options: BuildChoicesTextOptions = {},
): BuiltChoicesPrompt {
  const agent = engine.state.getLoggedIn(agentId);
  if (!agent) {
    throw new WorldError(403, 'not_logged_in', `Agent is not logged in: ${agentId}`);
  }

  const now = Date.now();
  const currentNodeId = getAgentCurrentNode(engine, agent, now);
  const canStartInterruptibleCommand = options.forceShowActions
    || agent.active_server_event_id !== null
    || (agent.state === 'idle' && agent.pending_conversation_id === null && !isInTransfer(agent));
  // standalone transfer は idle / in_action（wait/action/use-item 中）から開始可能。
  // 進行中の活動は transfer 開始時に中断される（domain/transfer.ts acquireTransferRolesPair 参照）。
  const canStartStandaloneTransfer = ['idle', 'in_action'].includes(agent.state)
    && agent.pending_conversation_id === null
    && !isInTransfer(agent);
  const canStartConversation = agent.state === 'idle' && agent.pending_conversation_id === null && !isInTransfer(agent);
  const canJoinConversation = agent.pending_conversation_id === null
    && (agent.state === 'idle' || (canStartInterruptibleCommand && agent.state === 'in_action'));
  const rejectedActionIds = new Set(options.excludedActionIds ?? []);
  if (options.includeStoredRejectedAction !== false && agent.last_rejected_action_id) {
    rejectedActionIds.add(agent.last_rejected_action_id);
  }
  const availableActionSources = canStartInterruptibleCommand
    ? getAvailableActionSourcesWithOptions(engine, agentId)
    : [];
  const suppressedActionIds = availableActionSources
    .map((source) => source.action.action_id)
    .filter((actionId) => rejectedActionIds.has(actionId));
  const actionLines = canStartInterruptibleCommand
    ? availableActionSources
        .filter((source) => !rejectedActionIds.has(source.action.action_id))
        .map(
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

  // 所持していないものは譲渡の選択肢から外す（手元が空の状態で transfer を選ぶのは無意味）。
  // 形式は conversation_start と揃え「候補 1 人 = 1 行」。所持アイテムの item_id を
  // `or` で列挙して、エージェントが payload に書くべき item_id を特定できるようにする。
  const transferableItemIds = canStartStandaloneTransfer
    ? [...new Set(agent.items.filter((item) => item.quantity > 0).map((item) => item.item_id))]
        .sort((left, right) => left.localeCompare(right))
    : [];
  const hasTransferableItem = transferableItemIds.length > 0;
  const hasTransferableMoney = agent.money > 0;
  const transferPayloadHint = ((): string => {
    const parts: string[] = [];
    if (hasTransferableItem) {
      parts.push(`item: { item_id: ${transferableItemIds.join(' or ')}, quantity: 数量 }`);
    }
    if (hasTransferableMoney) {
      parts.push('money: 金額');
    }
    return parts.join(' または ');
  })();
  const transferLines = canStartStandaloneTransfer && (hasTransferableItem || hasTransferableMoney)
    ? engine.state
        .listLoggedIn()
        .filter((candidate) => candidate.agent_id !== agentId)
        .filter((candidate) => ['idle', 'in_action'].includes(candidate.state) && candidate.pending_conversation_id === null && !isInTransfer(candidate))
        .filter((candidate) => manhattanDistance(currentNodeId, getAgentCurrentNode(engine, candidate, now)) <= 1)
        .sort((left, right) => left.agent_id.localeCompare(right.agent_id))
        .map((candidate) => `- transfer: ${candidate.agent_name} に譲渡する (target_agent_id: ${candidate.agent_id}, ${transferPayloadHint})`)
    : [];
  const pendingTransferLines = agent.pending_transfer_id
    ? (() => {
        const offer = engine.state.transfers.get(agent.pending_transfer_id);
        if (!offer || offer.status === 'refund_failed') {
          return [] as string[];
        }
        const senderName = engine.getAgentById(offer.from_agent_id)?.agent_name ?? offer.from_agent_id;
        if (offer.mode === 'in_conversation') {
          return [
            `- conversation_speak: ${senderName} からの譲渡に返答する (message: 発言内容, next_speaker_agent_id: 次の話者ID, transfer_response: accept または reject)`,
            '- end_conversation: 会話を終える場合も transfer_response: accept または reject を同時指定する',
          ];
        }
        if (agent.active_server_event_id !== null) {
          return [] as string[];
        }
        return [
          `- accept_transfer: ${senderName} からの譲渡を受け取る`,
          `- reject_transfer: ${senderName} からの譲渡を断る`,
        ];
      })()
    : [];
  const conversationLines = [...conversationStartLines, ...conversationJoinLines];

  const excludedItemIds = new Set(options.excludedItemIds ?? []);
  if (options.includeStoredUsedItem !== false && agent.last_used_item_id) {
    excludedItemIds.add(agent.last_used_item_id);
  }
  const itemNames = new Map((engine.config.items ?? []).map((item) => [item.item_id, item.name]));
  const availableItemIds = canStartInterruptibleCommand
    ? [...new Set(agent.items.filter((item) => item.quantity > 0).map((item) => item.item_id))].sort((left, right) => left.localeCompare(right))
    : [];
  const suppressedItemIds = availableItemIds.filter((itemId) => excludedItemIds.has(itemId));
  const useItemLine = availableItemIds
    .filter((itemId) => !excludedItemIds.has(itemId))
    .map((itemId) => `- use-item: ${(itemNames.get(itemId) ?? itemId)} を使用する (item_id: ${itemId})`);

  const commandLines = [
    ...(canStartInterruptibleCommand
      ? [
          ...actionLines,
          ...useItemLine,
          ...transferLines,
          '- move: ノードIDを指定して移動する (target_node_id: ノードID)',
          '- wait: その場で待機する (duration: 1〜6、10分単位)',
          ...conversationLines,
        ]
      : []),
    ...pendingTransferLines,
  ];

  const excludedInfoCommands = new Set([
    ...engine.state.getExcludedInfoCommands(agent.agent_id),
    ...(options.excludeInfoCommands ?? []),
  ]);
  const infoLines = [
    { id: 'get_available_actions' as const, line: '- get_available_actions: 現在位置で実行可能なアクションを取得する' },
    { id: 'get_perception' as const, line: '- get_perception: 周囲の情報を取得する' },
    { id: 'get_map' as const, line: '- get_map: マップ全体の情報を取得する' },
    { id: 'get_world_agents' as const, line: '- get_world_agents: 全エージェントの位置と状態を取得する' },
  ]
    .filter(() => canStartInterruptibleCommand)
    .filter(({ id }) => !excludedInfoCommands.has(id))
    .map(({ line }) => line);

  const lines = [
    ...commandLines,
    ...infoLines,
  ];

  return {
    text: `選択肢:\n${lines.join('\n')}`,
    suppressedActionIds,
    suppressedItemIds,
  };
}

export function buildChoicesText(
  engine: WorldEngine,
  agentId: string,
  options: BuildChoicesTextOptions = {},
): string {
  return buildChoicesPrompt(engine, agentId, options).text;
}
