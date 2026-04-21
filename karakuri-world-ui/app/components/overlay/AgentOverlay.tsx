import { useEffect, useState } from 'react';

import type { FetchHistoryOptions, HistoryCacheEntry, SnapshotStoreState } from '../../store/snapshot-store.js';
import { getHistoryRetryOptions, shouldFetchHistory, toHistoryScopeKey } from '../../store/snapshot-store.js';
import type {
  SpectatorAgentSnapshot,
  SpectatorConversationSnapshot,
  SpectatorSnapshot,
} from '../../../worker/src/contracts/spectator-snapshot.js';
import { getAgentAvatarFallbackLabel } from '../../lib/agent-avatar.js';
import { collapseConversationHistoryForAgentTimeline, resolveHistorySpeaker } from '../../lib/history-speaker.js';
import { formatHistoryTimestamp } from '../../lib/timestamp.js';

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

type AgentAvatarSize = 'sm' | 'md' | 'lg';

const AGENT_AVATAR_SIZE_CLASSES: Record<AgentAvatarSize, string> = {
  sm: 'h-8 w-8 text-sm',
  md: 'h-14 w-14 text-xl',
  lg: 'h-16 w-16 text-2xl',
};

function AgentAvatar({
  agent,
  size = 'lg',
  testId,
  fallbackTestId,
}: {
  agent: Pick<SpectatorAgentSnapshot, 'agent_id' | 'agent_name' | 'discord_bot_avatar_url'>;
  size?: AgentAvatarSize;
  testId?: string;
  fallbackTestId?: string;
}) {
  const [hasImageError, setHasImageError] = useState(false);
  const sizeClassName = AGENT_AVATAR_SIZE_CLASSES[size];
  const fallbackLabel = getAgentAvatarFallbackLabel(agent.agent_name);
  const shouldRenderImage = Boolean(agent.discord_bot_avatar_url) && !hasImageError;

  useEffect(() => {
    setHasImageError(false);
  }, [agent.agent_id, agent.discord_bot_avatar_url]);

  return (
    <div
      className={`${sizeClassName} flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-700 bg-slate-800 font-semibold text-white`}
      data-testid={testId}
    >
      {shouldRenderImage ? (
        <img
          src={agent.discord_bot_avatar_url}
          alt={`${agent.agent_name} avatar`}
          className="h-full w-full object-cover"
          onError={() => setHasImageError(true)}
        />
      ) : (
        <span data-testid={fallbackTestId}>{fallbackLabel}</span>
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
    return '会話中';
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

function getCurrentActivitySummary(
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
  collapseConversationsToHeadUtterance?: boolean;
  reverseItemOrder?: boolean;
  snapshot?: Pick<SpectatorSnapshot, 'agents'>;
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
  collapseConversationsToHeadUtterance = false,
  reverseItemOrder = false,
  snapshot,
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

  const rawItems = history.response?.items ?? [];
  const collapsedItems = collapseConversationsToHeadUtterance
    ? collapseConversationHistoryForAgentTimeline(rawItems)
    : rawItems;
  const items = reverseItemOrder ? [...collapsedItems].reverse() : collapsedItems;
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
        {(() => {
          const seenConversationIds = new Set<string>();
          return items.map((item) => {
          const conversationId = allowConversationExpansion ? item.conversation_id : undefined;
          const isFirstInConversationGroup = conversationId ? !seenConversationIds.has(conversationId) : false;
          if (conversationId) {
            seenConversationIds.add(conversationId);
          }
          const showConversationToggle = Boolean(conversationId && isFirstInConversationGroup);
          const isExpanded = conversationId ? Boolean(expandedConversationIds?.[conversationId]) : false;
          const conversationEntry = conversationId ? historyCache?.[toHistoryScopeKey({ conversation_id: conversationId })] : undefined;
          const speaker = resolveHistorySpeaker(item, snapshot);

          return (
            <li
              key={item.event_id}
              className="rounded-2xl border border-slate-800/80 bg-slate-950/70 p-3"
              data-testid={`${baseTestId}-item`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {speaker ? (
                    <div className="flex items-start gap-2">
                      <AgentAvatar
                        agent={
                          speaker.agent ?? {
                            agent_id: speaker.speaker_agent_id,
                            agent_name: speaker.display_name,
                            discord_bot_avatar_url: undefined,
                          }
                        }
                        size="sm"
                        testId={`${baseTestId}-item-speaker-avatar-${item.event_id}`}
                        fallbackTestId={`${baseTestId}-item-speaker-avatar-fallback-${item.event_id}`}
                      />
                      <div className="min-w-0">
                        <p
                          className="text-sm font-medium text-white"
                          data-testid={`${baseTestId}-item-speaker-name-${item.event_id}`}
                        >
                          {speaker.display_name}
                        </p>
                        <p className="mt-1 text-sm text-slate-200">{item.summary.text}</p>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="font-medium text-white">
                        <span className="mr-2" aria-hidden="true">
                          {item.summary.emoji}
                        </span>
                        {item.summary.title}
                      </p>
                      <p className="mt-1 text-sm text-slate-300">{item.summary.text}</p>
                    </>
                  )}
                  {showConversationToggle && conversationId ? (
                    <div className="mt-2 space-y-3">
                      <div className="flex items-center gap-3">
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
                            reverseItemOrder
                            snapshot={snapshot}
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
          });
        })()}
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
    : 'flex h-screen flex-col overflow-y-auto border-l border-slate-800 bg-slate-950/95 p-6';
  const prefix = compact ? 'mobile' : 'desktop';

  return (
    <Wrapper className={containerClassName} data-testid={compact ? 'mobile-agent-overlay' : 'desktop-overlay'}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          <AgentAvatar
            agent={agent}
            size={compact ? 'md' : 'lg'}
            testId={compact ? 'mobile-agent-avatar' : 'desktop-agent-avatar'}
            fallbackTestId={compact ? 'mobile-agent-avatar-fallback' : 'desktop-agent-avatar-fallback'}
          />
          <div className="min-w-0">
            <h2 className="text-2xl font-semibold text-white" data-testid={`${prefix}-agent-name`}>
              {agent.agent_name}
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              現在地:{' '}
              <span className="text-slate-200" data-testid={`${prefix}-agent-location`}>
                {agent.node_id}
              </span>
            </p>
          </div>
        </div>
        {onClose ? (
          <button
            type="button"
            className="shrink-0 rounded-full border border-slate-700 px-3 py-1 text-sm text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
            data-testid={compact ? 'mobile-overlay-close' : 'desktop-overlay-close'}
            onClick={onClose}
          >
            {compact ? '一覧へ戻る' : '閉じる'}
          </button>
        ) : null}
      </div>

      <div className="mt-6 grid gap-3 text-sm text-slate-300">
        <DetailCard
          title="現在の行動"
          value={getCurrentActivitySummary(agent, snapshot)}
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
          collapseConversationsToHeadUtterance
          snapshot={snapshot}
        />
      </div>
    </Wrapper>
  );
}
