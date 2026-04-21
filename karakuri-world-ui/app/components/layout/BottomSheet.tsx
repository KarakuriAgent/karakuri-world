import { useMemo, useRef } from 'react';

import type {
  SpectatorAgentSnapshot,
  SpectatorSnapshot,
} from '../../../worker/src/contracts/spectator-snapshot.js';
import type { HistoryCacheEntry, MobileSheetMode, SnapshotStoreState } from '../../store/snapshot-store.js';
import { getAgentStateLabel } from '../../lib/agent-state-label.js';
import { getSidebarServerEvents } from '../../lib/recent-server-events.js';
import { formatHistoryTimestamp } from '../../lib/timestamp.js';
import { AgentOverlay } from '../overlay/AgentOverlay.js';

export interface BottomSheetProps {
  snapshot?: SpectatorSnapshot;
  agents: SpectatorAgentSnapshot[];
  mode: MobileSheetMode;
  maxHeight?: string;
  selectedAgent?: SpectatorAgentSnapshot;
  selectedAgentHistory?: HistoryCacheEntry;
  historyCache: SnapshotStoreState['history_cache'];
  expandedConversationIds: SnapshotStoreState['expanded_conversation_ids'];
  fetchHistory: SnapshotStoreState['fetchHistory'];
  onSelectAgent?: (agentId: string) => void;
  onClearSelectedAgent?: () => void;
  onToggleConversationExpanded?: (conversationId: string, expanded?: boolean) => void;
  onModeChange?: (mode: MobileSheetMode) => void;
}

const SHEET_HEIGHTS: Record<MobileSheetMode, string> = {
  peek: '88px',
  list: '45dvh',
  detail: '82dvh',
};

const SWIPE_THRESHOLD_PX = 48;

function getPreviousMode(mode: MobileSheetMode): MobileSheetMode | undefined {
  switch (mode) {
    case 'detail':
      return 'list';
    case 'list':
      return 'peek';
    case 'peek':
      return undefined;
  }
}

function getNextMode(mode: MobileSheetMode, hasSelectedAgent: boolean): MobileSheetMode | undefined {
  switch (mode) {
    case 'peek':
      return 'list';
    case 'list':
      return hasSelectedAgent ? 'detail' : undefined;
    case 'detail':
      return undefined;
  }
}

function getSheetHeading(mode: MobileSheetMode): string {
  switch (mode) {
    case 'peek':
      return '現在の世界';
    case 'list':
      return '観戦一覧';
    case 'detail':
      return '選択中エージェント';
  }
}

export function BottomSheet({
  snapshot,
  agents,
  mode,
  maxHeight,
  selectedAgent,
  selectedAgentHistory,
  historyCache,
  expandedConversationIds,
  fetchHistory,
  onSelectAgent,
  onClearSelectedAgent,
  onToggleConversationExpanded,
  onModeChange,
}: BottomSheetProps) {
  const dragStartY = useRef<number | null>(null);
  const recentServerEvents = useMemo(() => getSidebarServerEvents(snapshot), [snapshot]);
  const hasSelectedAgent = Boolean(selectedAgent);

  const setMode = (nextMode: MobileSheetMode) => {
    onModeChange?.(nextMode);
  };

  const advanceSheet = () => {
    const nextMode = getNextMode(mode, hasSelectedAgent);
    if (nextMode) {
      setMode(nextMode);
    }
  };

  const collapseSheet = () => {
    const previousMode = getPreviousMode(mode);
    if (previousMode) {
      setMode(previousMode);
    }
  };

  const handleDragStart = (clientY: number) => {
    dragStartY.current = clientY;
  };

  const handleDragEnd = (clientY: number) => {
    if (dragStartY.current === null) {
      return;
    }

    const deltaY = clientY - dragStartY.current;
    dragStartY.current = null;

    if (deltaY <= -SWIPE_THRESHOLD_PX) {
      advanceSheet();
      return;
    }

    if (deltaY >= SWIPE_THRESHOLD_PX) {
      collapseSheet();
    }
  };

  return (
    <section
      className="overflow-hidden rounded-[28px] border border-slate-800 bg-slate-950/95 shadow-2xl backdrop-blur transition-[height] duration-200 ease-out"
      data-testid="mobile-bottom-sheet"
      data-sheet-mode={mode}
      style={{
        height: SHEET_HEIGHTS[mode],
        ...(maxHeight ? { maxHeight } : {}),
      }}
    >
      <div className="flex h-full flex-col">
        <button
          type="button"
          className="flex flex-col items-center gap-2 px-4 pt-4 pb-3 text-left"
          data-testid="mobile-bottom-sheet-handle"
          aria-label={`${getSheetHeading(mode)}を切り替える`}
          onClick={() => {
            if (mode === 'detail') {
              collapseSheet();
              return;
            }

            advanceSheet();
          }}
          onTouchStart={(event) => handleDragStart(event.touches[0]?.clientY ?? 0)}
          onTouchEnd={(event) => handleDragEnd(event.changedTouches[0]?.clientY ?? 0)}
          onPointerDown={(event) => handleDragStart(event.clientY)}
          onPointerUp={(event) => handleDragEnd(event.clientY)}
        >
          <span className="h-1.5 w-12 rounded-full bg-slate-700" />
          <div className="flex w-full items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-300">{getSheetHeading(mode)}</p>
              <p className="mt-1 text-sm text-slate-400">
                {mode === 'peek' ? '上にスワイプして一覧を開く' : mode === 'list' ? '一覧から詳細へ移動できます' : '下にスワイプして一覧へ戻る'}
              </p>
            </div>
            <div className="text-right text-xs text-slate-400">
              <p>エージェント {agents.length} 人</p>
            </div>
          </div>
        </button>

        <div className="min-h-0 flex-1 overflow-hidden px-4 pb-4">
          {mode === 'peek' ? <div className="sr-only" data-testid="mobile-peek-panel">エージェント数 {agents.length}</div> : null}

          {mode === 'list' ? (
            <div className="flex h-full flex-col gap-4 overflow-hidden" data-testid="mobile-list-panel">
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-medium text-slate-200">直近サーバーイベント</h2>
                  <span className="text-xs text-slate-400">{recentServerEvents.length} 件</span>
                </div>
                {recentServerEvents.length ? (
                  <div className="space-y-2">
                    {recentServerEvents.map((event) => (
                      <div
                        key={event.server_event_id}
                        className="rounded-2xl border border-slate-800 bg-slate-900/70 p-3 text-sm"
                        data-testid="mobile-server-event-item"
                      >
                        <p className="text-slate-100">{event.description}</p>
                        <time className="mt-1 block text-xs text-slate-500">
                          {formatHistoryTimestamp(event.occurred_at, snapshot?.timezone)}
                        </time>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-700 p-3 text-sm text-slate-400">
                    サーバーイベントはまだありません
                  </div>
                )}
              </section>

              <section className="min-h-0 flex-1 space-y-2 overflow-hidden">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-medium text-slate-200">エージェント一覧</h2>
                  <span className="text-xs text-slate-400">{agents.length} agents</span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto" data-testid="mobile-agent-list">
                  {agents.length > 0 ? (
                    <div className="space-y-2">
                      {agents.map((agent) => (
                        <button
                          key={agent.agent_id}
                          type="button"
                          className="w-full rounded-2xl border border-slate-800 bg-slate-900/70 p-3 text-left transition-colors hover:border-slate-700 hover:bg-slate-900"
                          data-testid={`mobile-agent-button-${agent.agent_id}`}
                          onClick={() => onSelectAgent?.(agent.agent_id)}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="font-medium text-slate-100">{agent.agent_name}</p>
                              <p className="text-xs text-slate-400">{agent.node_id}</p>
                            </div>
                            <div className="text-right">
                              <p className="text-lg leading-none">{agent.status_emoji}</p>
                              <p className="mt-1 text-xs text-slate-400">{getAgentStateLabel(agent.state)}</p>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-slate-700 p-3 text-sm text-slate-400">
                      エージェントが接続するとここに一覧が表示されます
                    </div>
                  )}
                </div>
              </section>
            </div>
          ) : null}

          {mode === 'detail' && selectedAgent ? (
            <div className="h-full overflow-y-auto" data-testid="mobile-detail-panel">
              <AgentOverlay
                agent={selectedAgent}
                history={selectedAgentHistory}
                historyCache={historyCache}
                expandedConversationIds={expandedConversationIds}
                compact
                fetchHistory={fetchHistory}
                onClose={onClearSelectedAgent}
                onToggleConversationExpanded={onToggleConversationExpanded}
                snapshot={snapshot}
              />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
