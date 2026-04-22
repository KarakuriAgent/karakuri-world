import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';

import type { AppEnv } from './env-contract.js';
import { AppShell } from './components/layout/AppShell.js';
import { SnapshotStatusBadges } from './components/layout/SnapshotStatusBadges.js';
import {
  createSnapshotStore,
  getHistoryRetryOptions,
  shouldFetchHistory,
  toHistoryScopeKey,
  type MobileSheetMode,
  type SnapshotStatus,
  type SnapshotStoreApi,
} from './store/snapshot-store.js';

export interface AppProps {
  env: AppEnv;
  store?: SnapshotStoreApi;
  autoStartPolling?: boolean;
}

function SnapshotStatusBanner({
  snapshotStatus,
  isStale,
  className,
}: {
  snapshotStatus: SnapshotStatus;
  isStale: boolean;
  className?: string;
}) {
  if ((snapshotStatus === 'idle' || snapshotStatus === 'loading' || snapshotStatus === 'ready') && !isStale) {
    return null;
  }

  return (
    <div
      className={className ?? 'pointer-events-none absolute inset-x-0 top-0 z-20 hidden justify-center p-4 lg:flex'}
      data-testid="snapshot-status-banner"
    >
      <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-full border border-amber-400/30 bg-slate-950/95 px-4 py-2 text-sm text-slate-100 shadow-lg backdrop-blur">
        <SnapshotStatusBadges snapshotStatus={snapshotStatus} isStale={isStale} />
      </div>
    </div>
  );
}

function FullscreenLoading({ snapshotStatus }: { snapshotStatus: SnapshotStatus }) {
  const eyebrow = snapshotStatus === 'incompatible' ? '観戦 UI の更新が必要' : '観戦ビュー読み込み中';
  const message =
    snapshotStatus === 'incompatible'
      ? '観戦 UI の更新が必要です。再読み込みしてください。'
      : snapshotStatus === 'error'
        ? '最新スナップショットの再取得を待っています…'
        : '観戦ビューを準備しています…';

  return (
    <main
      className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100"
      data-testid="snapshot-loading-screen"
    >
      <div className="max-w-md rounded-3xl border border-slate-800 bg-slate-900/70 p-8 text-center shadow-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-300">{eyebrow}</p>
        <h1 className="mt-3 text-2xl font-semibold text-white">Karakuri World</h1>
        <p className="mt-3 text-sm text-slate-300">{message}</p>
      </div>
    </main>
  );
}

export function App({ env, store, autoStartPolling = true }: AppProps) {
  const localStoreRef = useRef<SnapshotStoreApi | undefined>(undefined);

  if (!store && !localStoreRef.current) {
    localStoreRef.current = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      historyApiUrl: env.apiBaseUrl,
    });
  }

  const snapshotStore = store ?? localStoreRef.current!;
  const snapshot = useStore(snapshotStore, (state) => state.snapshot);
  const snapshotStatus = useStore(snapshotStore, (state) => state.snapshot_status);
  const selectedAgentId = useStore(snapshotStore, (state) => state.selected_agent_id);
  const selectionRevision = useStore(snapshotStore, (state) => state.selected_agent_revision);
  const historyCache = useStore(snapshotStore, (state) => state.history_cache);
  const selectedAgentHistory = useStore(snapshotStore, (state) =>
    selectedAgentId ? state.history_cache[toHistoryScopeKey({ agent_id: selectedAgentId })] : undefined,
  );
  const expandedConversationIds = useStore(snapshotStore, (state) => state.expanded_conversation_ids);
  const setSelectedAgentId = useStore(snapshotStore, (state) => state.setSelectedAgentId);
  const fetchHistory = useStore(snapshotStore, (state) => state.fetchHistory);
  const toggleConversationExpanded = useStore(snapshotStore, (state) => state.toggleConversationExpanded);
  const mobileSheetMode = useStore(snapshotStore, (state) => state.mobile_sheet_mode);
  const setMobileSheetMode = useStore(snapshotStore, (state) => state.setMobileSheetMode);
  const isStale = useStore(snapshotStore, (state) => state.is_stale);

  useEffect(() => {
    if (snapshotStore.getState().history_api_url === env.apiBaseUrl) {
      return;
    }

    snapshotStore.setState(() => ({
      history_api_url: env.apiBaseUrl,
    }));
  }, [env.apiBaseUrl, snapshotStore]);

  useEffect(() => {
    if (!autoStartPolling) {
      return;
    }

    void snapshotStore.getState().startPolling();

    return () => {
      snapshotStore.getState().stopPolling();
    };
  }, [autoStartPolling, snapshotStore]);

  useEffect(() => {
    if (!selectedAgentId) {
      return;
    }

    const cacheEntry = snapshotStore.getState().history_cache[toHistoryScopeKey({ agent_id: selectedAgentId })];

    if (cacheEntry?.status !== 'loading' && !shouldFetchHistory(cacheEntry)) {
      return;
    }

    void fetchHistory({ agent_id: selectedAgentId }, getHistoryRetryOptions(cacheEntry));
  }, [fetchHistory, selectedAgentId, selectionRevision, snapshotStore]);

  if (!snapshot) {
    return <FullscreenLoading snapshotStatus={snapshotStatus} />;
  }

  return (
    <>
      <SnapshotStatusBanner snapshotStatus={snapshotStatus} isStale={isStale} />
      <AppShell
        snapshot={snapshot}
        snapshotStatus={snapshotStatus}
        isStale={isStale}
        selectedAgentId={selectedAgentId}
        phase3EffectsEnabled={env.phase3EffectsEnabled ?? false}
        phase3EnvironmentEffectFlags={env.phase3EnvironmentEffects}
        phase3MotionEffectFlags={env.phase3MotionEffects}
        historyCache={historyCache}
        selectedAgentHistory={selectedAgentHistory}
        expandedConversationIds={expandedConversationIds}
        selectionRevision={selectionRevision}
        mobileSheetMode={mobileSheetMode}
        fetchHistory={fetchHistory}
        onSelectAgent={setSelectedAgentId}
        onClearSelectedAgent={() => setSelectedAgentId(undefined)}
        onToggleConversationExpanded={toggleConversationExpanded}
        onMobileSheetModeChange={(mode: MobileSheetMode) => setMobileSheetMode(mode)}
      />
    </>
  );
}
