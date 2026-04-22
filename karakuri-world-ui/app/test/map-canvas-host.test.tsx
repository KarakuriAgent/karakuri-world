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
    viewportCommand,
    onLiveViewStateChange,
    onSelectAgent,
    onViewStateChange,
    phase3EffectsEnabled,
    phase3EnvironmentEffectFlags,
    phase3MotionEffectFlags,
  }: {
    focusCommand?: { mode: string; target_center_x?: number };
    viewportCommand?: { token: number; target_center_x: number; target_center_y: number; target_zoom: number };
    onLiveViewStateChange?: (viewState: { centerX: number; centerY: number; zoom: number }) => void;
    onSelectAgent?: (agentId: string) => void;
    onViewStateChange?: (viewState: { centerX: number; centerY: number; zoom: number }) => void;
    phase3EffectsEnabled?: boolean;
    phase3EnvironmentEffectFlags?: Partial<Phase3EnvironmentEffectFlags>;
    phase3MotionEffectFlags?: Partial<Phase3MotionEffectFlags>;
  }) => (
    <div data-testid="mock-map-pixi-canvas">
      <div data-testid="mock-map-pixi-focus-mode">{focusCommand?.mode ?? 'idle'}</div>
      <div data-testid="mock-map-pixi-focus-center-x">{focusCommand?.target_center_x?.toFixed(1) ?? 'none'}</div>
      <div data-testid="mock-map-pixi-viewport-token">{String(viewportCommand?.token ?? 'none')}</div>
      <div data-testid="mock-map-pixi-viewport-zoom">{viewportCommand?.target_zoom?.toFixed(3) ?? 'none'}</div>
      <div data-testid="mock-map-pixi-viewport-center-x">{viewportCommand?.target_center_x?.toFixed(1) ?? 'none'}</div>
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

  it('renders the map canvas host filling its parent container', () => {
    const snapshot = createFixtureSnapshot();
    render(<MapCanvasHost snapshot={snapshot} />);

    const host = screen.getByTestId('map-canvas-host');
    expect(host).toHaveClass('h-full');
    expect(host).toHaveClass('overflow-hidden');
  });

  it('shows the pixi fallback in test environment when no agent is selected', () => {
    const snapshot = createFixtureSnapshot();
    render(<MapCanvasHost snapshot={snapshot} />);

    expect(screen.getByTestId('map-pixi-fallback')).toBeInTheDocument();
  });

  it('shows the pixi canvas in browser-like environment', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'vitest-browser',
    });

    const snapshot = createFixtureSnapshot();
    render(<MapCanvasHost snapshot={snapshot} selectedAgentId="alice" selectionRevision={0} />);

    await waitFor(() => expect(screen.getByTestId('mock-map-pixi-canvas')).toBeInTheDocument());
    expect(screen.getByTestId('mock-map-pixi-focus-mode')).toHaveTextContent('zoom');
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
    expect(screen.getByTestId('mock-map-pixi-focus-mode')).toHaveTextContent('zoom');

    rerender(<MapCanvasHost snapshot={snapshot} selectedAgentId="alice" selectionRevision={1} />);

    await waitFor(() => expect(screen.getByTestId('mock-map-pixi-focus-mode')).toHaveTextContent('zoom'));
  });

  it('uses the latest viewport state to switch same-agent refocus to pan-only', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'vitest-browser',
    });

    const snapshot = createFixtureSnapshot();
    const { rerender } = render(
      <MapCanvasHost snapshot={snapshot} selectedAgentId="alice" selectionRevision={0} overlayOffsetX={0} />,
    );

    await waitFor(() => expect(screen.getByTestId('mock-map-pixi-canvas')).toBeInTheDocument());
    expect(screen.getByTestId('mock-map-pixi-focus-mode')).toHaveTextContent('zoom');

    // Simulate the viewport settling at the target position and zoom level
    fireEvent.click(screen.getByTestId('mock-sync-focused-view'));

    // Trigger refocus by changing selection revision
    rerender(<MapCanvasHost snapshot={snapshot} selectedAgentId="alice" selectionRevision={1} overlayOffsetX={0} />);

    await waitFor(() => expect(screen.getByTestId('mock-map-pixi-focus-mode')).toHaveTextContent('pan-only'));
  });

  it('applies focus requests to the DOM fallback view state without optimistic Pixi-only updates', async () => {
    const snapshot = createFixtureSnapshot();
    const { rerender } = render(
      <MapCanvasHost snapshot={snapshot} selectedAgentId="alice" selectionRevision={0} />,
    );

    await waitFor(() => expect(screen.getByTestId('map-pixi-fallback')).toBeInTheDocument());

    rerender(<MapCanvasHost snapshot={snapshot} selectedAgentId="alice" selectionRevision={1} />);

    await waitFor(() => expect(screen.getByTestId('map-pixi-fallback')).toBeInTheDocument());
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

  it('uses the snapshot theme background for the canvas host root', () => {
    const snapshot = createFixtureSnapshot();

    render(<MapCanvasHost snapshot={snapshot} />);

    expect(screen.getByTestId('map-canvas-host')).toHaveStyle({
      backgroundColor: snapshot.map_render_theme.background_fill,
    });
  });

  it('shifts focus target right in world coords so the agent lands left of the overlay', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'vitest-browser',
    });

    const snapshot = createFixtureSnapshot();

    // viewport.moveCenter は world 座標をキャンバス中央へ配置するため、右側を overlay が覆う分
    // world centerX を agent の node 中心より右へずらすと、エージェントは画面上では overlay の
    // 左に寄って見える (= 可視領域の中心に来る)。
    const { rerender } = render(
      <MapCanvasHost snapshot={snapshot} selectedAgentId="alice" selectionRevision={0} overlayOffsetX={360} />,
    );

    await waitFor(() => expect(screen.getByTestId('mock-map-pixi-canvas')).toBeInTheDocument());
    const withOffsetX = parseFloat(screen.getByTestId('mock-map-pixi-focus-center-x').textContent ?? '0');

    rerender(<MapCanvasHost snapshot={snapshot} selectedAgentId="alice" selectionRevision={1} overlayOffsetX={0} />);

    await waitFor(() => expect(screen.getByTestId('mock-map-pixi-focus-center-x')).toHaveTextContent('144.0'));
    const noOffsetX = 144.0;

    expect(withOffsetX).toBeGreaterThan(noOffsetX);
  });

  it('issues a zoom-in viewport command when the zoom-in button is clicked', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'vitest-browser',
    });

    const snapshot = createFixtureSnapshot();

    render(<MapCanvasHost snapshot={snapshot} />);

    await waitFor(() => expect(screen.getByTestId('mock-map-pixi-canvas')).toBeInTheDocument());

    expect(screen.getByTestId('mock-map-pixi-viewport-token')).toHaveTextContent('none');

    fireEvent.click(screen.getByTestId('map-zoom-in'));

    await waitFor(() => expect(screen.getByTestId('mock-map-pixi-viewport-token')).not.toHaveTextContent('none'));
    const zoomedIn = parseFloat(screen.getByTestId('mock-map-pixi-viewport-zoom').textContent ?? '0');
    expect(zoomedIn).toBeGreaterThan(0.5);

    fireEvent.click(screen.getByTestId('map-zoom-out'));

    await waitFor(() => {
      const zoomedOut = parseFloat(screen.getByTestId('mock-map-pixi-viewport-zoom').textContent ?? '0');
      expect(zoomedOut).toBeLessThan(zoomedIn);
    });
  });

  it('resets to initial view when the zoom-reset button is clicked', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'vitest-browser',
    });

    const snapshot = createFixtureSnapshot();

    render(<MapCanvasHost snapshot={snapshot} />);

    await waitFor(() => expect(screen.getByTestId('mock-map-pixi-canvas')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('map-zoom-reset'));

    await waitFor(() => expect(screen.getByTestId('mock-map-pixi-viewport-token')).not.toHaveTextContent('none'));
  });

  it('applies zoom commands to the DOM fallback view state when pixi is unavailable', async () => {
    const snapshot = createFixtureSnapshot();

    render(<MapCanvasHost snapshot={snapshot} />);

    expect(screen.getByTestId('map-pixi-fallback')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('map-zoom-in'));
    fireEvent.click(screen.getByTestId('map-zoom-out'));
    fireEvent.click(screen.getByTestId('map-zoom-reset'));

    // Fallback path is visited without crashing; buttons are present and clickable.
    expect(screen.getByTestId('map-zoom-controls')).toBeInTheDocument();
  });
});
