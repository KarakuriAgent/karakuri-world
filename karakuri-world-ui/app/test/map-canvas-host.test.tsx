// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFixtureSnapshot } from './fixtures/snapshot.js';
import { MapCanvasHost } from '../components/map/MapCanvasHost.js';
import type { Phase3EnvironmentEffectFlags } from '../components/map/environment-effects.js';
import type { Phase3MotionEffectFlags } from '../components/map/motion-effects.js';

vi.mock('../components/map/MapPixiCanvas.js', () => ({
  MapPixiCanvas: ({
    focusCommand,
    onLiveViewStateChange,
    onSelectAgent,
    onViewStateChange,
    phase3EffectsEnabled,
    phase3EnvironmentEffectFlags,
    phase3MotionEffectFlags,
  }: {
    focusCommand?: { mode: string };
    onLiveViewStateChange?: (viewState: { centerX: number; centerY: number; zoom: number }) => void;
    onSelectAgent?: (agentId: string) => void;
    onViewStateChange?: (viewState: { centerX: number; centerY: number; zoom: number }) => void;
    phase3EffectsEnabled?: boolean;
    phase3EnvironmentEffectFlags?: Partial<Phase3EnvironmentEffectFlags>;
    phase3MotionEffectFlags?: Partial<Phase3MotionEffectFlags>;
  }) => (
    <div data-testid="mock-map-pixi-canvas">
      <div data-testid="mock-map-pixi-focus-mode">{focusCommand?.mode ?? 'idle'}</div>
      <div data-testid="mock-map-pixi-phase3-effects">{String(phase3EffectsEnabled ?? false)}</div>
      <div data-testid="mock-map-pixi-phase3-effect-flags">{JSON.stringify(phase3EnvironmentEffectFlags ?? {})}</div>
      <div data-testid="mock-map-pixi-phase3-motion-flags">{JSON.stringify(phase3MotionEffectFlags ?? {})}</div>
      <button
        type="button"
        data-testid="mock-sync-live-view"
        onClick={() =>
          onLiveViewStateChange?.({
            centerX: 132,
            centerY: 60,
            zoom: 1.2,
          })
        }
      >
        sync live view
      </button>
      <button
        type="button"
        data-testid="mock-sync-focused-view"
        onClick={() =>
          onViewStateChange?.({
            centerX: 144,
            centerY: 48,
            zoom: 1.6,
          })
        }
      >
        sync focused view
      </button>
      <button
        type="button"
        data-testid="mock-select-bob"
        onClick={() => onSelectAgent?.('bob')}
      >
        select bob
      </button>
    </div>
  ),
}));

describe('MapCanvasHost viewport synchronization', () => {
  const originalUserAgent = navigator.userAgent;

  afterEach(() => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: originalUserAgent,
    });
  });

  it('keeps same-agent rapid reselection in zoom mode until the viewport actually settles', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'vitest-browser',
    });

    const snapshot = createFixtureSnapshot();
    const { rerender } = render(
      <MapCanvasHost snapshot={snapshot} selectedAgentId="alice" selectionRevision={0} />,
    );

    await waitFor(() => expect(screen.getByTestId('mock-map-pixi-canvas')).toBeInTheDocument());
    expect(screen.getByTestId('map-focus-mode')).toHaveTextContent('zoom');
    expect(screen.getByTestId('map-focus-request-count')).toHaveTextContent('1');

    rerender(<MapCanvasHost snapshot={snapshot} selectedAgentId="alice" selectionRevision={1} />);

    await waitFor(() => expect(screen.getByTestId('mock-map-pixi-focus-mode')).toHaveTextContent('zoom'));
    expect(screen.getByTestId('map-focus-mode')).toHaveTextContent('zoom');
    expect(screen.getByTestId('map-focus-request-count')).toHaveTextContent('2');
  });

  it('uses the latest viewport state to switch same-agent refocus to pan-only', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'vitest-browser',
    });

    const snapshot = createFixtureSnapshot();
    const { rerender } = render(
      <MapCanvasHost snapshot={snapshot} selectedAgentId="alice" selectionRevision={0} />,
    );

    await waitFor(() => expect(screen.getByTestId('mock-map-pixi-canvas')).toBeInTheDocument());
    expect(screen.getByTestId('map-focus-mode')).toHaveTextContent('zoom');
    expect(screen.getByTestId('map-focus-request-count')).toHaveTextContent('1');

    fireEvent.click(screen.getByTestId('mock-sync-live-view'));
    expect(screen.getByTestId('map-view-state')).not.toHaveTextContent('132, 60 @ 1.20x');
    fireEvent.click(screen.getByTestId('mock-sync-focused-view'));

    await waitFor(() => expect(screen.getByTestId('map-view-state')).toHaveTextContent('144, 48 @ 1.60x'));

    rerender(<MapCanvasHost snapshot={snapshot} selectedAgentId="alice" selectionRevision={1} />);

    await waitFor(() => expect(screen.getByTestId('mock-map-pixi-focus-mode')).toHaveTextContent('pan-only'));
    expect(screen.getByTestId('map-focus-mode')).toHaveTextContent('pan-only');
    expect(screen.getByTestId('map-focus-zoom')).toHaveTextContent('keep');
    expect(screen.getByTestId('map-focus-request-count')).toHaveTextContent('2');
  });

  it('applies focus requests to the DOM fallback view state without optimistic Pixi-only updates', async () => {
    const snapshot = createFixtureSnapshot();
    const { rerender } = render(
      <MapCanvasHost snapshot={snapshot} selectedAgentId="alice" selectionRevision={0} />,
    );

    await waitFor(() => expect(screen.getByTestId('map-pixi-fallback')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('map-view-state')).toHaveTextContent('144, 48 @ 1.60x'));
    expect(screen.getByTestId('map-focus-mode')).toHaveTextContent('zoom');
    expect(screen.getByTestId('map-focus-request-count')).toHaveTextContent('1');

    rerender(<MapCanvasHost snapshot={snapshot} selectedAgentId="alice" selectionRevision={1} />);

    await waitFor(() => expect(screen.getByTestId('map-focus-mode')).toHaveTextContent('pan-only'));
    expect(screen.getByTestId('map-focus-zoom')).toHaveTextContent('keep');
    expect(screen.getByTestId('map-view-state')).toHaveTextContent('144, 48 @ 1.60x');
    expect(screen.getByTestId('map-focus-request-count')).toHaveTextContent('2');
  });

  it('forwards map-origin selection callbacks so the shared store can stay synchronized', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'vitest-browser',
    });

    const handleSelectAgent = vi.fn();

    render(<MapCanvasHost onSelectAgent={handleSelectAgent} snapshot={createFixtureSnapshot()} />);

    await waitFor(() => expect(screen.getByTestId('mock-map-pixi-canvas')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('mock-select-bob'));

    expect(handleSelectAgent).toHaveBeenCalledWith('bob');
  });

  it('forwards the phase3 effect feature flag to the pixi map canvas', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'vitest-browser',
    });

    render(<MapCanvasHost phase3EffectsEnabled snapshot={createFixtureSnapshot()} />);

    await waitFor(() => expect(screen.getByTestId('mock-map-pixi-canvas')).toBeInTheDocument());

    expect(screen.getByTestId('mock-map-pixi-phase3-effects')).toHaveTextContent('true');
  });

  it('forwards staged per-effect rollout flags to the pixi map canvas', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'vitest-browser',
    });

    render(
      <MapCanvasHost
        phase3EffectsEnabled
        phase3EnvironmentEffectFlags={{ rain: true, fog: true, snow: false, dayNight: true }}
        snapshot={createFixtureSnapshot()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('mock-map-pixi-canvas')).toBeInTheDocument());

    expect(screen.getByTestId('mock-map-pixi-phase3-effect-flags')).toHaveTextContent(
      JSON.stringify({
        rain: true,
        fog: true,
        snow: false,
        dayNight: true,
      }),
    );
  });

  it('forwards staged motion rollout flags to the pixi map canvas', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'vitest-browser',
    });

    render(
      <MapCanvasHost
        phase3EffectsEnabled
        phase3MotionEffectFlags={{ motion: true, actionParticles: true }}
        snapshot={createFixtureSnapshot()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('mock-map-pixi-canvas')).toBeInTheDocument());

    expect(screen.getByTestId('mock-map-pixi-phase3-motion-flags')).toHaveTextContent(
      JSON.stringify({
        motion: true,
        actionParticles: true,
      }),
    );
  });

  it('uses the snapshot theme background for the visible viewport root', () => {
    const snapshot = createFixtureSnapshot();

    render(<MapCanvasHost snapshot={snapshot} />);

    expect(screen.getByTestId('map-canvas-host')).toHaveStyle({
      backgroundColor: snapshot.map_render_theme.background_fill,
    });
    expect(screen.getByTestId('map-viewport-root')).toHaveStyle({
      backgroundColor: snapshot.map_render_theme.background_fill,
    });
  });
});
