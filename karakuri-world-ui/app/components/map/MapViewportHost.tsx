import { useApplication } from '@pixi/react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  MAP_VIEWPORT_MAX_ZOOM,
  MAP_VIEWPORT_MIN_ZOOM,
  applyInitialViewportFrame,
  createViewportViewState,
} from './map-viewport.js';
import { PixiViewportElement, type ViewportBridge } from './PixiViewportElement.js';
import type { MapViewportViewState } from './selection-focus.js';

export interface MapViewportHostProps {
  children?: ReactNode;
  worldWidth: number;
  worldHeight: number;
  onViewportReady?: (viewport: ViewportBridge) => void;
  onLiveViewStateChange?: (viewState: MapViewportViewState) => void;
  onViewStateChange?: (viewState: MapViewportViewState) => void;
}

const MapViewportContext = createContext<ViewportBridge | undefined>(undefined);

function getScreenSize(app: ReturnType<typeof useApplication>['app']): {
  screenWidth: number;
  screenHeight: number;
} {
  return {
    screenWidth: Math.max(Math.round(app.renderer.screen.width), 0),
    screenHeight: Math.max(Math.round(app.renderer.screen.height), 0),
  };
}

export function useMapViewport(): ViewportBridge | undefined {
  return useContext(MapViewportContext);
}

export function MapViewportHost({
  children,
  worldWidth,
  worldHeight,
  onViewportReady,
  onLiveViewStateChange,
  onViewStateChange,
}: MapViewportHostProps) {
  const { app, isInitialised } = useApplication();
  const viewportRef = useRef<ViewportBridge | undefined>(undefined);
  const initialFrameAppliedRef = useRef(false);
  const lastFramedWorldKeyRef = useRef<string | undefined>(undefined);
  const onViewportReadyRef = useRef(onViewportReady);
  const onLiveViewStateChangeRef = useRef(onLiveViewStateChange);
  const onViewStateChangeRef = useRef(onViewStateChange);
  const [viewport, setViewport] = useState<ViewportBridge | undefined>(undefined);
  const worldGeometryKey = String(worldWidth) + ':' + String(worldHeight);
  const handleViewportRef = useCallback((nextViewport: ViewportBridge | null) => {
    const resolvedViewport = nextViewport ?? undefined;

    viewportRef.current = resolvedViewport;
    if (!resolvedViewport) {
      initialFrameAppliedRef.current = false;
      lastFramedWorldKeyRef.current = undefined;
    }
    setViewport((currentViewport) => (currentViewport === resolvedViewport ? currentViewport : resolvedViewport));

    if (resolvedViewport) {
      onViewportReadyRef.current?.(resolvedViewport);
    }
  }, []);

  useEffect(() => {
    onViewportReadyRef.current = onViewportReady;
  }, [onViewportReady]);

  useEffect(() => {
    onLiveViewStateChangeRef.current = onLiveViewStateChange;
  }, [onLiveViewStateChange]);

  useEffect(() => {
    onViewStateChangeRef.current = onViewStateChange;
  }, [onViewStateChange]);

  useEffect(() => {
    if (!viewport) {
      return;
    }

    viewport.drag().wheel().pinch().decelerate().clampZoom({
      minScale: MAP_VIEWPORT_MIN_ZOOM,
      maxScale: MAP_VIEWPORT_MAX_ZOOM,
    });
  }, [viewport]);

  useEffect(() => {
    if (!isInitialised || !viewportRef.current) {
      return;
    }

    const currentViewport = viewportRef.current;

    const syncViewport = () => {
      const { screenWidth, screenHeight } = getScreenSize(app);

      currentViewport.resize(screenWidth, screenHeight, worldWidth, worldHeight);

      const shouldApplyFrame =
        screenWidth > 0 &&
        screenHeight > 0 &&
        (!initialFrameAppliedRef.current || lastFramedWorldKeyRef.current !== worldGeometryKey);

      if (shouldApplyFrame) {
        const framedViewState = applyInitialViewportFrame(currentViewport, {
          screenWidth,
          screenHeight,
          worldWidth,
          worldHeight,
        });

        initialFrameAppliedRef.current = true;
        lastFramedWorldKeyRef.current = worldGeometryKey;
        onViewStateChangeRef.current?.(framedViewState);
        return;
      }

      onViewStateChangeRef.current?.(createViewportViewState(currentViewport));
    };

    syncViewport();

    window.addEventListener('resize', syncViewport);

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' && app.canvas?.parentElement
        ? new ResizeObserver(() => syncViewport())
        : undefined;

    if (resizeObserver && app.canvas.parentElement) {
      resizeObserver.observe(app.canvas.parentElement);
    }

    return () => {
      window.removeEventListener('resize', syncViewport);
      resizeObserver?.disconnect();
    };
  }, [app, isInitialised, viewport, worldGeometryKey, worldHeight, worldWidth]);

  useEffect(() => {
    if (!viewport) {
      return;
    }

    let lastLiveKey: string | undefined;
    let lastCommittedKey: string | undefined;

    const createStateKey = (viewState: MapViewportViewState) =>
      `${viewState.centerX}:${viewState.centerY}:${viewState.zoom}`;
    const syncLiveViewState = () => {
      const nextViewState = createViewportViewState(viewport);
      const nextKey = createStateKey(nextViewState);

      if (nextKey === lastLiveKey) {
        return;
      }

      lastLiveKey = nextKey;
      onLiveViewStateChangeRef.current?.(nextViewState);
    };
    const syncCommittedViewState = () => {
      const nextViewState = createViewportViewState(viewport);
      const nextKey = createStateKey(nextViewState);

      if (nextKey === lastCommittedKey) {
        return;
      }

      lastCommittedKey = nextKey;
      onViewStateChangeRef.current?.(nextViewState);
    };

    for (const eventName of ['moved', 'zoomed']) {
      viewport.on(eventName, syncLiveViewState);
    }

    for (const eventName of ['moved-end', 'zoomed-end', 'animate-end']) {
      viewport.on(eventName, syncCommittedViewState);
    }

    return () => {
      for (const eventName of ['moved', 'zoomed']) {
        viewport.off(eventName, syncLiveViewState);
      }

      for (const eventName of ['moved-end', 'zoomed-end', 'animate-end']) {
        viewport.off(eventName, syncCommittedViewState);
      }
    };
  }, [viewport]);

  if (!isInitialised) {
    return null;
  }

  return (
    <MapViewportContext.Provider value={viewport}>
      <PixiViewportElement
        events={app.renderer.events}
        screenHeight={getScreenSize(app).screenHeight}
        screenWidth={getScreenSize(app).screenWidth}
        ticker={app.ticker}
        viewportRef={handleViewportRef}
        worldHeight={worldHeight}
        worldWidth={worldWidth}
      >
        {children}
      </PixiViewportElement>
    </MapViewportContext.Provider>
  );
}
