import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  SpectatorAgentSnapshot,
  SpectatorSnapshot,
} from '../../../worker/src/contracts/spectator-snapshot.js';
import { getWorldDimensions } from './map-viewport.js';
import type { Phase3EnvironmentEffectFlags } from './environment-effects.js';
import type { Phase3MotionEffectFlags } from './motion-effects.js';
import {
  applyMapSelectionFocusCommand,
  applyMapViewportCommand,
  createInitialMapViewState,
  createViewportZoomCommand,
  planMapSelectionFocusCommand,
  type MapSelectionFocusCommand,
  type MapViewportCommand,
  type MapViewportViewState,
  type MapViewportZoomIntent,
} from './selection-focus.js';

export interface MapCanvasHostProps {
  snapshot?: SpectatorSnapshot;
  selectedAgentId?: string;
  selectionRevision?: number;
  overlayOffsetX?: number;
  phase3EffectsEnabled?: boolean;
  phase3EnvironmentEffectFlags?: Partial<Phase3EnvironmentEffectFlags>;
  phase3MotionEffectFlags?: Partial<Phase3MotionEffectFlags>;
  onSelectAgent?: (agentId: string) => void;
}

function canRenderPixiCanvas(): boolean {
  return typeof navigator !== 'undefined' && !/jsdom/i.test(navigator.userAgent);
}

const MapPixiCanvas = lazy(async () => {
  const module = await import('./MapPixiCanvas.js');

  return {
    default: module.MapPixiCanvas,
  };
});

export function MapCanvasHost({
  snapshot,
  selectedAgentId,
  selectionRevision = 0,
  overlayOffsetX = 0,
  phase3EffectsEnabled = false,
  phase3EnvironmentEffectFlags,
  phase3MotionEffectFlags,
  onSelectAgent,
}: MapCanvasHostProps) {
  const viewportBackgroundStyle = snapshot
    ? {
        backgroundColor: snapshot.map_render_theme.background_fill,
      }
    : undefined;
  const selectedAgent = useMemo(
    () => snapshot?.agents.find((agent) => agent.agent_id === selectedAgentId),
    [snapshot?.agents, selectedAgentId],
  );
  const selectedAgentPositionKey = selectedAgent ? `${selectedAgent.agent_id}:${selectedAgent.node_id}` : undefined;
  const mapGeometryKey = snapshot
    ? `${snapshot.map.rows}:${snapshot.map.cols}:${snapshot.map_render_theme.cell_size}`
    : undefined;
  const shouldRenderPixi = snapshot ? canRenderPixiCanvas() : false;
  const snapshotRef = useRef<SpectatorSnapshot | undefined>(snapshot);
  const selectedAgentRef = useRef<SpectatorAgentSnapshot | undefined>(selectedAgent);
  const viewStateRef = useRef<MapViewportViewState | undefined>(
    snapshot ? createInitialMapViewState(snapshot) : undefined,
  );
  const [viewState, setViewState] = useState<MapViewportViewState | undefined>(viewStateRef.current);
  const [lastFocusCommand, setLastFocusCommand] = useState<MapSelectionFocusCommand | undefined>(undefined);
  const [focusRequestCount, setFocusRequestCount] = useState(0);
  const [viewportCommand, setViewportCommand] = useState<MapViewportCommand | undefined>(undefined);
  const zoomTokenRef = useRef(0);

  useEffect(() => {
    snapshotRef.current = snapshot;
    selectedAgentRef.current = selectedAgent;
  }, [selectedAgent, snapshot]);

  useEffect(() => {
    const currentSnapshot = snapshotRef.current;

    if (!currentSnapshot) {
      viewStateRef.current = undefined;
      setViewState(undefined);
      setLastFocusCommand(undefined);
      return;
    }

    const initialView = createInitialMapViewState(currentSnapshot);
    viewStateRef.current = initialView;
    setViewState(initialView);
  }, [mapGeometryKey]);

  useEffect(() => {
    const currentSnapshot = snapshotRef.current;
    const currentSelectedAgent = selectedAgentRef.current;

    if (!currentSnapshot || !currentSelectedAgent) {
      if (!selectedAgentId) {
        setLastFocusCommand(undefined);
      }
      return;
    }

    const currentView = viewStateRef.current ?? createInitialMapViewState(currentSnapshot);
    const nextFocusCommand = planMapSelectionFocusCommand({
      snapshot: currentSnapshot,
      agent: currentSelectedAgent,
      currentView,
      overlayOffsetX,
    });

    if (!nextFocusCommand) {
      return;
    }

    setLastFocusCommand(nextFocusCommand);
    setFocusRequestCount((count) => count + 1);
  }, [mapGeometryKey, selectedAgentId, selectedAgentPositionKey, selectionRevision, overlayOffsetX]);

  const handleViewportLiveViewStateChange = useCallback((nextViewState: MapViewportViewState) => {
    viewStateRef.current = nextViewState;
  }, []);

  const handleViewportViewStateChange = useCallback((nextViewState: MapViewportViewState) => {
    viewStateRef.current = nextViewState;
    setViewState(nextViewState);
  }, []);

  useEffect(() => {
    if (shouldRenderPixi || !lastFocusCommand) {
      return;
    }

    const currentSnapshot = snapshotRef.current;

    if (!currentSnapshot) {
      return;
    }

    const currentView = viewStateRef.current ?? createInitialMapViewState(currentSnapshot);
    handleViewportViewStateChange(applyMapSelectionFocusCommand(currentView, lastFocusCommand));
  }, [handleViewportViewStateChange, lastFocusCommand, shouldRenderPixi]);

  const worldDimensions = snapshot ? getWorldDimensions(snapshot) : undefined;

  const handleZoomIntent = useCallback(
    (intent: MapViewportZoomIntent) => {
      const currentSnapshot = snapshotRef.current;

      if (!currentSnapshot) {
        return;
      }

      const currentView = viewStateRef.current ?? createInitialMapViewState(currentSnapshot);
      const dimensions = getWorldDimensions(currentSnapshot);
      const viewportDimensions =
        typeof window !== 'undefined'
          ? { width: window.innerWidth, height: window.innerHeight }
          : undefined;
      zoomTokenRef.current += 1;
      const command = createViewportZoomCommand({
        intent,
        currentView,
        worldDimensions: dimensions,
        viewportDimensions,
        overlayOffsetX,
        token: zoomTokenRef.current,
      });

      setViewportCommand(command);

      if (!canRenderPixiCanvas()) {
        handleViewportViewStateChange(applyMapViewportCommand(currentView, command));
      }
    },
    [handleViewportViewStateChange, overlayOffsetX],
  );

  return (
    <section
      aria-label="World map"
      className="relative min-h-screen min-w-0 overflow-hidden bg-slate-900"
      data-testid="map-canvas-host"
      style={viewportBackgroundStyle}
    >
      {snapshot && worldDimensions && shouldRenderPixi ? (
        <Suspense
          fallback={
            <div
              className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-400"
              data-testid="map-pixi-loading"
            >
              viewport bridge を読み込んでいます…
            </div>
          }
        >
          <MapPixiCanvas
            focusCommand={lastFocusCommand}
            onLiveViewStateChange={handleViewportLiveViewStateChange}
            onSelectAgent={onSelectAgent}
            onViewStateChange={handleViewportViewStateChange}
            phase3EffectsEnabled={phase3EffectsEnabled}
            phase3EnvironmentEffectFlags={phase3EnvironmentEffectFlags}
            phase3MotionEffectFlags={phase3MotionEffectFlags}
            selectedAgentId={selectedAgentId}
            snapshot={snapshot}
            viewportCommand={viewportCommand}
          />
        </Suspense>
      ) : (
        <div
          className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-400"
          data-testid="map-pixi-fallback"
        >
          ブラウザ runtime では viewport spike を描画します。test 環境では selection bridge の DOM fallback を使います。
        </div>
      )}
      {snapshot ? (
        <div
          className="pointer-events-none absolute bottom-6 right-6 z-10 flex flex-col gap-2"
          data-testid="map-zoom-controls"
        >
          <button
            aria-label="ズームイン"
            className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full border border-slate-700 bg-slate-950/80 text-lg font-semibold text-slate-100 shadow-lg transition hover:bg-slate-800"
            data-testid="map-zoom-in"
            onClick={() => handleZoomIntent('zoom-in')}
            type="button"
          >
            +
          </button>
          <button
            aria-label="初期位置に戻す"
            className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full border border-slate-700 bg-slate-950/80 text-xs font-semibold text-slate-100 shadow-lg transition hover:bg-slate-800"
            data-testid="map-zoom-reset"
            onClick={() => handleZoomIntent('reset')}
            type="button"
          >
            初期
          </button>
          <button
            aria-label="ズームアウト"
            className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full border border-slate-700 bg-slate-950/80 text-lg font-semibold text-slate-100 shadow-lg transition hover:bg-slate-800"
            data-testid="map-zoom-out"
            onClick={() => handleZoomIntent('zoom-out')}
            type="button"
          >
            −
          </button>
        </div>
      ) : null}
    </section>
  );
}
