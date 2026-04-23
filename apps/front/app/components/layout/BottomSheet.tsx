import { useMemo } from 'react';

import type {
  SpectatorAgentSnapshot,
  SpectatorSnapshot,
} from '../../../worker/src/contracts/spectator-snapshot.js';
import type { HistoryCacheEntry, MobileSheetMode, SnapshotStoreState } from '../../store/snapshot-store.js';
import { getAgentStateLabel } from '../../lib/agent-state-label.js';
import { formatNodeLabel } from '../../lib/node-label.js';
import { formatHistoryTimestamp } from '../../lib/timestamp.js';
import { AgentOverlay } from '../overlay/AgentOverlay.js';

export interface BottomSheetProps {
  snapshot?: SpectatorSnapshot;
  agents: SpectatorAgentSnapshot[];
  mode: MobileSheetMode;
  selectedAgent?: SpectatorAgentSnapshot;
  selectedAgentHistory?: HistoryCacheEntry;
  historyCache: SnapshotStoreState['history_cache'];
  expandedConversationIds: SnapshotStoreState['expanded_conversation_ids'];
  fetchHistory: SnapshotStoreState['fetchHistory'];
  onSelectAgent?: (agentId: string) => void;
  onClearSelectedAgent?: () => void;
  onToggleConversationExpanded?: (conversationId: string, expanded?: boolean) => void;
}

export function BottomSheet({
  snapshot,
  agents,
  mode,
  selectedAgent,
  selectedAgentHistory,
  historyCache,
  expandedConversationIds,
  fetchHistory,
  onSelectAgent,
  onClearSelectedAgent,
  onToggleConversationExpanded,
}: BottomSheetProps) {
  const recentServerEvents = useMemo(() => snapshot?.recent_server_events.slice(0, 3) ?? [], [snapshot]);

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden bg-slate-950"
      data-testid="mobile-bottom-sheet"
      data-sheet-mode={mode}
    >
      <div className="min-h-0 flex-1 overflow-hidden px-4 pb-2 pt-3">
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

            <section className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium text-slate-200">エージェント一覧</h2>
                <span className="text-xs text-slate-400">{agents.length} 人</span>
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
                            <p className="text-xs text-slate-400">{formatNodeLabel(agent.node_id, snapshot?.map)}</p>
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
    </section>
  );
}
