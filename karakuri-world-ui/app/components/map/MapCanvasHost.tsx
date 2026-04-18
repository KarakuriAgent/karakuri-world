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
  createInitialMapViewState,
  planMapSelectionFocusCommand,
  type MapSelectionFocusCommand,
  type MapViewportViewState,
} from './selection-focus.js';

export interface MapCanvasHostProps {
  snapshot?: SpectatorSnapshot;
  selectedAgentId?: string;
  selectionRevision?: number;
  phase3EffectsEnabled?: boolean;
  phase3EnvironmentEffectFlags?: Partial<Phase3EnvironmentEffectFlags>;
  phase3MotionEffectFlags?: Partial<Phase3MotionEffectFlags>;
  onSelectAgent?: (agentId: string) => void;
}

function canRenderPixiCanvas(): boolean {
  return typeof navigator !== 'undefined' && !/jsdom/i.test(navigator.userAgent);
}

function getSelectionDescription(selectedAgent: SpectatorAgentSnapshot | undefined): string {
  return selectedAgent ? `${selectedAgent.agent_name} @ ${selectedAgent.node_id}` : '未選択';
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
    });

    if (!nextFocusCommand) {
      return;
    }

    setLastFocusCommand(nextFocusCommand);
    setFocusRequestCount((count) => count + 1);
  }, [mapGeometryKey, selectedAgentId, selectedAgentPositionKey, selectionRevision]);

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

  return (
    <section
      aria-label="World map"
      className="relative min-h-screen min-w-0 overflow-hidden bg-slate-900"
      data-testid="map-canvas-host"
      style={viewportBackgroundStyle}
    >
      <div className="absolute inset-4 rounded-[32px] border border-cyan-500/30 bg-slate-950/60 shadow-[0_0_0_1px_rgba(34,211,238,0.12)] backdrop-blur-sm lg:inset-6">
        <div className="flex h-full flex-col gap-6 p-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-300">Map viewport bridge</p>
            <h2 className="mt-2 text-3xl font-semibold text-white">Selection-driven overlay contract</h2>
            <p className="mt-3 max-w-2xl text-sm text-slate-300">
              pixi-viewport の bridge を先に固定し、selection / overlay / map focus が同じ contract を共有します。
            </p>
          </div>

          <dl className="grid gap-3 text-sm text-slate-300 sm:grid-cols-2 xl:grid-cols-5">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
              <dt className="text-xs uppercase tracking-wide text-slate-500">World</dt>
              <dd className="mt-2 text-base text-white">{snapshot?.world.name ?? 'Karakuri World'}</dd>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
              <dt className="text-xs uppercase tracking-wide text-slate-500">Grid</dt>
              <dd className="mt-2 text-base text-white">
                {snapshot ? `${snapshot.map.rows} × ${snapshot.map.cols}` : 'snapshot待ち'}
              </dd>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
              <dt className="text-xs uppercase tracking-wide text-slate-500">Agents</dt>
              <dd className="mt-2 text-base text-white">{snapshot?.agents.length ?? 0}</dd>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
              <dt className="text-xs uppercase tracking-wide text-slate-500">Selection</dt>
              <dd className="mt-2 text-base text-white" data-testid="map-selection-summary">
                {getSelectionDescription(selectedAgent)}
              </dd>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
              <dt className="text-xs uppercase tracking-wide text-slate-500">Focus requests</dt>
              <dd className="mt-2 text-base text-white" data-testid="map-focus-request-count">
                {focusRequestCount}
              </dd>
            </div>
          </dl>

          <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
            <section className="min-h-0 rounded-[28px] border border-slate-800 bg-slate-950/80 p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-white">Viewport smoke</h3>
                  <p className="mt-1 text-sm text-slate-400">
                    wheel / drag / pinch / tap を同居させる最小 host。4px 未満の微小 drag は tap を優先します。
                  </p>
                </div>
                <span className="rounded-full border border-cyan-400/40 bg-cyan-400/10 px-3 py-1 text-xs font-medium text-cyan-200">
                  zoom 0.5x–3.0x / 24px frame
                </span>
              </div>

              <div
                className="mt-4 h-[360px] overflow-hidden rounded-[24px] border border-slate-800"
                data-testid="map-viewport-root"
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
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2" data-testid="map-agent-button-list">
                {snapshot?.agents.length ? (
                  snapshot.agents.map((agent) => (
                    <button
                      key={agent.agent_id}
                      type="button"
                      className={`rounded-2xl border p-4 text-left transition-colors ${
                        selectedAgentId === agent.agent_id
                          ? 'border-cyan-400/70 bg-cyan-400/10 shadow-[0_0_0_1px_rgba(34,211,238,0.2)]'
                          : 'border-slate-800 bg-slate-900/80 hover:border-slate-700 hover:bg-slate-900'
                      }`}
                      data-testid={`map-agent-button-${agent.agent_id}`}
                      aria-pressed={selectedAgentId === agent.agent_id}
                      onClick={() => onSelectAgent?.(agent.agent_id)}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-medium text-slate-100">{agent.agent_name}</p>
                          <p className="mt-1 text-xs text-slate-400">{agent.node_id}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-lg leading-none">{agent.status_emoji}</p>
                          <p className="mt-1 text-xs uppercase tracking-wide text-slate-400">{agent.state}</p>
                        </div>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-700 p-4 text-sm text-slate-400 sm:col-span-2">
                    エージェントが接続すると map selection target がここに表示されます
                  </div>
                )}
              </div>
            </section>

            <section
              className="rounded-[28px] border border-slate-800 bg-slate-950/80 p-5 text-sm text-slate-300"
              data-testid="map-focus-contract"
            >
              <h3 className="text-sm font-semibold text-white">Focus contract</h3>
              <p className="mt-1 text-sm text-slate-400">
                selection に追従して node 中心へ 300ms で移動し、通常時は 1.6x へ寄せます。
              </p>

              <dl className="mt-4 space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-slate-500">Mode</dt>
                  <dd className="text-white" data-testid="map-focus-mode">
                    {lastFocusCommand ? lastFocusCommand.mode : 'idle'}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-slate-500">Duration</dt>
                  <dd className="text-white" data-testid="map-focus-duration">
                    {lastFocusCommand ? `${lastFocusCommand.duration_ms}ms` : '—'}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-slate-500">Zoom</dt>
                  <dd className="text-white" data-testid="map-focus-zoom">
                    {lastFocusCommand?.target_zoom ? `${lastFocusCommand.target_zoom.toFixed(1)}x` : 'keep'}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-slate-500">Node</dt>
                  <dd className="text-white" data-testid="map-focus-node">
                    {lastFocusCommand?.node_id ?? '—'}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-slate-500">Center</dt>
                  <dd className="text-white" data-testid="map-focus-center">
                    {lastFocusCommand
                      ? `${lastFocusCommand.target_center_x.toFixed(0)}, ${lastFocusCommand.target_center_y.toFixed(0)}`
                      : '—'}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-slate-500">Viewport</dt>
                  <dd className="text-white" data-testid="map-view-state">
                    {viewState
                      ? `${viewState.centerX.toFixed(0)}, ${viewState.centerY.toFixed(0)} @ ${viewState.zoom.toFixed(2)}x`
                      : '—'}
                  </dd>
                </div>
              </dl>
            </section>
          </div>
        </div>
      </div>
    </section>
  );
}
