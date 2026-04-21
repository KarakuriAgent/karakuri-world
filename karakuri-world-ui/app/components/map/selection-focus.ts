import type { SpectatorAgentSnapshot, SpectatorSnapshot } from '../../../worker/src/contracts/spectator-snapshot.js';
import {
  calculateInitialViewportZoom,
  clampMapViewportZoom,
  getWorldDimensions,
  MAP_VIEWPORT_ZOOM_STEP,
  type WorldDimensions,
} from './map-viewport.js';
import { getNodeCenter } from './map-render-model.js';

export { getNodeCenter } from './map-render-model.js';

export interface MapViewportViewState {
  centerX: number;
  centerY: number;
  zoom: number;
}

export interface MapSelectionFocusCommand {
  agent_id: string;
  node_id: string;
  target_center_x: number;
  target_center_y: number;
  duration_ms: number;
  mode: 'zoom' | 'pan-only';
  target_zoom?: number;
}

export const MAP_FOCUS_DURATION_MS = 300;
export const MAP_FOCUS_TARGET_ZOOM = 1.6;
const PAN_ONLY_DISTANCE_RATIO = 0.25;
const PAN_ONLY_ZOOM_EPSILON = 0.05;
const DEFAULT_VIEWPORT_WIDTH = 1280;
const DEFAULT_VIEWPORT_HEIGHT = 720;

export function createInitialMapViewState(
  snapshot: SpectatorSnapshot,
  viewport = {
    width: DEFAULT_VIEWPORT_WIDTH,
    height: DEFAULT_VIEWPORT_HEIGHT,
  },
): MapViewportViewState {
  const { worldWidth, worldHeight } = getWorldDimensions(snapshot);

  return {
    centerX: worldWidth / 2,
    centerY: worldHeight / 2,
    zoom: calculateInitialViewportZoom({
      screenWidth: viewport.width,
      screenHeight: viewport.height,
      worldWidth,
      worldHeight,
    }),
  };
}

export function planMapSelectionFocusCommand({
  snapshot,
  agent,
  currentView,
  overlayOffsetX = 0,
}: {
  snapshot: SpectatorSnapshot;
  agent: SpectatorAgentSnapshot;
  currentView: MapViewportViewState;
  overlayOffsetX?: number;
}): MapSelectionFocusCommand | undefined {
  const nodeCenter = getNodeCenter(snapshot, agent.node_id);

  if (!nodeCenter) {
    return undefined;
  }

  const distance = Math.hypot(
    currentView.centerX - nodeCenter.centerX,
    currentView.centerY - nodeCenter.centerY,
  );
  const cellSize = snapshot.map_render_theme.cell_size;
  const isPanOnly =
    distance <= cellSize * PAN_ONLY_DISTANCE_RATIO &&
    Math.abs(currentView.zoom - MAP_FOCUS_TARGET_ZOOM) <= PAN_ONLY_ZOOM_EPSILON;

  const effectiveZoom = isPanOnly ? currentView.zoom : MAP_FOCUS_TARGET_ZOOM;
  let centerX = nodeCenter.centerX;
  const centerY = nodeCenter.centerY;

  // viewport.moveCenter は world 座標をキャンバス中央に配置する。
  // 右側を overlayOffsetX 幅の UI が覆う場合、エージェントを可視領域
  // (幅 = キャンバス幅 - overlayOffsetX) の中央に表示したい。
  // → centerX を agent.x より overlayOffsetX/(2*zoom) だけ右にずらす。
  if (overlayOffsetX > 0 && effectiveZoom > 0) {
    centerX += overlayOffsetX / 2 / effectiveZoom;
  }

  return {
    agent_id: agent.agent_id,
    node_id: agent.node_id,
    target_center_x: centerX,
    target_center_y: centerY,
    duration_ms: MAP_FOCUS_DURATION_MS,
    mode: isPanOnly ? 'pan-only' : 'zoom',
    ...(isPanOnly ? {} : { target_zoom: MAP_FOCUS_TARGET_ZOOM }),
  };
}

export function applyMapSelectionFocusCommand(
  currentView: MapViewportViewState,
  command: MapSelectionFocusCommand,
): MapViewportViewState {
  return {
    centerX: command.target_center_x,
    centerY: command.target_center_y,
    zoom: command.target_zoom ?? currentView.zoom,
  };
}

export type MapViewportZoomIntent = 'zoom-in' | 'zoom-out' | 'reset';

export interface MapViewportCommand {
  token: number;
  target_center_x: number;
  target_center_y: number;
  target_zoom: number;
  duration_ms: number;
}

export interface CreateViewportZoomCommandInput {
  intent: MapViewportZoomIntent;
  currentView: MapViewportViewState;
  worldDimensions: WorldDimensions;
  viewportDimensions?: { width: number; height: number };
  overlayOffsetX?: number;
  token: number;
  duration_ms?: number;
}

export function createViewportZoomCommand({
  intent,
  currentView,
  worldDimensions,
  viewportDimensions,
  overlayOffsetX = 0,
  token,
  duration_ms = MAP_FOCUS_DURATION_MS,
}: CreateViewportZoomCommandInput): MapViewportCommand {
  if (intent === 'reset') {
    const resetZoom = calculateInitialViewportZoom({
      screenWidth: viewportDimensions?.width ?? DEFAULT_VIEWPORT_WIDTH,
      screenHeight: viewportDimensions?.height ?? DEFAULT_VIEWPORT_HEIGHT,
      worldWidth: worldDimensions.worldWidth,
      worldHeight: worldDimensions.worldHeight,
    });
    let centerX = worldDimensions.worldWidth / 2;
    if (overlayOffsetX > 0 && resetZoom > 0) {
      centerX += overlayOffsetX / 2 / resetZoom;
    }

    return {
      token,
      target_center_x: centerX,
      target_center_y: worldDimensions.worldHeight / 2,
      target_zoom: resetZoom,
      duration_ms,
    };
  }

  const factor = intent === 'zoom-in' ? MAP_VIEWPORT_ZOOM_STEP : 1 / MAP_VIEWPORT_ZOOM_STEP;
  const targetZoom = clampMapViewportZoom(currentView.zoom * factor);

  let centerX = currentView.centerX;
  if (overlayOffsetX > 0 && targetZoom > 0 && currentView.zoom > 0) {
    const currentVisualCenterX = currentView.centerX - overlayOffsetX / 2 / currentView.zoom;
    centerX = currentVisualCenterX + overlayOffsetX / 2 / targetZoom;
  }

  return {
    token,
    target_center_x: centerX,
    target_center_y: currentView.centerY,
    target_zoom: targetZoom,
    duration_ms,
  };
}

export function applyMapViewportCommand(
  currentView: MapViewportViewState,
  command: MapViewportCommand,
): MapViewportViewState {
  return {
    centerX: command.target_center_x,
    centerY: command.target_center_y,
    zoom: command.target_zoom,
  };
}
