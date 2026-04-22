import type { SpectatorSnapshot } from '../../../worker/src/contracts/spectator-snapshot.js';
import type { MapSelectionFocusCommand, MapViewportViewState } from './selection-focus.js';

export const MAP_VIEWPORT_MIN_ZOOM = 0.5;
export const MAP_VIEWPORT_MAX_ZOOM = 3.0;
export const MAP_VIEWPORT_ZOOM_STEP = 1.25;
export const MAP_VIEWPORT_DRAG_THRESHOLD_PX = 4;
const MAP_VIEWPORT_FOCUS_EASING = 'easeInOutSine';

export interface WorldDimensions {
  worldWidth: number;
  worldHeight: number;
}

export interface MapViewportMetrics extends WorldDimensions {
  screenWidth: number;
  screenHeight: number;
  minZoom?: number;
  maxZoom?: number;
}

type ViewportFrameTarget = {
  fitWorld(center?: boolean): unknown;
  moveCenter(x: number, y: number): unknown;
  setZoom(scale: number, center?: boolean): unknown;
};
type ViewportAnimationTarget = {
  animate(options: {
    position: { x: number; y: number };
    scale?: number;
    time: number;
    ease: string;
    removeOnInterrupt: boolean;
  }): unknown;
};
type ViewportViewStateSource = {
  center: { x: number; y: number };
  scaled: number;
};

export function clampMapViewportZoom(
  zoom: number,
  minZoom = MAP_VIEWPORT_MIN_ZOOM,
  maxZoom = MAP_VIEWPORT_MAX_ZOOM,
): number {
  return Math.min(Math.max(zoom, minZoom), maxZoom);
}

export function getWorldDimensions(snapshot: SpectatorSnapshot): WorldDimensions {
  return {
    worldWidth: snapshot.map.cols * snapshot.map_render_theme.cell_size,
    worldHeight: snapshot.map.rows * snapshot.map_render_theme.cell_size,
  };
}

export function calculateInitialViewportZoom({
  screenWidth,
  screenHeight,
  worldWidth,
  worldHeight,
  minZoom = MAP_VIEWPORT_MIN_ZOOM,
  maxZoom = MAP_VIEWPORT_MAX_ZOOM,
}: MapViewportMetrics): number {
  const usableWidth = Math.max(screenWidth, 1);
  const usableHeight = Math.max(screenHeight, 1);
  const horizontalZoom = usableWidth / Math.max(worldWidth, 1);
  const verticalZoom = usableHeight / Math.max(worldHeight, 1);

  return clampMapViewportZoom(Math.max(horizontalZoom, verticalZoom), minZoom, maxZoom);
}

export function applyInitialViewportFrame(
  viewport: ViewportFrameTarget,
  metrics: MapViewportMetrics,
): MapViewportViewState {
  const { worldWidth, worldHeight } = metrics;
  const zoom = calculateInitialViewportZoom(metrics);

  viewport.fitWorld(true);
  viewport.setZoom(zoom, true);
  viewport.moveCenter(worldWidth / 2, worldHeight / 2);

  return {
    centerX: worldWidth / 2,
    centerY: worldHeight / 2,
    zoom,
  };
}

export function createViewportViewState(viewport: ViewportViewStateSource): MapViewportViewState {
  return {
    centerX: viewport.center.x,
    centerY: viewport.center.y,
    zoom: viewport.scaled,
  };
}

export function animateViewportToSelection(
  viewport: ViewportAnimationTarget,
  command: MapSelectionFocusCommand,
): void {
  viewport.animate({
    position: {
      x: command.target_center_x,
      y: command.target_center_y,
    },
    ...(command.target_zoom ? { scale: command.target_zoom } : {}),
    time: command.duration_ms,
    ease: MAP_VIEWPORT_FOCUS_EASING,
    removeOnInterrupt: true,
  });
}
