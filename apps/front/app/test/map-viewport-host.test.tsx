// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useRef } from 'react';

import {
  MAP_VIEWPORT_DRAG_THRESHOLD_PX,
  MAP_VIEWPORT_MAX_ZOOM,
  MAP_VIEWPORT_MIN_ZOOM,
  calculateInitialViewportZoom,
} from '../components/map/map-viewport.js';
import { MapViewportHost } from '../components/map/MapViewportHost.js';

const { PixiViewportElementMock, useApplicationMock, viewportInstances, ViewportMock } = vi.hoisted(() => {
  const instances: any[] = [];
  const mockViewport = vi.fn((options: any) => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const viewport = {
      center: { x: 0, y: 0 },
      scaled: 1,
      parent: undefined as unknown,
      options,
      animate: vi.fn(),
      clampZoom: vi.fn(),
      decelerate: vi.fn(),
      destroy: vi.fn(),
      drag: vi.fn(),
      fitWorld: vi.fn(),
      moveCenter: vi.fn(),
      pinch: vi.fn(),
      resize: vi.fn(),
      setZoom: vi.fn(),
      wheel: vi.fn(),
      on: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
        const eventListeners = listeners.get(eventName) ?? new Set();
        eventListeners.add(listener);
        listeners.set(eventName, eventListeners);
        return viewport;
      }),
      off: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
        listeners.get(eventName)?.delete(listener);
        return viewport;
      }),
      emit(eventName: string, ...args: unknown[]) {
        for (const listener of listeners.get(eventName) ?? []) {
          listener(...args);
        }
      },
    };

    viewport.animate.mockImplementation(({ position, scale }: { position: { x: number; y: number }; scale?: number }) => {
      viewport.center = { ...position };
      if (typeof scale === 'number') {
        viewport.scaled = scale;
        viewport.emit('zoomed', { viewport, type: 'animate' });
      }
      viewport.emit('moved', { viewport, type: 'animate' });
      viewport.emit('animate-end', viewport);
      return viewport;
    });
    viewport.clampZoom.mockReturnValue(viewport);
    viewport.decelerate.mockReturnValue(viewport);
    viewport.drag.mockReturnValue(viewport);
    viewport.fitWorld.mockReturnValue(viewport);
    viewport.moveCenter.mockImplementation((x: number, y: number) => {
      viewport.center = { x, y };
      return viewport;
    });
    viewport.pinch.mockReturnValue(viewport);
    viewport.resize.mockReturnValue(viewport);
    viewport.setZoom.mockImplementation((zoom: number) => {
      viewport.scaled = zoom;
      return viewport;
    });
    viewport.wheel.mockReturnValue(viewport);

    instances.push(viewport);
    return viewport;
  });

  return {
    PixiViewportElementMock: vi.fn(),
    useApplicationMock: vi.fn(),
    viewportInstances: instances,
    ViewportMock: mockViewport,
  };
});

vi.mock('@pixi/react', () => ({
  useApplication: () => useApplicationMock(),
}));

vi.mock('../components/map/PixiViewportElement.js', () => ({
  PixiViewportElement: (props: any) => {
    PixiViewportElementMock(props);
    const viewportRef = useRef<any>(null);

    if (!viewportRef.current) {
      viewportRef.current = ViewportMock({
        ...props,
        passiveWheel: false,
        threshold: MAP_VIEWPORT_DRAG_THRESHOLD_PX,
      });
    }

    useEffect(() => {
      props.viewportRef?.(viewportRef.current);

      return () => {
        props.viewportRef?.(null);
      };
    }, [props.viewportRef]);

    return <div data-testid="pixi-viewport-element">{props.children}</div>;
  },
}));

describe('MapViewportHost', () => {
  const app = {
    canvas: {
      parentElement: document.createElement('div'),
    },
    renderer: {
      events: { id: 'renderer-events' },
      screen: {
        width: 320,
        height: 240,
      },
    },
    ticker: { id: 'ticker' },
  };

  beforeEach(() => {
    PixiViewportElementMock.mockClear();
    useApplicationMock.mockReset();
    viewportInstances.length = 0;
    ViewportMock.mockClear();
    app.renderer.screen.width = 320;
    app.renderer.screen.height = 240;
    useApplicationMock.mockReturnValue({
      app,
      isInitialised: true,
    });
  });

  it('creates one viewport host element, wires events, installs plugins, and renders viewport children', async () => {
    render(
      <MapViewportHost worldHeight={96} worldWidth={96}>
        <div data-testid="viewport-child">child</div>
      </MapViewportHost>,
    );

    await waitFor(() => expect(ViewportMock).toHaveBeenCalledTimes(1));
    const viewport = viewportInstances[0];

    expect(viewport).toBeDefined();
    expect(ViewportMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(viewport?.fitWorld).toHaveBeenCalledWith(true));
    expect(viewport?.options).toMatchObject({
      events: app.renderer.events,
      passiveWheel: false,
      screenHeight: 240,
      screenWidth: 320,
      threshold: MAP_VIEWPORT_DRAG_THRESHOLD_PX,
      ticker: app.ticker,
      worldHeight: 96,
      worldWidth: 96,
    });
    expect(viewport?.drag).toHaveBeenCalledTimes(1);
    expect(viewport?.wheel).toHaveBeenCalledTimes(1);
    expect(viewport?.pinch).toHaveBeenCalledTimes(1);
    expect(viewport?.decelerate).toHaveBeenCalledTimes(1);
    expect(viewport?.clampZoom).toHaveBeenCalledWith({
      maxScale: MAP_VIEWPORT_MAX_ZOOM,
      minScale: MAP_VIEWPORT_MIN_ZOOM,
    });
    expect(viewport?.setZoom).toHaveBeenCalledWith(MAP_VIEWPORT_MAX_ZOOM, true);
    expect(viewport?.moveCenter).toHaveBeenCalledWith(48, 48);
    expect(PixiViewportElementMock).toHaveBeenCalledWith(
      expect.objectContaining({
        events: app.renderer.events,
        screenHeight: 240,
        screenWidth: 320,
        ticker: app.ticker,
        worldHeight: 96,
        worldWidth: 96,
      }),
    );
    expect(screen.getByTestId('viewport-child')).toBeInTheDocument();
  });

  it('reuses the same viewport instance across rerenders and resizes it in place', async () => {
    const { rerender } = render(
      <MapViewportHost worldHeight={96} worldWidth={96}>
        <div data-testid="viewport-child">child</div>
      </MapViewportHost>,
    );

    await waitFor(() => expect(ViewportMock).toHaveBeenCalledTimes(1));
    const viewport = viewportInstances[0]!;

    rerender(
      <MapViewportHost worldHeight={128} worldWidth={144}>
        <div data-testid="viewport-child">child</div>
      </MapViewportHost>,
    );

    expect(ViewportMock).toHaveBeenCalledTimes(1);
    expect(PixiViewportElementMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        screenHeight: 240,
        screenWidth: 320,
        worldHeight: 128,
        worldWidth: 144,
      }),
    );
    await waitFor(() => expect(viewport.fitWorld).toHaveBeenCalledTimes(2));
    expect(viewport.setZoom).toHaveBeenLastCalledWith(
      calculateInitialViewportZoom({
        screenWidth: 320,
        screenHeight: 240,
        worldWidth: 144,
        worldHeight: 128,
      }),
      true,
    );
    expect(viewport.moveCenter).toHaveBeenLastCalledWith(72, 64);

    app.renderer.screen.width = 480;
    app.renderer.screen.height = 300;
    window.dispatchEvent(new Event('resize'));

    expect(viewport.resize).toHaveBeenLastCalledWith(480, 300, 144, 128);
  });

  it('reframes the live viewport and reports the new framed view when world geometry changes', async () => {
    const onViewStateChange = vi.fn();
    const { rerender } = render(
      <MapViewportHost worldHeight={96} worldWidth={96} onViewStateChange={onViewStateChange}>
        <div>child</div>
      </MapViewportHost>,
    );

    await waitFor(() =>
      expect(onViewStateChange).toHaveBeenCalledWith({
        centerX: 48,
        centerY: 48,
        zoom: MAP_VIEWPORT_MAX_ZOOM,
      }),
    );
    const viewport = viewportInstances[0]!;
    onViewStateChange.mockClear();

    viewport.center = { x: 12, y: 20 };
    viewport.scaled = 1.25;

    rerender(
      <MapViewportHost worldHeight={160} worldWidth={192} onViewStateChange={onViewStateChange}>
        <div>child</div>
      </MapViewportHost>,
    );

    const expectedZoom = calculateInitialViewportZoom({
      screenWidth: 320,
      screenHeight: 240,
      worldWidth: 192,
      worldHeight: 160,
    });

    await waitFor(() =>
      expect(onViewStateChange).toHaveBeenCalledWith({
        centerX: 96,
        centerY: 80,
        zoom: expectedZoom,
      }),
    );
    expect(viewport.fitWorld).toHaveBeenCalledTimes(2);
    expect(viewport.setZoom).toHaveBeenLastCalledWith(expectedZoom, true);
    expect(viewport.moveCenter).toHaveBeenLastCalledWith(96, 80);
  });

  it('clamps the initial framing zoom to the configured min/max range', () => {
    expect(
      calculateInitialViewportZoom({
        screenWidth: 320,
        screenHeight: 240,
        worldWidth: 10,
        worldHeight: 10,
      }),
    ).toBe(MAP_VIEWPORT_MAX_ZOOM);
    expect(
      calculateInitialViewportZoom({
        screenWidth: 320,
        screenHeight: 240,
        worldWidth: 5000,
        worldHeight: 5000,
      }),
    ).toBe(MAP_VIEWPORT_MIN_ZOOM);
  });

  it('detaches viewport listeners on unmount', async () => {
    const { unmount } = render(
      <MapViewportHost worldHeight={96} worldWidth={96}>
        <div>child</div>
      </MapViewportHost>,
    );

    await waitFor(() => expect(ViewportMock).toHaveBeenCalledTimes(1));
    const viewport = viewportInstances[0]!;

    unmount();

    expect(viewport.off).toHaveBeenCalledWith('moved', expect.any(Function));
    expect(viewport.off).toHaveBeenCalledWith('zoomed', expect.any(Function));
    expect(viewport.off).toHaveBeenCalledWith('moved-end', expect.any(Function));
    expect(viewport.off).toHaveBeenCalledWith('zoomed-end', expect.any(Function));
    expect(viewport.off).toHaveBeenCalledWith('animate-end', expect.any(Function));
  });

  it('streams live viewport state imperatively but only commits React-safe updates on settled events', async () => {
    const onLiveViewStateChange = vi.fn();
    const onViewStateChange = vi.fn();

    render(
      <MapViewportHost
        worldHeight={96}
        worldWidth={96}
        onLiveViewStateChange={onLiveViewStateChange}
        onViewStateChange={onViewStateChange}
      >
        <div>child</div>
      </MapViewportHost>,
    );

    await waitFor(() => expect(ViewportMock).toHaveBeenCalledTimes(1));
    const viewport = viewportInstances[0]!;

    await waitFor(() =>
      expect(onViewStateChange).toHaveBeenCalledWith({
        centerX: 48,
        centerY: 48,
        zoom: MAP_VIEWPORT_MAX_ZOOM,
      }),
    );
    onLiveViewStateChange.mockClear();
    onViewStateChange.mockClear();

    viewport.center = { x: 64, y: 40 };
    viewport.emit('moved', { viewport, type: 'drag' });

    await waitFor(() =>
      expect(onLiveViewStateChange).toHaveBeenLastCalledWith({
        centerX: 64,
        centerY: 40,
        zoom: MAP_VIEWPORT_MAX_ZOOM,
      }),
    );
    expect(onViewStateChange).not.toHaveBeenCalled();

    viewport.scaled = 1.25;
    viewport.emit('zoomed', { viewport, type: 'wheel' });

    await waitFor(() =>
      expect(onLiveViewStateChange).toHaveBeenLastCalledWith({
        centerX: 64,
        centerY: 40,
        zoom: 1.25,
      }),
    );
    expect(onViewStateChange).not.toHaveBeenCalled();

    viewport.emit('zoomed-end', { viewport, type: 'wheel' });

    await waitFor(() =>
      expect(onViewStateChange).toHaveBeenLastCalledWith({
        centerX: 64,
        centerY: 40,
        zoom: 1.25,
      }),
    );
    expect(onViewStateChange).toHaveBeenCalledTimes(1);

    viewport.animate({
      position: { x: 24, y: 72 },
      scale: 1.6,
      time: 300,
      ease: 'easeInOutSine',
      removeOnInterrupt: true,
    });

    await waitFor(() =>
      expect(onLiveViewStateChange).toHaveBeenLastCalledWith({
        centerX: 24,
        centerY: 72,
        zoom: 1.6,
      }),
    );

    await waitFor(() =>
      expect(onViewStateChange).toHaveBeenLastCalledWith({
        centerX: 24,
        centerY: 72,
        zoom: 1.6,
      }),
    );
  });
});
