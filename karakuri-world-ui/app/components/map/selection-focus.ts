import type { SpectatorAgentSnapshot, SpectatorSnapshot } from '../../../worker/src/contracts/spectator-snapshot.js';
import {
  MAP_VIEWPORT_MARGIN_PX,
  MAP_VIEWPORT_MAX_ZOOM,
  MAP_VIEWPORT_MIN_ZOOM,
  clampMapViewportZoom,
  getWorldDimensions,
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
  const horizontalZoom = (viewport.width - MAP_VIEWPORT_MARGIN_PX * 2) / worldWidth;
  const verticalZoom = (viewport.height - MAP_VIEWPORT_MARGIN_PX * 2) / worldHeight;

  return {
    centerX: worldWidth / 2,
    centerY: worldHeight / 2,
    zoom: clampMapViewportZoom(
      Math.min(horizontalZoom, verticalZoom),
      MAP_VIEWPORT_MIN_ZOOM,
      MAP_VIEWPORT_MAX_ZOOM,
    ),
  };
}

export function planMapSelectionFocusCommand({
  snapshot,
  agent,
  currentView,
}: {
  snapshot: SpectatorSnapshot;
  agent: SpectatorAgentSnapshot;
  currentView: MapViewportViewState;
}): MapSelectionFocusCommand | undefined {
  const nodeCenter = getNodeCenter(snapshot, agent.node_id);

  if (!nodeCenter) {
    return undefined;
  }

  const { centerX, centerY } = nodeCenter;
  const distance = Math.hypot(currentView.centerX - centerX, currentView.centerY - centerY);
  const cellSize = snapshot.map_render_theme.cell_size;
  const isPanOnly =
    distance <= cellSize * PAN_ONLY_DISTANCE_RATIO &&
    Math.abs(currentView.zoom - MAP_FOCUS_TARGET_ZOOM) <= PAN_ONLY_ZOOM_EPSILON;

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
