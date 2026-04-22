import { useCallback, useEffect, useRef, useState } from 'react';

import type { SpectatorSnapshot } from '../../../worker/src/contracts/spectator-snapshot.js';
import type { Phase3EnvironmentEffectFlags } from '../map/environment-effects.js';
import type { Phase3MotionEffectFlags } from '../map/motion-effects.js';
import {
  toHistoryScopeKey,
  type HistoryCacheEntry,
  type MobileSheetMode,
  type SnapshotStatus,
  type SnapshotStoreState,
} from '../../store/snapshot-store.js';

import {
  OVERLAY_WIDTH_DEFAULT_PX,
  clampOverlayWidth,
  loadOverlayWidth,
  saveOverlayWidth,
} from '../../lib/overlay-width.js';
import { sortAgentsForSidebar } from '../../lib/sort-agents.js';
import { MapCanvasHost } from '../map/MapCanvasHost.js';
import { AgentOverlay } from '../overlay/AgentOverlay.js';
import { BottomSheet } from './BottomSheet.js';
import { SnapshotStatusBadges } from './SnapshotStatusBadges.js';
import { Sidebar } from './Sidebar.js';
import { TopBadge } from './TopBadge.js';

export interface AppShellProps {
  snapshot?: SpectatorSnapshot;
  snapshotStatus: SnapshotStatus;
  isStale: boolean;
  selectedAgentId?: string;
  phase3EffectsEnabled?: boolean;
  phase3EnvironmentEffectFlags?: Partial<Phase3EnvironmentEffectFlags>;
  phase3MotionEffectFlags?: Partial<Phase3MotionEffectFlags>;
  historyCache: SnapshotStoreState['history_cache'];
  selectedAgentHistory?: HistoryCacheEntry;
  expandedConversationIds: SnapshotStoreState['expanded_conversation_ids'];
  selectionRevision?: number;
  mobileSheetMode: MobileSheetMode;
  fetchHistory: SnapshotStoreState['fetchHistory'];
  onSelectAgent?: (agentId: string) => void;
  onClearSelectedAgent?: () => void;
  onToggleConversationExpanded?: (conversationId: string, expanded?: boolean) => void;
}

const DESKTOP_OVERLAY_ANIMATION_MS = 200;
const MOBILE_TOP_STACK_PADDING_TOP = 'calc(env(safe-area-inset-top, 0px) + 1rem)';
const MOBILE_BOTTOM_SHEET_PADDING_BOTTOM = 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)';

function hasSnapshotStatusBanner(snapshotStatus: SnapshotStatus, isStale: boolean): boolean {
  return !((snapshotStatus === 'idle' || snapshotStatus === 'loading' || snapshotStatus === 'ready') && !isStale);
}

export function AppShell({
  snapshot,
  snapshotStatus,
  isStale,
  selectedAgentId,
  phase3EffectsEnabled = false,
  phase3EnvironmentEffectFlags,
  phase3MotionEffectFlags,
  historyCache,
  selectedAgentHistory,
  expandedConversationIds,
  selectionRevision = 0,
  mobileSheetMode,
  fetchHistory,
  onSelectAgent,
  onClearSelectedAgent,
  onToggleConversationExpanded,
}: AppShellProps) {
  const selectedAgent = snapshot?.agents.find((agent) => agent.agent_id === selectedAgentId);
  const sortedAgents = snapshot ? sortAgentsForSidebar(snapshot.agents) : [];
  const [desktopOverlayAgent, setDesktopOverlayAgent] = useState(selectedAgent);
  const [isDesktopOverlayVisible, setIsDesktopOverlayVisible] = useState(Boolean(selectedAgent));
  const showMobileStatusBanner = hasSnapshotStatusBanner(snapshotStatus, isStale);
  const [overlayWidth, setOverlayWidth] = useState<number>(OVERLAY_WIDTH_DEFAULT_PX);
  const resizePointerIdRef = useRef<number | null>(null);

  useEffect(() => {
    setOverlayWidth(loadOverlayWidth());

    if (typeof window === 'undefined') {
      return;
    }
    const handleViewportResize = () => {
      setOverlayWidth((current) => clampOverlayWidth(current, window.innerWidth));
    };
    window.addEventListener('resize', handleViewportResize);
    return () => window.removeEventListener('resize', handleViewportResize);
  }, []);

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      resizePointerIdRef.current = event.pointerId;
      const overlayRight =
        typeof window !== 'undefined' ? window.innerWidth : handle.getBoundingClientRect().right;

      const handleMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== resizePointerIdRef.current) {
          return;
        }
        const proposedWidth = overlayRight - moveEvent.clientX;
        setOverlayWidth(
          clampOverlayWidth(proposedWidth, typeof window !== 'undefined' ? window.innerWidth : undefined),
        );
      };

      const handleUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== resizePointerIdRef.current) {
          return;
        }
        resizePointerIdRef.current = null;
        handle.releasePointerCapture(upEvent.pointerId);
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
        window.removeEventListener('pointercancel', handleUp);
        setOverlayWidth((current) => {
          const clamped = clampOverlayWidth(
            current,
            typeof window !== 'undefined' ? window.innerWidth : undefined,
          );
          saveOverlayWidth(clamped);
          return clamped;
        });
      };

      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleUp);
      window.addEventListener('pointercancel', handleUp);
    },
    [],
  );

  useEffect(() => {
    if (selectedAgent) {
      setDesktopOverlayAgent(selectedAgent);
      const animationFrameId = window.setTimeout(() => {
        setIsDesktopOverlayVisible(true);
      }, 0);

      return () => {
        window.clearTimeout(animationFrameId);
      };
    }

    setIsDesktopOverlayVisible(false);
    const timeoutId = window.setTimeout(() => {
      setDesktopOverlayAgent(undefined);
    }, DESKTOP_OVERLAY_ANIMATION_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [selectedAgent]);

  const hasDesktopOverlay = Boolean(selectedAgent || desktopOverlayAgent);
  const desktopOverlayHistory = desktopOverlayAgent
    ? historyCache[toHistoryScopeKey({ agent_id: desktopOverlayAgent.agent_id })]
    : undefined;

  return (
    <main
      className="fixed inset-0 overflow-hidden bg-slate-950 text-slate-100 lg:relative lg:inset-auto lg:min-h-screen lg:overflow-visible"
      data-testid="app-shell"
    >
      {/* デスクトップ & モバイル横画面: 左 Sidebar + 右 Map */}
      <div
        className="relative hidden h-full grid-cols-[320px_minmax(0,1fr)] landscape:grid landscape:h-full max-lg:landscape:grid-cols-[240px_minmax(0,1fr)] lg:grid lg:min-h-screen"
        data-testid="desktop-shell"
      >
        <Sidebar
          snapshot={snapshot}
          agents={sortedAgents}
          selectedAgentId={selectedAgentId}
          onSelectAgent={onSelectAgent}
        />
        <MapCanvasHost
          snapshot={snapshot}
          selectedAgentId={selectedAgentId}
          selectionRevision={selectionRevision}
          overlayOffsetX={hasDesktopOverlay ? overlayWidth : 0}
          phase3EffectsEnabled={phase3EffectsEnabled}
          phase3EnvironmentEffectFlags={phase3EnvironmentEffectFlags}
          phase3MotionEffectFlags={phase3MotionEffectFlags}
          onSelectAgent={onSelectAgent}
        />
      </div>

      {hasDesktopOverlay ? (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 hidden overflow-hidden landscape:block lg:block"
          data-testid="desktop-overlay-rail"
        >
          <div
            className={`pointer-events-auto relative h-full transition-transform duration-200 ease-out ${
              isDesktopOverlayVisible ? 'translate-x-0' : 'translate-x-full'
            }`}
            style={{ width: overlayWidth }}
          >
            <div
              aria-hidden
              className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize bg-transparent hover:bg-cyan-400/40"
              data-testid="desktop-overlay-resize-handle"
              onPointerDown={handleResizePointerDown}
            />
            {desktopOverlayAgent ? (
              <AgentOverlay
                agent={desktopOverlayAgent}
                history={desktopOverlayHistory}
                historyCache={historyCache}
                expandedConversationIds={expandedConversationIds}
                fetchHistory={fetchHistory}
                onClose={onClearSelectedAgent}
                onToggleConversationExpanded={onToggleConversationExpanded}
                snapshot={snapshot}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {/* モバイル縦画面: マップと下部パネルを 50:50 で縦積み */}
      <div
        className="grid h-full grid-rows-2 landscape:hidden lg:hidden"
        data-testid="mobile-shell"
      >
        <div
          className="relative min-h-0 overflow-hidden border-b border-slate-800"
          data-testid="mobile-map-area"
        >
          <MapCanvasHost
            snapshot={snapshot}
            selectedAgentId={selectedAgentId}
            selectionRevision={selectionRevision}
            phase3EffectsEnabled={phase3EffectsEnabled}
            phase3EnvironmentEffectFlags={phase3EnvironmentEffectFlags}
            phase3MotionEffectFlags={phase3MotionEffectFlags}
            onSelectAgent={onSelectAgent}
          />
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col gap-2 p-4"
            style={{ paddingTop: MOBILE_TOP_STACK_PADDING_TOP }}
            data-testid="mobile-top-stack"
          >
            <div className="pointer-events-auto">
              <TopBadge snapshot={snapshot} />
            </div>
            {showMobileStatusBanner ? (
              <div className="pointer-events-auto" data-testid="mobile-snapshot-status-banner">
                <div className="flex flex-wrap items-center gap-2 rounded-full border border-amber-400/30 bg-slate-950/95 px-4 py-2 text-sm text-slate-100 shadow-lg backdrop-blur">
                  <SnapshotStatusBadges snapshotStatus={snapshotStatus} isStale={isStale} testIdPrefix="mobile" />
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div
          className="min-h-0 overflow-hidden bg-slate-950"
          style={{ paddingBottom: MOBILE_BOTTOM_SHEET_PADDING_BOTTOM }}
          data-testid="mobile-bottom-panel"
        >
          <BottomSheet
            snapshot={snapshot}
            agents={sortedAgents}
            selectedAgentHistory={selectedAgentHistory}
            historyCache={historyCache}
            expandedConversationIds={expandedConversationIds}
            selectedAgent={selectedAgent}
            mode={mobileSheetMode}
            fetchHistory={fetchHistory}
            onSelectAgent={onSelectAgent}
            onClearSelectedAgent={onClearSelectedAgent}
            onToggleConversationExpanded={onToggleConversationExpanded}
          />
        </div>
      </div>
    </main>
  );
}
