import type { WorldEngine } from '../engine/world-engine.js';
import { WorldError } from '../types/api.js';
import type { InfoCommandChoice } from '../types/choices.js';
import { formatActionSourceLine, getAvailableActionSourcesWithOptions } from './actions.js';
import {
  listConversationStartCandidates,
  listJoinableActiveConversations,
  listStandaloneTransferCandidates,
} from './info-commands.js';
import { isInTransfer } from './transfer.js';

export interface BuildChoicesTextOptions {
  forceShowActions?: boolean;
  excludeInfoCommands?: readonly InfoCommandChoice[];
  excludedActionIds?: readonly string[];
  includeStoredRejectedAction?: boolean;
}

export interface BuiltChoicesPrompt {
  text: string;
  suppressedActionIds: string[];
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
    ? (listConversationStartCandidates(engine, agentId, now).length > 0
        ? ['- conversation_start: 隣接エージェントに話しかける (target_agent_id: ID, message: 最初のメッセージ)']
        : [])
    : [];

  const conversationJoinLines = canJoinConversation
    ? (listJoinableActiveConversations(engine, agentId, now).length > 0
        ? ['- conversation_join: 進行中の会話に参加する (conversation_id: ID)']
        : [])
    : [];

  const hasTransferableItem = canStartStandaloneTransfer && agent.items.some((item) => item.quantity > 0);
  const hasTransferableMoney = agent.money > 0;
  const transferLines = canStartStandaloneTransfer && (hasTransferableItem || hasTransferableMoney)
    ? (listStandaloneTransferCandidates(engine, agentId, now).length > 0
        ? ['- transfer: 近くのエージェントにアイテム/お金を譲渡する (target_agent_id: ID, item: { item_id: ID, quantity: N } または money: 金額)']
        : [])
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

  const hasUsableItem = canStartInterruptibleCommand && agent.items.some((item) => item.quantity > 0);
  const useItemLine = hasUsableItem
    ? ['- use-item: アイテムを使用する (item_id: 使用するアイテムのID)']
    : [];

  const commandLines = [
    ...actionLines,
    ...useItemLine,
    ...transferLines,
    ...(canStartInterruptibleCommand
      ? [
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
    { id: 'get_status' as const, line: '- get_status: 自分の所持金・所持品・現在地を取得する' },
    { id: 'get_nearby_agents' as const, line: '- get_nearby_agents: 隣接エージェントの一覧を取得する' },
    { id: 'get_active_conversations' as const, line: '- get_active_conversations: 参加可能な進行中の会話一覧を取得する' },
  ]
    .filter(() => canStartInterruptibleCommand && !isInTransfer(agent))
    .filter(({ id }) => !excludedInfoCommands.has(id))
    .map(({ line }) => line);

  const lines = [
    ...commandLines,
    ...infoLines,
  ];

  return {
    text: `選択肢:\n${lines.join('\n')}`,
    suppressedActionIds,
  };
}

export function buildChoicesText(
  engine: WorldEngine,
  agentId: string,
  options: BuildChoicesTextOptions = {},
): string {
  return buildChoicesPrompt(engine, agentId, options).text;
}
