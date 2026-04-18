import { useEffect, useState } from 'react';

import type { FetchHistoryOptions, HistoryCacheEntry, SnapshotStoreState } from '../../store/snapshot-store.js';
import { getHistoryRetryOptions, shouldFetchHistory, toHistoryScopeKey } from '../../store/snapshot-store.js';
import type {
  SpectatorAgentSnapshot,
  SpectatorConversationSnapshot,
  SpectatorSnapshot,
} from '../../../worker/src/contracts/spectator-snapshot.js';
import { getAgentAvatarFallbackLabel } from '../../lib/agent-avatar.js';

export interface AgentOverlayProps {
  agent: SpectatorAgentSnapshot;
  compact?: boolean;
  history?: HistoryCacheEntry;
  historyCache?: SnapshotStoreState['history_cache'];
  expandedConversationIds?: SnapshotStoreState['expanded_conversation_ids'];
  fetchHistory?: SnapshotStoreState['fetchHistory'];
  onClose?: () => void;
  onToggleConversationExpanded?: (conversationId: string, expanded?: boolean) => void;
  snapshot?: Pick<SpectatorSnapshot, 'agents' | 'conversations' | 'timezone'>;
}

function AgentAvatar({ agent, compact }: { agent: SpectatorAgentSnapshot; compact: boolean }) {
  const [hasImageError, setHasImageError] = useState(false);
  const sizeClassName = compact ? 'h-14 w-14 text-xl' : 'h-16 w-16 text-2xl';
  const fallbackLabel = getAgentAvatarFallbackLabel(agent.agent_name);
  const shouldRenderImage = Boolean(agent.discord_bot_avatar_url) && !hasImageError;

  useEffect(() => {
    setHasImageError(false);
  }, [agent.agent_id, agent.discord_bot_avatar_url]);

  return (
    <div
      className={`${sizeClassName} flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-700 bg-slate-800 font-semibold text-white`}
      data-testid={compact ? 'mobile-agent-avatar' : 'desktop-agent-avatar'}
    >
      {shouldRenderImage ? (
        <img
          src={agent.discord_bot_avatar_url}
          alt={`${agent.agent_name} avatar`}
          className="h-full w-full object-cover"
          onError={() => setHasImageError(true)}
        />
      ) : (
        <span data-testid={compact ? 'mobile-agent-avatar-fallback' : 'desktop-agent-avatar-fallback'}>{fallbackLabel}</span>
      )}
    </div>
  );
}

function getConversationLabel(
  agent: SpectatorAgentSnapshot,
  conversation: SpectatorConversationSnapshot | undefined,
  snapshot: Pick<SpectatorSnapshot, 'agents' | 'conversations' | 'timezone'> | undefined,
): string {
  if (!conversation) {
    return agent.current_conversation_id ? `会話中 (${agent.current_conversation_id})` : '会話中';
  }

  const participantNames = conversation.participant_agent_ids
    .filter((participantAgentId) => participantAgentId !== agent.agent_id)
    .map(
      (participantAgentId) =>
        snapshot?.agents.find((participant) => participant.agent_id === participantAgentId)?.agent_name ?? participantAgentId,
    );
  const participantLabel = participantNames.length > 0 ? `（${participantNames.join('・')}）` : '';
  const speakerLabel = conversation.current_speaker_agent_id === agent.agent_id ? ' / 発話中' : '';

  return `会話中${participantLabel}${speakerLabel}`;
}

function getCurrentActivityLabel(
  agent: SpectatorAgentSnapshot,
  snapshot: Pick<SpectatorSnapshot, 'agents' | 'conversations' | 'timezone'> | undefined,
): string {
  if (agent.current_activity?.label) {
    return agent.current_activity.label;
  }

  switch (agent.state) {
    case 'moving':
      return agent.movement ? `移動中 ${agent.movement.from_node_id} → ${agent.movement.to_node_id}` : '移動中';
    case 'in_conversation':
      return getConversationLabel(
        agent,
        snapshot?.conversations.find((conversation) => conversation.conversation_id === agent.current_conversation_id),
        snapshot,
      );
    case 'in_action':
      return 'アクション中';
    case 'idle':
      return '待機中';
  }
}

function getStateLabel(agent: SpectatorAgentSnapshot): string {
  switch (agent.state) {
    case 'moving':
      return '移動中';
    case 'in_action':
      return 'アクション中';
    case 'in_conversation':
      return '会話中';
    case 'idle':
      return '待機中';
  }
}

function DetailCard({
  title,
  value,
  testId,
}: {
  title: string;
  value: string;
  testId: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
      <p className="text-xs uppercase tracking-wide text-slate-500">{title}</p>
      <p className="mt-2 text-white" data-testid={testId}>
        {value}
      </p>
    </div>
  );
}

function formatHistoryTimestamp(occurredAt: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    }).format(new Date(occurredAt));
  } catch {
    return new Date(occurredAt).toLocaleString('ja-JP');
  }
}

function HistoryRetryButton({
  onClick,
  testId,
}: {
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-200 transition-colors hover:border-slate-500 hover:text-white"
      data-testid={testId}
      onClick={onClick}
    >
      再試行
    </button>
  );
}

interface HistoryTimelineProps {
  history: HistoryCacheEntry | undefined;
  scope: { agent_id: string } | { conversation_id: string };
  historyCache?: SnapshotStoreState['history_cache'];
  expandedConversationIds?: SnapshotStoreState['expanded_conversation_ids'];
  fetchHistory?: SnapshotStoreState['fetchHistory'];
  onToggleConversationExpanded?: (conversationId: string, expanded?: boolean) => void;
  prefix: string;
  title: string;
  baseTestId: string;
  timeZone?: string;
  allowConversationExpansion?: boolean;
}

function HistoryTimeline({
  history,
  scope,
  historyCache,
  expandedConversationIds,
  fetchHistory,
  onToggleConversationExpanded,
  prefix,
  title,
  baseTestId,
  timeZone,
  allowConversationExpansion = false,
}: HistoryTimelineProps) {
  const handleFetch = (options?: FetchHistoryOptions) => {
    void fetchHistory?.(scope, options);
  };

  const handleRetry = () => {
    handleFetch(getHistoryRetryOptions(history));
  };

  const handleAppend = () => {
    const nextCursor = history && 'response' in history ? history.response?.next_cursor : undefined;
    if (!nextCursor) {
      return;
    }

    handleFetch({ cursor: nextCursor, merge: 'append' });
  };

  if (!history || history.status === 'idle' || (history.status === 'loading' && !history.response)) {
    return (
      <div
        className="rounded-2xl border border-dashed border-slate-700 p-4 text-slate-400"
        data-testid={`${baseTestId}-loading`}
      >
        履歴を読み込んでいます…
      </div>
    );
  }

  if (history.status === 'error' && !history.response) {
    return (
      <div
        className="rounded-2xl border border-dashed border-rose-900/80 bg-rose-950/30 p-4 text-rose-200"
        data-testid={`${baseTestId}-error`}
      >
        <p>履歴の取得に失敗しました</p>
        <div className="mt-3">
          <HistoryRetryButton onClick={handleRetry} testId={`${baseTestId}-retry`} />
        </div>
      </div>
    );
  }

  const items = history.response?.items ?? [];
  const isReplaceLoading = history.status === 'loading' && history.request.merge === 'replace';
  const isReplaceError = history.status === 'error' && Boolean(history.response) && history.request.merge === 'replace';
  const isAppendLoading = history.status === 'loading' && history.request.merge === 'append';
  const isAppendError = history.status === 'error' && Boolean(history.response) && history.request.merge === 'append';
  const nextCursor = history.response?.next_cursor;

  if (items.length === 0) {
    if (isReplaceLoading || isReplaceError) {
      return (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">{title}</p>
            {isReplaceLoading ? (
              <span className="text-xs text-cyan-300" data-testid={`${baseTestId}-updating`}>
                更新中…
              </span>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-rose-300" data-testid={`${baseTestId}-warning`}>
                  更新に失敗しました
                </span>
                <HistoryRetryButton onClick={handleRetry} testId={`${baseTestId}-warning-retry`} />
              </div>
            )}
          </div>
          <div className="mt-3 text-slate-400" data-testid={`${baseTestId}-empty`}>
            履歴はまだありません
          </div>
        </div>
      );
    }

    return (
      <div
        className="rounded-2xl border border-dashed border-slate-700 p-4 text-slate-400"
        data-testid={`${baseTestId}-empty`}
      >
        履歴はまだありません
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs uppercase tracking-wide text-slate-500">{title}</p>
        {isReplaceLoading ? (
          <span className="text-xs text-cyan-300" data-testid={`${baseTestId}-updating`}>
            更新中…
          </span>
        ) : isReplaceError ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-rose-300" data-testid={`${baseTestId}-warning`}>
              更新に失敗しました
            </span>
            <HistoryRetryButton onClick={handleRetry} testId={`${baseTestId}-warning-retry`} />
          </div>
        ) : null}
      </div>
      <ol className="mt-3 space-y-3" data-testid={`${baseTestId}-list`}>
        {items.map((item) => {
          const conversationId = allowConversationExpansion ? item.conversation_id : undefined;
          const isExpanded = conversationId ? Boolean(expandedConversationIds?.[conversationId]) : false;
          const conversationEntry = conversationId ? historyCache?.[toHistoryScopeKey({ conversation_id: conversationId })] : undefined;

          return (
            <li
              key={item.event_id}
              className="rounded-2xl border border-slate-800/80 bg-slate-950/70 p-3"
              data-testid={`${baseTestId}-item`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-white">
                    <span className="mr-2" aria-hidden="true">
                      {item.summary.emoji}
                    </span>
                    {item.summary.title}
                  </p>
                  <p className="mt-1 text-sm text-slate-300">{item.summary.text}</p>
                  {conversationId ? (
                    <div className="mt-2 space-y-3">
                      <div className="flex items-center gap-3">
                        <p className="text-xs text-slate-500">conversation: {conversationId}</p>
                        <button
                          type="button"
                          className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-200 transition-colors hover:border-slate-500 hover:text-white"
                          data-testid={`${prefix}-conversation-toggle-${conversationId}`}
                          onClick={() => {
                            const nextExpanded = !isExpanded;
                            onToggleConversationExpanded?.(conversationId, nextExpanded);

                            if (nextExpanded && shouldFetchHistory(conversationEntry)) {
                              void fetchHistory?.(
                                { conversation_id: conversationId },
                                getHistoryRetryOptions(conversationEntry),
                              );
                            }
                          }}
                        >
                          {isExpanded ? '折りたたむ' : '会話ログを表示'}
                        </button>
                      </div>
                      {isExpanded ? (
                        <div
                          className="rounded-2xl border border-slate-800 bg-slate-900/60 p-3"
                          data-testid={`${prefix}-conversation-history-panel-${conversationId}`}
                        >
                          <HistoryTimeline
                            history={conversationEntry}
                            scope={{ conversation_id: conversationId }}
                            historyCache={historyCache}
                            expandedConversationIds={expandedConversationIds}
                            fetchHistory={fetchHistory}
                            onToggleConversationExpanded={onToggleConversationExpanded}
                            prefix={prefix}
                            title="会話ログ"
                            baseTestId={`${prefix}-conversation-history-${conversationId}`}
                            timeZone={timeZone}
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <time className="shrink-0 text-xs text-slate-500">{formatHistoryTimestamp(item.occurred_at, timeZone)}</time>
              </div>
            </li>
          );
        })}
      </ol>
      {nextCursor || isAppendLoading || isAppendError ? (
        <div className="mt-4 flex flex-wrap items-center gap-3" data-testid={`${baseTestId}-pagination`}>
          {isAppendError ? (
            <span className="text-xs text-rose-300" data-testid={`${baseTestId}-append-error`}>
              続きの取得に失敗しました
            </span>
          ) : null}
          {nextCursor ? (
            <button
              type="button"
              className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-200 transition-colors hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
              data-testid={`${baseTestId}-load-more`}
              disabled={isAppendLoading}
              onClick={handleAppend}
            >
              {isAppendLoading ? '読み込み中…' : 'さらに読み込む'}
            </button>
          ) : null}
          {isAppendError ? <HistoryRetryButton onClick={handleAppend} testId={`${baseTestId}-append-retry`} /> : null}
        </div>
      ) : null}
    </div>
  );
}

export function AgentOverlay({
  agent,
  compact = false,
  history,
  historyCache,
  expandedConversationIds,
  fetchHistory,
  onClose,
  onToggleConversationExpanded,
  snapshot,
}: AgentOverlayProps) {
  const Wrapper = compact ? 'div' : 'aside';
  const containerClassName = compact
    ? 'rounded-3xl border border-slate-800 bg-slate-900/80 p-4'
    : 'flex min-h-screen flex-col border-l border-slate-800 bg-slate-950/95 p-6';
  const prefix = compact ? 'mobile' : 'desktop';

  return (
    <Wrapper className={containerClassName} data-testid={compact ? 'mobile-agent-overlay' : 'desktop-overlay'}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <AgentAvatar agent={agent} compact={compact} />
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-300">Agent detail</p>
            <h2 className="mt-2 text-2xl font-semibold text-white" data-testid={`${prefix}-agent-name`}>
              {agent.agent_name}
            </h2>
            <p className="mt-1 text-sm text-slate-400">selected_agent_id: {agent.agent_id}</p>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <div className="text-right">
            <p className="text-3xl leading-none" data-testid={`${prefix}-agent-status-emoji`}>
              {agent.status_emoji}
            </p>
            <p className="mt-2 text-xs uppercase tracking-wide text-slate-400">{getStateLabel(agent)}</p>
          </div>
          {onClose ? (
            <button
              type="button"
              className="rounded-full border border-slate-700 px-3 py-1 text-sm text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
              data-testid={compact ? 'mobile-overlay-close' : 'desktop-overlay-close'}
              onClick={onClose}
            >
              {compact ? '一覧へ戻る' : '閉じる'}
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-6 grid gap-3 text-sm text-slate-300">
        <DetailCard title="現在地" value={agent.node_id} testId={`${prefix}-agent-location`} />
        <DetailCard title="状態" value={getStateLabel(agent)} testId={`${prefix}-agent-state`} />
        <DetailCard
          title="現在の行動"
          value={getCurrentActivityLabel(agent, snapshot)}
          testId={`${prefix}-agent-activity`}
        />
        <HistoryTimeline
          history={history}
          scope={{ agent_id: agent.agent_id }}
          historyCache={historyCache}
          expandedConversationIds={expandedConversationIds}
          fetchHistory={fetchHistory}
          onToggleConversationExpanded={onToggleConversationExpanded}
          prefix={prefix}
          title="履歴"
          baseTestId={`${prefix}-agent-history`}
          timeZone={snapshot?.timezone}
          allowConversationExpansion
        />
      </div>
    </Wrapper>
  );
}
