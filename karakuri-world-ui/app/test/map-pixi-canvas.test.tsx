// @vitest-environment jsdom

import { act, fireEvent, prettyDOM, render, screen, waitFor } from '@testing-library/react';
import type { Texture } from 'pixi.js';
import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureSnapshot } from './fixtures/snapshot.js';
import { buildAgentRenderTargets, type AgentGroupRenderModel } from '../components/map/agent-render-model.js';
import { buildMapRenderModel } from '../components/map/map-render-model.js';
import { getGroupPopoverStyle, MapPixiCanvas, reconcileOpenGroupState } from '../components/map/MapPixiCanvas.js';
import {
  resetAvatarTextureCacheForTests,
  setAvatarTextureLoaderForTests,
} from '../components/map/avatar-texture-cache.js';
import { createSnapshotStore, type SnapshotStoreApi } from '../store/snapshot-store.js';

const { MockTexture, applicationMock, extendMock, textStyleMock } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class MockEmitter {
    private readonly listeners = new Map<string, Set<Listener>>();

    on(eventName: string, listener: Listener) {
      const currentListeners = this.listeners.get(eventName) ?? new Set<Listener>();
      currentListeners.add(listener);
      this.listeners.set(eventName, currentListeners);
    }

    off(eventName: string, listener: Listener) {
      this.listeners.get(eventName)?.delete(listener);
    }

    emit(eventName: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(eventName) ?? []) {
        listener(...args);
      }
    }
  }

  class MockTexture {
    width: number;
    height: number;
    private readonly textureEmitter = new MockEmitter();
    private readonly sourceEmitter = new MockEmitter();
    readonly source: {
      on: (eventName: string, listener: Listener) => void;
      off: (eventName: string, listener: Listener) => void;
    };

    constructor(width = 96, height = 96) {
      this.width = width;
      this.height = height;
      this.source = {
        on: this.sourceEmitter.on.bind(this.sourceEmitter),
        off: this.sourceEmitter.off.bind(this.sourceEmitter),
      };
    }

    on(eventName: string, listener: Listener) {
      this.textureEmitter.on(eventName, listener);
    }

    off(eventName: string, listener: Listener) {
      this.textureEmitter.off(eventName, listener);
    }

    emitReady() {
      this.width = 96;
      this.height = 96;
      this.sourceEmitter.emit('update');
    }

    emitError(error?: unknown) {
      this.sourceEmitter.emit('error', error);
    }

    static from() {
      return new MockTexture();
    }
  }

  return {
    MockTexture,
    applicationMock: vi.fn(({ children }: { children?: ReactNode }) => (
      <div data-testid="pixi-application">{children}</div>
    )),
    extendMock: vi.fn(),
    textStyleMock: vi.fn((options: Record<string, unknown>) => ({ options })),
  };
});

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

vi.mock('@pixi/react', () => ({
  Application: (props: { children?: ReactNode }) => applicationMock(props),
  extend: extendMock,
}));

vi.mock('pixi.js', () => ({
  Assets: {
    load: vi.fn(() => Promise.resolve(new MockTexture())),
  },
  Container: class Container {},
  Graphics: class Graphics {},
  Sprite: class Sprite {},
  Text: class Text {},
  TextStyle: textStyleMock,
  Texture: MockTexture,
}));

vi.mock('../components/map/map-render-model.js', async () => {
  const actual = await vi.importActual<typeof import('../components/map/map-render-model.js')>(
    '../components/map/map-render-model.js',
  );

  return {
    ...actual,
    buildMapRenderModel: vi.fn(actual.buildMapRenderModel),
  };
});

vi.mock('../components/map/MapViewportHost.js', () => ({
  MapViewportHost: ({
    children,
    onLiveViewStateChange,
    onViewStateChange,
  }: {
    children?: ReactNode;
    onLiveViewStateChange?: (viewState: { centerX: number; centerY: number; zoom: number }) => void;
    onViewStateChange?: (viewState: { centerX: number; centerY: number; zoom: number }) => void;
  }) => (
    <div data-testid="mock-map-viewport-host">
      <button
        type="button"
        data-testid="mock-map-viewport-live-view"
        onClick={() =>
          onLiveViewStateChange?.({
            centerX: 160,
            centerY: 120,
            zoom: 1.2,
          })
        }
      >
        live view
      </button>
      <button
        type="button"
        data-testid="mock-map-viewport-final-view"
        onClick={() =>
          onViewStateChange?.({
            centerX: 200,
            centerY: 160,
            zoom: 1.2,
          })
        }
      >
        final view
      </button>
      {children}
    </div>
  ),
  useMapViewport: () => null,
}));

function createResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
    ...init,
  });
}

function StoreDrivenMapPixiCanvas({ store }: { store: SnapshotStoreApi }) {
  const snapshot = useStore(store, (state) => state.snapshot);

  if (!snapshot) {
    return null;
  }

  return <MapPixiCanvas snapshot={snapshot} />;
}

async function withMockedElementMetrics<T>(
  metrics: {
    clientWidth: number;
    clientHeight: number;
    offsetWidth: number;
    offsetHeight: number;
  },
  run: () => Promise<T> | T,
): Promise<T> {
  const clientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  const offsetWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return metrics.clientWidth;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return metrics.clientHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return metrics.offsetWidth;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return metrics.offsetHeight;
    },
  });

  try {
    return await run();
  } finally {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidthDescriptor ?? { configurable: true, get: () => 0 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightDescriptor ?? { configurable: true, get: () => 0 });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidthDescriptor ?? { configurable: true, get: () => 0 });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeightDescriptor ?? { configurable: true, get: () => 0 });
  }
}

describe('MapPixiCanvas label and agent rendering', () => {
  beforeEach(() => {
    applicationMock.mockClear();
    textStyleMock.mockClear();
    vi.mocked(buildMapRenderModel).mockClear();
    resetAvatarTextureCacheForTests();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetAvatarTextureCacheForTests();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('keeps label and avatar TextStyle instances stable across selection/focus-only rerenders', () => {
    const snapshot = createFixtureSnapshot();
    const { rerender } = render(<MapPixiCanvas snapshot={snapshot} selectedAgentId="alice" />);
    const initialTextStyleCount = textStyleMock.mock.calls.length;

    expect(extendMock).toHaveBeenCalledTimes(1);
    expect(initialTextStyleCount).toBeGreaterThanOrEqual(5);

    rerender(
      <MapPixiCanvas
        snapshot={snapshot}
        selectedAgentId="bob"
        focusCommand={{
          agent_id: 'bob',
          node_id: '2-1',
          target_center_x: 48,
          target_center_y: 144,
          duration_ms: 300,
          mode: 'pan-only',
        }}
      />,
    );

    expect(textStyleMock.mock.calls.length).toBe(initialTextStyleCount);
  });

  it('keeps static render layers stable across live-only snapshot updates', () => {
    const snapshot = createFixtureSnapshot();
    const { rerender } = render(<MapPixiCanvas snapshot={snapshot} />);
    const initialTextStyleCount = textStyleMock.mock.calls.length;

    expect(buildMapRenderModel).toHaveBeenCalledTimes(1);

    rerender(
      <MapPixiCanvas
        snapshot={{
          ...snapshot,
          agents: snapshot.agents.map((agent) =>
            agent.agent_id === 'alice'
              ? {
                  ...agent,
                  node_id: '2-2',
                }
              : agent,
          ),
          published_at: snapshot.published_at + 1,
        }}
      />,
    );

    expect(buildMapRenderModel).toHaveBeenCalledTimes(1);
    expect(textStyleMock.mock.calls.length).toBe(initialTextStyleCount);
  });

  it('keeps the explicit effect layer slot ordered after selection and empty by default', () => {
    const snapshot = createFixtureSnapshot();

    render(<MapPixiCanvas snapshot={snapshot} />);

    const renderLayers = screen.getByTestId('map-render-layers');
    const layerOrder = Array.from(renderLayers.children).map((layer) => layer.getAttribute('data-testid'));

    expect(layerOrder).toEqual([
      'map-grid-layer',
      'map-label-layer',
      'map-agent-layer',
      'map-selection-layer',
      'map-effect-layer',
    ]);
    expect(screen.getByTestId('map-effect-layer').childElementCount).toBe(0);
  });

  it('mounts the no-op phase3 effect anchor only when the feature flag is enabled', () => {
    const snapshot = createFixtureSnapshot();
    const { rerender } = render(<MapPixiCanvas snapshot={snapshot} />);

    expect(screen.getByTestId('map-effect-layer').childElementCount).toBe(0);

    rerender(<MapPixiCanvas snapshot={snapshot} phase3EffectsEnabled />);

    expect(screen.getByTestId('map-effect-layer').childElementCount).toBe(1);
  });

  it('renders staged rain and day-night effects inside the explicit phase3 effect slot', () => {
    const snapshot = {
      ...createFixtureSnapshot(),
      calendar: {
        ...createFixtureSnapshot().calendar,
        local_time: '22:15:00',
      },
      weather: {
        condition: '強い雨',
        temperature_celsius: 17,
      },
    };

    render(
      <MapPixiCanvas
        snapshot={snapshot}
        phase3EffectsEnabled
        phase3EnvironmentEffectFlags={{ rain: true, dayNight: true }}
      />,
    );

    expect(screen.getByTestId('map-effect-root')).toHaveAttribute('data-active-precipitation', 'rain');
    expect(screen.getByTestId('map-effect-root')).toHaveAttribute('data-active-day-night', 'night');
    expect(screen.getByTestId('map-effect-day-night')).toBeInTheDocument();
    expect(screen.getByTestId('map-effect-rain')).toBeInTheDocument();
  });

  it('renders interpolated movement and lightweight action particles with safe flag gating', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2_250));

    try {
      const snapshot: ReturnType<typeof createFixtureSnapshot> = {
        ...createFixtureSnapshot(),
        generated_at: 2_000,
        agents: [
          {
            ...createFixtureSnapshot().agents[0]!,
            node_id: '1-1' as const,
            state: 'moving' as const,
            discord_bot_avatar_url: undefined,
            movement: {
              from_node_id: '1-1' as const,
              to_node_id: '2-2' as const,
              path: ['1-2', '2-2'] as Array<`${number}-${number}`>,
              arrives_at: 3_000,
            },
          },
        ],
      };

      render(
        <MapPixiCanvas
          snapshot={snapshot}
          phase3EffectsEnabled
          phase3MotionEffectFlags={{ motion: true, actionParticles: true }}
        />,
      );

      const fallbackAvatar = screen.getByTestId('map-agent-avatar-fallback-alice').nextElementSibling;

      expect(fallbackAvatar).toHaveAttribute('text', 'A');
      expect(fallbackAvatar).toHaveAttribute('x', '96');
      expect(fallbackAvatar).toHaveAttribute('y', '48');
      expect(screen.getByTestId('map-effect-action-particles-root')).toHaveAttribute('data-active-action-particles', '2');
      expect(screen.getByTestId('map-effect-action-particle-alice-0')).toHaveAttribute('text', '🛠️');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a rendered visual baseline for the staged snow overlay branch', () => {
    const baseSnapshot = createFixtureSnapshot();
    const snapshot = {
      ...baseSnapshot,
      calendar: {
        ...baseSnapshot.calendar,
        local_time: '05:45:00',
      },
      weather: {
        condition: '大雪と霧',
        temperature_celsius: -4,
      },
    };

    render(
      <MapPixiCanvas
        snapshot={snapshot}
        phase3EffectsEnabled
        phase3EnvironmentEffectFlags={{ snow: true, fog: true, dayNight: true }}
      />,
    );

    expect(screen.getByTestId('map-effect-root')).toHaveAttribute('data-active-precipitation', 'snow');
    expect(screen.getByTestId('map-effect-root')).toHaveAttribute('data-active-fog', 'true');
    expect(screen.getByTestId('map-effect-root')).toHaveAttribute('data-active-day-night', 'dawn');
    expect(prettyDOM(screen.getByTestId('map-effect-layer'), undefined, { highlight: false })).toMatchInlineSnapshot(`
      "<pixicontainer
        data-testid="map-effect-layer"
      >
        <pixicontainer
          data-active-day-night="dawn"
          data-active-fog="true"
          data-active-precipitation="snow"
          data-testid="map-effect-root"
        >
          <pixigraphics
            data-alpha="0.12"
            data-color="#1e1b4b"
            data-phase="dawn"
            data-testid="map-effect-day-night"
          />
          <pixigraphics
            data-band-count="4"
            data-color="#e2e8f0"
            data-max-alpha="0.09"
            data-testid="map-effect-fog"
          />
          <pixigraphics
            data-color="#f8fafc"
            data-max-alpha="0.26"
            data-particle-count="18"
            data-testid="map-effect-snow"
          />
        </pixicontainer>
      </pixicontainer>"
    `);
  });

  it('keeps a rendered visual baseline for labels, agents, selection, and weather overlays', () => {
    const baseSnapshot = createFixtureSnapshot();
    const snapshot = {
      ...baseSnapshot,
      calendar: {
        ...baseSnapshot.calendar,
        local_time: '22:15:00',
      },
      weather: {
        condition: '霧雨',
        temperature_celsius: 15,
      },
    };

    render(
      <MapPixiCanvas
        snapshot={snapshot}
        selectedAgentId="alice"
        phase3EffectsEnabled
        phase3EnvironmentEffectFlags={{ rain: true, fog: true, dayNight: true }}
      />,
    );

    expect(prettyDOM(screen.getByTestId('map-render-layers'), undefined, { highlight: false })).toMatchInlineSnapshot(`
      "<pixicontainer
        data-testid="map-render-layers"
      >
        <pixicontainer
          data-testid="map-grid-layer"
        >
          <pixigraphics />
        </pixicontainer>
        <pixicontainer
          data-testid="map-label-layer"
        >
          <pixitext
            text="1-1"
            x="8"
            y="6"
          />
          <pixitext
            anchor="0.5"
            text="Square"
            x="48"
            y="48"
          />
          <pixitext
            text="1-2"
            x="104"
            y="6"
          />
          <pixitext
            text="2-1"
            x="8"
            y="102"
          />
          <pixitext
            text="2-2"
            x="104"
            y="102"
          />
        </pixicontainer>
        <pixicontainer
          data-testid="map-agent-layer"
        >
          <pixicontainer
            cursor="pointer"
            data-testid="map-agent-target-alice"
            eventmode="static"
          >
            <pixigraphics />
            <pixicontainer>
              <pixigraphics
                data-testid="map-agent-avatar-fallback-alice"
              />
              <pixitext
                anchor="0.5"
                text="A"
                x="144"
                y="48"
              />
              <pixigraphics />
              <pixitext
                anchor="0.5"
                text="🛠️"
                x="159.5904"
                y="32.4096"
              />
            </pixicontainer>
          </pixicontainer>
          <pixicontainer
            cursor="pointer"
            data-testid="map-agent-target-bob"
            eventmode="static"
          >
            <pixigraphics />
            <pixicontainer>
              <pixigraphics
                data-testid="map-agent-avatar-fallback-bob"
              />
              <pixitext
                anchor="0.5"
                text="B"
                x="48"
                y="144"
              />
              <pixigraphics />
              <pixitext
                anchor="0.5"
                text="💤"
                x="63.5904"
                y="128.4096"
              />
            </pixicontainer>
          </pixicontainer>
        </pixicontainer>
        <pixicontainer
          data-testid="map-selection-layer"
        >
          <pixigraphics
            data-testid="map-selection-ring-alice"
          />
        </pixicontainer>
        <pixicontainer
          data-testid="map-effect-layer"
        >
          <pixicontainer
            data-active-day-night="night"
            data-active-fog="true"
            data-active-precipitation="rain"
            data-testid="map-effect-root"
          >
            <pixigraphics
              data-alpha="0.22"
              data-color="#020617"
              data-phase="night"
              data-testid="map-effect-day-night"
            />
            <pixigraphics
              data-band-count="4"
              data-color="#e2e8f0"
              data-max-alpha="0.09"
              data-testid="map-effect-fog"
            />
            <pixigraphics
              data-color="#bae6fd"
              data-max-alpha="0.25"
              data-particle-count="28"
              data-testid="map-effect-rain"
            />
          </pixicontainer>
        </pixicontainer>
      </pixicontainer>"
    `);
  });

  it('keeps render output unchanged when the phase3 effect flag stays off', () => {
    const snapshot = createFixtureSnapshot();
    const { rerender } = render(<MapPixiCanvas snapshot={snapshot} />);
    const initialMarkup = screen.getByTestId('map-render-layers').innerHTML;

    rerender(<MapPixiCanvas snapshot={snapshot} phase3EffectsEnabled={false} />);

    expect(screen.getByTestId('map-render-layers').innerHTML).toBe(initialMarkup);
  });

  it('keeps static render layers stable across store-driven live-only polls with new snapshot objects', async () => {
    const current = createFixtureSnapshot();
    const next = {
      ...createFixtureSnapshot(),
      agents: current.agents.map((agent) =>
        agent.agent_id === 'alice'
          ? {
              ...agent,
              node_id: '2-2',
            }
          : agent,
      ),
      published_at: current.published_at + 1,
    };
    const store = createSnapshotStore({
      snapshotUrl: 'https://snapshot.example.com/latest.json',
      authMode: 'public',
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(createResponse(next)),
      initialSnapshot: current,
    });

    render(<StoreDrivenMapPixiCanvas store={store} />);

    expect(buildMapRenderModel).toHaveBeenCalledTimes(1);

    await act(async () => {
      await store.getState().poll();
    });

    await waitFor(() =>
      expect(store.getState().snapshot?.agents.find((agent) => agent.agent_id === 'alice')?.node_id).toBe('2-2'),
    );
    expect(store.getState().snapshot?.map).toBe(current.map);
    expect(store.getState().snapshot?.map_render_theme).toBe(current.map_render_theme);
    expect(buildMapRenderModel).toHaveBeenCalledTimes(1);
  });

  it('rebuilds static render layers when map inputs change', () => {
    const snapshot = createFixtureSnapshot();
    const { rerender } = render(<MapPixiCanvas snapshot={snapshot} />);

    expect(buildMapRenderModel).toHaveBeenCalledTimes(1);

    rerender(
      <MapPixiCanvas
        snapshot={{
          ...snapshot,
          map_render_theme: {
            ...snapshot.map_render_theme,
            label_font_size: snapshot.map_render_theme.label_font_size + 1,
          },
        }}
      />,
    );

    expect(buildMapRenderModel).toHaveBeenCalledTimes(2);
  });

  it('shows grouped selections with a popover and a ring for only the selected agent', async () => {
    const snapshot = createFixtureSnapshot();

    render(
      <MapPixiCanvas
        snapshot={{
          ...snapshot,
          agents: [
            {
              ...snapshot.agents[0]!,
              node_id: '1-2',
            },
            {
              ...snapshot.agents[1]!,
              node_id: '1-2',
            },
          ],
        }}
        selectedAgentId="bob"
      />,
    );

    await waitFor(() => expect(screen.getByTestId('map-group-popover-1-2')).toBeInTheDocument());

    expect(screen.getByTestId('map-selection-ring-bob')).toBeInTheDocument();
    expect(screen.queryByTestId('map-selection-ring-alice')).not.toBeInTheDocument();
    expect(screen.getByTestId('map-group-agent-button-bob')).toHaveAttribute('aria-pressed', 'true');
  });

  it('closes auto-opened group popovers when the current selection no longer targets that group', async () => {
    const snapshot = createFixtureSnapshot();
    const groupedSnapshot: ReturnType<typeof createFixtureSnapshot> = {
      ...snapshot,
      agents: [
        {
          ...snapshot.agents[0]!,
          node_id: '1-2' as const,
        },
        {
          ...snapshot.agents[1]!,
          node_id: '1-2' as const,
        },
      ],
    };
    const movedSnapshot: ReturnType<typeof createFixtureSnapshot> = {
      ...groupedSnapshot,
      agents: [
        groupedSnapshot.agents[0]!,
        {
          ...groupedSnapshot.agents[1]!,
          node_id: '2-2' as const,
        },
      ],
    };
    const { rerender } = render(<MapPixiCanvas snapshot={groupedSnapshot} selectedAgentId="bob" />);

    await waitFor(() => expect(screen.getByTestId('map-group-popover-1-2')).toBeInTheDocument());

    rerender(<MapPixiCanvas snapshot={groupedSnapshot} />);

    await waitFor(() => expect(screen.queryByTestId('map-group-popover-1-2')).not.toBeInTheDocument());

    rerender(<MapPixiCanvas snapshot={groupedSnapshot} selectedAgentId="bob" />);

    await waitFor(() => expect(screen.getByTestId('map-group-popover-1-2')).toBeInTheDocument());

    rerender(<MapPixiCanvas snapshot={movedSnapshot} selectedAgentId="bob" />);

    await waitFor(() => expect(screen.queryByTestId('map-group-popover-1-2')).not.toBeInTheDocument());
  });

  it('preserves manual group popovers for unrelated selections but clears stale and selection-driven state', () => {
    const snapshot = createFixtureSnapshot();
    const manualGroupSnapshot: ReturnType<typeof createFixtureSnapshot> = {
      ...snapshot,
      agents: [
        snapshot.agents[0]!,
        snapshot.agents[1]!,
        {
          ...snapshot.agents[0]!,
          agent_id: 'charlie',
          agent_name: 'Charlie',
          node_id: '1-2' as const,
          state: 'idle' as const,
          status_emoji: '✨',
          discord_bot_avatar_url: undefined,
          current_activity: undefined,
        },
      ],
    };
    const dissolvedGroupSnapshot: ReturnType<typeof createFixtureSnapshot> = {
      ...manualGroupSnapshot,
      agents: [
        manualGroupSnapshot.agents[0]!,
        manualGroupSnapshot.agents[1]!,
        {
          ...manualGroupSnapshot.agents[2]!,
          node_id: '2-2' as const,
        },
      ],
    };
    const manualTargets = buildAgentRenderTargets(manualGroupSnapshot, 'bob');
    const dissolvedTargets = buildAgentRenderTargets(dissolvedGroupSnapshot, 'bob');

    expect(
      reconcileOpenGroupState(
        {
          nodeId: '1-2',
          source: 'manual',
        },
        manualTargets,
        'bob',
      ),
    ).toEqual({
      nodeId: '1-2',
      source: 'manual',
    });
    expect(
      reconcileOpenGroupState(
        {
          nodeId: '1-2',
          source: 'selection',
        },
        manualTargets,
        'bob',
      ),
    ).toBeUndefined();
    expect(
      reconcileOpenGroupState(
        {
          nodeId: '1-2',
          source: 'manual',
        },
        dissolvedTargets,
        'bob',
      ),
    ).toBeUndefined();
  });

  it('caps grouped popovers to the available host height and makes the list scrollable', async () => {
    await withMockedElementMetrics(
      {
        clientWidth: 320,
        clientHeight: 180,
        offsetWidth: 192,
        offsetHeight: 452,
      },
      async () => {
        const snapshot = createFixtureSnapshot();
        const groupedSnapshot = {
          ...snapshot,
          agents: Array.from({ length: 10 }, (_, index) => ({
            ...snapshot.agents[index % snapshot.agents.length]!,
            agent_id: 'agent-' + index,
            agent_name: 'Agent ' + index,
            node_id: '1-2' as const,
          })),
        };

        render(<MapPixiCanvas snapshot={groupedSnapshot} selectedAgentId="agent-0" />);

        const popover = await screen.findByTestId('map-group-popover-1-2');
        const list = screen.getByTestId('map-group-popover-list-1-2');
        const positionedContainer = popover.parentElement;
        const top = Number.parseFloat(positionedContainer?.style.top ?? '');
        const maxHeight = Number.parseFloat(popover.style.maxHeight);

        expect(maxHeight).toBeGreaterThan(0);
        expect(positionedContainer).not.toBeNull();
        expect(top + maxHeight + 16).toBeCloseTo(180, 5);
        expect(list.className).toContain('overflow-y-auto');
      },
    );
  });

  it('clamps the final group popover box inside the host when a grouped node is near the top-left edge', () => {
    const snapshot = createFixtureSnapshot();
    const groupedSnapshot = {
      ...snapshot,
      agents: snapshot.agents.map((agent) => ({
        ...agent,
        node_id: '1-1' as const,
      })),
    };
    const group = buildAgentRenderTargets(groupedSnapshot).find(
      (target) => target.kind === 'group',
    );

    expect(group).toBeDefined();
    if (!group) {
      throw new Error('Expected grouped render target');
    }

    const style = getGroupPopoverStyle(
      group,
      { width: 320, height: 240 },
      { centerX: 96, centerY: 96, zoom: 1 },
      { width: 192, height: 140 },
    );

    expect(style.left).toBe(16);
    expect(style.top).toBe(84);
  });

  it('keeps the group popover position stable across live-only snapshot rerenders', async () => {
    await withMockedElementMetrics(
      {
        clientWidth: 320,
        clientHeight: 240,
        offsetWidth: 192,
        offsetHeight: 140,
      },
      async () => {
        const snapshot = createFixtureSnapshot();
        const groupedSnapshot = {
          ...snapshot,
          agents: snapshot.agents.map((agent) => ({
            ...agent,
            node_id: '2-2' as const,
          })),
        };
        const group = buildAgentRenderTargets(groupedSnapshot).find(
          (target): target is AgentGroupRenderModel => target.kind === 'group' && target.nodeId === '2-2',
        );
        const { rerender } = render(<MapPixiCanvas snapshot={groupedSnapshot} selectedAgentId="bob" />);

        expect(group).toBeDefined();
        if (!group) {
          throw new Error('Expected grouped render target');
        }

        fireEvent.click(screen.getByTestId('mock-map-viewport-final-view'));

        const expectedMovedStyle = getGroupPopoverStyle(
          group,
          { width: 320, height: 240 },
          { centerX: 200, centerY: 160, zoom: 1.2 },
          { width: 192, height: 140 },
        );

        await waitFor(() => {
          const movedPopover = screen.getByTestId('map-group-popover-2-2');
          const movedPositionedContainer = movedPopover.parentElement;
          expect(movedPositionedContainer?.style.top).toBe(expectedMovedStyle.top + 'px');
          expect(movedPositionedContainer?.style.left).toBe(expectedMovedStyle.left + 'px');
        });

        const movedPopover = screen.getByTestId('map-group-popover-2-2');
        const movedPositionedContainer = movedPopover.parentElement;
        const movedTop = movedPositionedContainer?.style.top;
        const movedLeft = movedPositionedContainer?.style.left;

        rerender(
          <MapPixiCanvas
            snapshot={{
              ...groupedSnapshot,
              published_at: groupedSnapshot.published_at + 1,
            }}
            selectedAgentId="bob"
          />,
        );

        await waitFor(() => {
          const rerenderedPopover = screen.getByTestId('map-group-popover-2-2');
          const rerenderedPositionedContainer = rerenderedPopover.parentElement;
          expect(rerenderedPositionedContainer?.style.top).toBe(movedTop);
          expect(rerenderedPositionedContainer?.style.left).toBe(movedLeft);
        });
      },
    );
  });

  it('falls back to a placeholder when an avatar is missing or its texture load fails', async () => {
    const snapshot = createFixtureSnapshot();
    const brokenTexture = new MockTexture(0, 0);
    const loader = vi.fn((url: string) => (url.includes('alice') ? brokenTexture : new MockTexture())) as unknown as (url: string) => Texture;
    setAvatarTextureLoaderForTests(loader);

    render(
      <MapPixiCanvas
        snapshot={{
          ...snapshot,
          agents: [
            snapshot.agents[0]!,
            {
              ...snapshot.agents[1]!,
              discord_bot_avatar_url: undefined,
            },
          ],
        }}
      />,
    );

    brokenTexture.emitError(new Error('broken avatar'));

    await waitFor(() => expect(screen.getByTestId('map-agent-avatar-fallback-alice')).toBeInTheDocument());
    expect(screen.getByTestId('map-agent-avatar-fallback-bob')).toBeInTheDocument();
    expect(screen.queryByTestId('map-agent-avatar-sprite-alice')).not.toBeInTheDocument();
  });

  it('retries mounted avatar loads after the cache backoff expires', async () => {
    vi.useFakeTimers();
    const snapshot = createFixtureSnapshot();
    const brokenTexture = new MockTexture(0, 0);
    const recoveredTexture = new MockTexture();
    const loader = vi
      .fn<(url: string) => Texture>()
      .mockReturnValueOnce(brokenTexture as unknown as Texture)
      .mockReturnValue(recoveredTexture as unknown as Texture);
    setAvatarTextureLoaderForTests(loader);

    render(
      <MapPixiCanvas
        snapshot={{
          ...snapshot,
          agents: [snapshot.agents[0]!],
        }}
      />,
    );

    await act(async () => {
      brokenTexture.emitError(new Error('broken avatar'));
      await Promise.resolve();
    });

    expect(screen.getByTestId('map-agent-avatar-fallback-alice')).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(30_001);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loader).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('map-agent-avatar-sprite-alice')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('renders loaded avatars with a circular mask so sprites match the placeholder shape', async () => {
    const snapshot = createFixtureSnapshot();
    const loader = vi.fn((url: string) => new MockTexture()) as unknown as (url: string) => Texture;
    setAvatarTextureLoaderForTests(loader);

    render(<MapPixiCanvas snapshot={snapshot} />);

    await waitFor(() => expect(screen.getByTestId('map-agent-avatar-sprite-alice')).toBeInTheDocument());

    expect(screen.getByTestId('map-agent-avatar-mask-alice')).toBeInTheDocument();
  });

  it('uses the snapshot theme background for the pixi shell viewport root', () => {
    const snapshot = createFixtureSnapshot();

    render(<MapPixiCanvas snapshot={snapshot} />);

    expect(screen.getByTestId('map-pixi-shell')).toHaveStyle({
      backgroundColor: snapshot.map_render_theme.background_fill,
    });
  });
});
