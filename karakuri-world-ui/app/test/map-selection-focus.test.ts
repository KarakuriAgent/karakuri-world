import { describe, expect, it } from 'vitest';

import {
  MAP_FOCUS_DURATION_MS,
  MAP_FOCUS_TARGET_ZOOM,
  getNodeCenter,
  planMapSelectionFocusCommand,
  type MapViewportViewState,
} from '../components/map/selection-focus.js';
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
