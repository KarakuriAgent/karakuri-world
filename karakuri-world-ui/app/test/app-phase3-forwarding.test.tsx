// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../App.js';
import { createSnapshotStore } from '../store/snapshot-store.js';
import { createFixtureSnapshot } from './fixtures/snapshot.js';

const mapCanvasHostPropsSpy = vi.fn();

vi.mock('../components/map/MapCanvasHost.js', () => ({
  MapCanvasHost: (props: {
    phase3EffectsEnabled?: boolean;
    phase3EnvironmentEffectFlags?: Record<string, boolean>;
    phase3MotionEffectFlags?: Record<string, boolean>;
  }) => {
    mapCanvasHostPropsSpy(props);

    return (
      <div data-testid="mock-map-canvas-host">
        <div data-testid="mock-map-canvas-host-phase3-enabled">{String(props.phase3EffectsEnabled ?? false)}</div>
        <div data-testid="mock-map-canvas-host-phase3-flags">
          {JSON.stringify(props.phase3EnvironmentEffectFlags ?? {})}
        </div>
        <div data-testid="mock-map-canvas-host-phase3-motion-flags">
          {JSON.stringify(props.phase3MotionEffectFlags ?? {})}
        </div>
      </div>
    );
  },
}));

function createReadyStore() {
  return createSnapshotStore({
    snapshotUrl: 'https://snapshot.example.com/snapshot/manifest.json',
    authMode: 'public',
    historyApiUrl: 'https://relay.example.com/api/history',
    initialSnapshot: createFixtureSnapshot(),
    initialSelectedAgentId: 'alice',
  });
}

describe('App Phase 3 effect forwarding', () => {
  it('forwards env rollout props through AppShell into the map host', () => {
    const phase3EnvironmentEffects = {
      rain: true,
      snow: false,
      fog: true,
      dayNight: true,
    } as const;
    const phase3MotionEffects = {
      motion: true,
      actionParticles: true,
    } as const;

    render(
      <App
        env={{
          snapshotUrl: 'https://snapshot.example.com/snapshot/manifest.json',
          authMode: 'public',
          apiBaseUrl: 'https://relay.example.com/api/history',
          phase3EffectsEnabled: true,
          phase3EnvironmentEffects,
          phase3MotionEffects,
        }}
        store={createReadyStore()}
        autoStartPolling={false}
      />,
    );

    expect(screen.getByTestId('mock-map-canvas-host-phase3-enabled')).toHaveTextContent('true');
    expect(screen.getByTestId('mock-map-canvas-host-phase3-flags')).toHaveTextContent(
      JSON.stringify(phase3EnvironmentEffects),
    );
    expect(screen.getByTestId('mock-map-canvas-host-phase3-motion-flags')).toHaveTextContent(
      JSON.stringify(phase3MotionEffects),
    );

    expect(mapCanvasHostPropsSpy).toHaveBeenCalled();
    expect(mapCanvasHostPropsSpy.mock.lastCall?.[0]).toEqual(
      expect.objectContaining({
        phase3EffectsEnabled: true,
        phase3EnvironmentEffectFlags: phase3EnvironmentEffects,
        phase3MotionEffectFlags: phase3MotionEffects,
      }),
    );
  });
});
