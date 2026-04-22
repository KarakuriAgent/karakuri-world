import { describe, expect, it } from 'vitest';

import {
  MAP_FOCUS_DURATION_MS,
  MAP_FOCUS_TARGET_ZOOM,
  createViewportZoomCommand,
  getNodeCenter,
  planMapSelectionFocusCommand,
  type MapViewportViewState,
} from '../components/map/selection-focus.js';
import {
  MAP_VIEWPORT_MAX_ZOOM,
  MAP_VIEWPORT_MIN_ZOOM,
  MAP_VIEWPORT_ZOOM_STEP,
  calculateInitialViewportZoom,
  getWorldDimensions,
} from '../components/map/map-viewport.js';
import { createFixtureSnapshot } from './fixtures/snapshot.js';

describe('map selection focus contract', () => {
  it('targets the selected agent node center with a 300ms 1.6x focus animation', () => {
    const snapshot = createFixtureSnapshot();
    const agent = snapshot.agents[0]!;
    const currentView: MapViewportViewState = {
      centerX: 96,
      centerY: 96,
      zoom: 1,
    };
    const nodeCenter = getNodeCenter(snapshot, agent.node_id);

    expect(nodeCenter).toBeDefined();
    if (!nodeCenter) {
      throw new Error('expected fixture node center');
    }

    const command = planMapSelectionFocusCommand({
      snapshot,
      agent,
      currentView,
    });

    expect(command).toMatchObject({
      agent_id: 'alice',
      node_id: '1-2',
      target_center_x: nodeCenter.centerX,
      target_center_y: nodeCenter.centerY,
      duration_ms: MAP_FOCUS_DURATION_MS,
      mode: 'zoom',
      target_zoom: MAP_FOCUS_TARGET_ZOOM,
    });
  });

  it('falls back to pan-only when the viewport is already close enough to the target', () => {
    const snapshot = createFixtureSnapshot();
    const agent = snapshot.agents[0]!;
    const nodeCenter = getNodeCenter(snapshot, agent.node_id);

    expect(nodeCenter).toBeDefined();
    if (!nodeCenter) {
      throw new Error('expected fixture node center');
    }

    const command = planMapSelectionFocusCommand({
      snapshot,
      agent,
      currentView: {
        centerX: nodeCenter.centerX,
        centerY: nodeCenter.centerY,
        zoom: MAP_FOCUS_TARGET_ZOOM,
      },
    });

    expect(command).toBeDefined();
    if (!command) {
      throw new Error('expected focus command');
    }

    expect(command.mode).toBe('pan-only');
    expect(command.target_zoom).toBeUndefined();
    expect(command.duration_ms).toBe(MAP_FOCUS_DURATION_MS);
  });

  it('scales the viewport zoom by MAP_VIEWPORT_ZOOM_STEP on zoom-in/zoom-out intents', () => {
    const snapshot = createFixtureSnapshot();
    const worldDimensions = getWorldDimensions(snapshot);
    const currentView: MapViewportViewState = { centerX: 100, centerY: 100, zoom: 1 };

    const zoomIn = createViewportZoomCommand({
      intent: 'zoom-in',
      currentView,
      worldDimensions,
      token: 1,
    });
    expect(zoomIn.target_zoom).toBeCloseTo(1 * MAP_VIEWPORT_ZOOM_STEP, 5);
    expect(zoomIn.target_center_x).toBe(100);
    expect(zoomIn.target_center_y).toBe(100);

    const zoomOut = createViewportZoomCommand({
      intent: 'zoom-out',
      currentView,
      worldDimensions,
      token: 2,
    });
    expect(zoomOut.target_zoom).toBeCloseTo(1 / MAP_VIEWPORT_ZOOM_STEP, 5);

    const clampedIn = createViewportZoomCommand({
      intent: 'zoom-in',
      currentView: { centerX: 100, centerY: 100, zoom: MAP_VIEWPORT_MAX_ZOOM },
      worldDimensions,
      token: 3,
    });
    expect(clampedIn.target_zoom).toBe(MAP_VIEWPORT_MAX_ZOOM);

    const clampedOut = createViewportZoomCommand({
      intent: 'zoom-out',
      currentView: { centerX: 100, centerY: 100, zoom: MAP_VIEWPORT_MIN_ZOOM },
      worldDimensions,
      token: 4,
    });
    expect(clampedOut.target_zoom).toBe(MAP_VIEWPORT_MIN_ZOOM);
  });

  it('resets the viewport to the initial framing using the supplied viewport size', () => {
    const snapshot = createFixtureSnapshot();
    const worldDimensions = getWorldDimensions(snapshot);
    const resetCommand = createViewportZoomCommand({
      intent: 'reset',
      currentView: { centerX: 0, centerY: 0, zoom: 2.5 },
      worldDimensions,
      viewportDimensions: { width: 1280, height: 720 },
      token: 7,
    });

    const expectedZoom = calculateInitialViewportZoom({
      screenWidth: 1280,
      screenHeight: 720,
      worldWidth: worldDimensions.worldWidth,
      worldHeight: worldDimensions.worldHeight,
    });

    expect(resetCommand.target_zoom).toBe(expectedZoom);
    expect(resetCommand.target_center_x).toBe(worldDimensions.worldWidth / 2);
    expect(resetCommand.target_center_y).toBe(worldDimensions.worldHeight / 2);
  });

  it('offsets the reset center when an overlay covers part of the canvas', () => {
    const snapshot = createFixtureSnapshot();
    const worldDimensions = getWorldDimensions(snapshot);
    const overlayOffsetX = 360;

    const resetCommand = createViewportZoomCommand({
      intent: 'reset',
      currentView: { centerX: 0, centerY: 0, zoom: 2.5 },
      worldDimensions,
      viewportDimensions: { width: 1280, height: 720 },
      overlayOffsetX,
      token: 8,
    });

    expect(resetCommand.target_center_x).toBeGreaterThan(worldDimensions.worldWidth / 2);
  });

  it('returns no focus target for malformed or out-of-grid node ids', () => {
    const snapshot = createFixtureSnapshot();
    const agent = snapshot.agents[0]!;
    const currentView: MapViewportViewState = {
      centerX: 96,
      centerY: 96,
      zoom: 1,
    };

    expect(getNodeCenter(snapshot, 'not-a-node')).toBeUndefined();
    expect(getNodeCenter(snapshot, '9-9')).toBeUndefined();
    expect(
      planMapSelectionFocusCommand({
        snapshot,
        agent: {
          ...agent,
          node_id: 'not-a-node',
        } as unknown as typeof agent,
        currentView,
      }),
    ).toBeUndefined();
    expect(
      planMapSelectionFocusCommand({
        snapshot,
        agent: {
          ...agent,
          node_id: '9-9',
        },
        currentView,
      }),
    ).toBeUndefined();
  });
});
