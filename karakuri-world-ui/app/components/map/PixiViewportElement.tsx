import { extend } from '@pixi/react';
import { createElement, useEffect, useState, type ReactNode, type Ref } from 'react';

import { MAP_VIEWPORT_DRAG_THRESHOLD_PX } from './map-viewport.js';

export interface ViewportBridge {
  parent?: unknown;
  destroy(options?: { children?: boolean }): void;
  resize(screenWidth?: number, screenHeight?: number, worldWidth?: number, worldHeight?: number): void;
  animate(options: {
    position: { x: number; y: number };
    scale?: number;
    time: number;
    ease: string;
    removeOnInterrupt: boolean;
  }): unknown;
  drag(): ViewportBridge;
  wheel(): ViewportBridge;
  pinch(): ViewportBridge;
  decelerate(): ViewportBridge;
  clampZoom(options: { minScale: number; maxScale: number }): ViewportBridge;
  fitWorld(center?: boolean): ViewportBridge;
  setZoom(scale: number, center?: boolean): ViewportBridge;
  moveCenter(x: number, y: number): ViewportBridge;
  on(eventName: string, listener: (...args: unknown[]) => void): ViewportBridge;
  off(eventName: string, listener: (...args: unknown[]) => void): ViewportBridge;
  center: { x: number; y: number };
  scaled: number;
}

export interface PixiViewportElementProps {
  children?: ReactNode;
  events: unknown;
  screenHeight: number;
  screenWidth: number;
  ticker: unknown;
  viewportRef?: Ref<ViewportBridge | null>;
  worldHeight: number;
  worldWidth: number;
}

let viewportRegistrationPromise: Promise<void> | undefined;

async function ensurePixiViewportRegistered() {
  if (!viewportRegistrationPromise) {
    viewportRegistrationPromise = import('pixi-viewport').then((module) => {
      const ViewportCtor =
        (module as { Viewport?: new (...args: any[]) => ViewportBridge }).Viewport ??
        (
          module as {
            default?: {
              Viewport?: new (...args: any[]) => ViewportBridge;
            };
          }
        ).default?.Viewport;

      if (!ViewportCtor) {
        throw new Error('pixi-viewport Viewport constructor is unavailable');
      }

      extend({ Viewport: ViewportCtor });
    });
  }

  await viewportRegistrationPromise;
}

export function PixiViewportElement({
  children,
  events,
  screenHeight,
  screenWidth,
  ticker,
  viewportRef,
  worldHeight,
  worldWidth,
}: PixiViewportElementProps) {
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    let disposed = false;

    void ensurePixiViewportRegistered()
      .then(() => {
        if (!disposed) {
          setIsReady(true);
        }
      })
      .catch((error) => {
        if (!disposed) {
          setLoadError(error instanceof Error ? error : new Error(String(error)));
        }
      });

    return () => {
      disposed = true;
    };
  }, []);

  if (loadError) {
    throw loadError;
  }

  if (!isReady) {
    return null;
  }

  return createElement(
    'pixiViewport' as any,
    {
      ref: viewportRef,
      screenWidth,
      screenHeight,
      worldWidth,
      worldHeight,
      threshold: MAP_VIEWPORT_DRAG_THRESHOLD_PX,
      events,
      ticker,
      passiveWheel: false,
    },
    children,
  );
}
