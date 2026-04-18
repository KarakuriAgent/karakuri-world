// @vitest-environment jsdom

import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App.js';
import { createSnapshotStore } from '../store/snapshot-store.js';
import { createFixtureSnapshot } from './fixtures/snapshot.js';
import type { SpectatorSnapshot } from '../../worker/src/contracts/spectator-snapshot.js';

const env = {
  snapshotUrl: 'https://snapshot.example.com/snapshot/latest.json',
  authMode: 'public' as const,
  apiBaseUrl: 'https://relay.example.com/api/history',
};

function createReadyStore() {
  return createSnapshotStore({
    snapshotUrl: env.snapshotUrl,
    authMode: env.authMode,
    historyApiUrl: env.apiBaseUrl,
    initialSnapshot: createFixtureSnapshot(),
    initialSelectedAgentId: 'alice',
  });
}

function createReadySnapshot(overrides?: Partial<SpectatorSnapshot>): SpectatorSnapshot {
  return {
    ...createFixtureSnapshot(),
    ...overrides,
  };
}

function createResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
    ...init,
  });
}

function createDeferredResponse() {
  let resolve: ((response: Response) => void) | undefined;

  return {
    promise: new Promise<Response>((nextResolve) => {
      resolve = nextResolve;
    }),
    resolve(response: Response) {
      resolve?.(response);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockResolvedValue(
      createResponse({
        items: [],
      }),
    ),
  );
});

describe('App shell bootstrap', () => {
  it('renders the single-route spectator shell for desktop and mobile layouts with one shared map host', () => {
    render(<App env={env} store={createReadyStore()} autoStartPolling={false} />);

    const desktopShell = screen.getByTestId('desktop-shell');
    const mapHost = screen.getByTestId('map-canvas-host');

    expect(desktopShell).toBeInTheDocument();
    expect(screen.getByTestId('desktop-sidebar')).toBeInTheDocument();
    expect(screen.getAllByTestId('map-canvas-host')).toHaveLength(1);
    expect(desktopShell).toContainElement(mapHost);
    expect(Array.from(desktopShell.children)[1]).toBe(mapHost);
    expect(screen.getByTestId('desktop-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-top-badge')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bottom-sheet')).toBeInTheDocument();
  });

  it('starts the mobile layout in peek mode when no agent is selected and shows the summary counts', () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createReadySnapshot(),
    });

    render(<App env={env} store={store} autoStartPolling={false} />);

    expect(screen.getByTestId('mobile-bottom-sheet')).toHaveAttribute('data-sheet-mode', 'peek');
    expect(screen.getByTestId('mobile-peek-panel')).toHaveTextContent('エージェント数 2');
    expect(screen.getByTestId('mobile-peek-panel')).toHaveTextContent('進行中イベント数 1');
  });

  it('uses the spectator snapshot contract to populate the shell frame', () => {
    render(<App env={env} store={createReadyStore()} autoStartPolling={false} />);

    const sidebar = screen.getByTestId('desktop-sidebar');
    expect(within(sidebar).getByText('夏・20日目')).toBeInTheDocument();
    expect(within(sidebar).getByText('Harvest Festival')).toBeInTheDocument();
    expect(within(sidebar).getByText('Alice')).toBeInTheDocument();

    const overlay = screen.getByTestId('desktop-overlay');
    expect(within(overlay).getByText('Craft')).toBeInTheDocument();
    expect(within(overlay).getByRole('img', { name: 'Alice avatar' })).toHaveAttribute(
      'src',
      'https://example.com/alice.png',
    );

    const mobileDetailPanel = screen.getByTestId('mobile-detail-panel');
    expect(within(mobileDetailPanel).getByRole('img', { name: 'Alice avatar' })).toHaveAttribute(
      'src',
      'https://example.com/alice.png',
    );
  });

  it('keeps the desktop shell in sidebar + map mode until an agent is selected, then adds the overlay rail', async () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createReadySnapshot(),
    });

    render(<App env={env} store={store} autoStartPolling={false} />);

    const desktopShell = screen.getByTestId('desktop-shell');
    const mapHost = screen.getByTestId('map-canvas-host');
    expect(desktopShell.className).toContain('lg:grid-cols-[320px_minmax(0,1fr)]');
    expect(screen.queryByTestId('desktop-overlay')).not.toBeInTheDocument();
    expect(Array.from(desktopShell.children)).toEqual([
      screen.getByTestId('desktop-sidebar').parentElement,
      mapHost,
    ]);

    fireEvent.click(screen.getByTestId('sidebar-agent-button-alice'));

    await waitFor(() => expect(screen.getByTestId('desktop-overlay')).toBeInTheDocument());
    expect(desktopShell.className).toContain('lg:grid-cols-[320px_minmax(0,1fr)_360px]');
    expect(Array.from(desktopShell.children)[1]).toBe(mapHost);
    expect(Array.from(desktopShell.children)[2]).toBe(screen.getByTestId('desktop-overlay-rail'));

    fireEvent.click(screen.getByTestId('desktop-overlay-close'));

    await waitFor(() => expect(screen.queryByTestId('desktop-overlay')).not.toBeInTheDocument());
    expect(desktopShell.className).toContain('lg:grid-cols-[320px_minmax(0,1fr)]');
  });

  it('lets the mobile detail close action clear selected_agent_id and return to the list', async () => {
    const store = createReadyStore();

    render(<App env={env} store={store} autoStartPolling={false} />);

    expect(store.getState().selected_agent_id).toBe('alice');
    expect(screen.getByTestId('mobile-detail-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('mobile-overlay-close'));

    await waitFor(() => expect(store.getState().selected_agent_id).toBeUndefined());
    await waitFor(() => expect(screen.queryByTestId('mobile-detail-panel')).not.toBeInTheDocument());
    expect(within(screen.getByTestId('mobile-bottom-sheet')).getByText('エージェント一覧')).toBeInTheDocument();
  });

  it('lets the mobile list select an agent again and reopen detail after closing it', async () => {
    const store = createReadyStore();

    render(<App env={env} store={store} autoStartPolling={false} />);

    fireEvent.click(screen.getByTestId('mobile-overlay-close'));

    await waitFor(() => expect(store.getState().selected_agent_id).toBeUndefined());
    await waitFor(() => expect(screen.queryByTestId('mobile-detail-panel')).not.toBeInTheDocument());

    fireEvent.click(screen.getByTestId('mobile-agent-button-bob'));

    await waitFor(() => expect(store.getState().selected_agent_id).toBe('bob'));
    await waitFor(() => expect(screen.getByTestId('mobile-detail-panel')).toBeInTheDocument());
    expect(screen.getByTestId('mobile-agent-avatar-fallback')).toHaveTextContent('B');
    expect(screen.queryByTestId('mobile-agent-button-bob')).not.toBeInTheDocument();
  });

  it('keeps sidebar and map-origin selection in sync, including same-agent reselection and clear', async () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createReadySnapshot(),
    });

    render(<App env={env} store={store} autoStartPolling={false} />);

    expect(screen.getByTestId('map-selection-summary')).toHaveTextContent('未選択');
    expect(screen.getByTestId('map-focus-request-count')).toHaveTextContent('0');

    fireEvent.click(screen.getByTestId('sidebar-agent-button-alice'));

    await waitFor(() => expect(store.getState().selected_agent_id).toBe('alice'));
    expect(screen.getByTestId('map-selection-summary')).toHaveTextContent('Alice @ 1-2');
    expect(screen.getByTestId('map-focus-request-count')).toHaveTextContent('1');
    expect(screen.getByTestId('map-focus-mode')).toHaveTextContent('zoom');
    expect(screen.getByTestId('map-focus-duration')).toHaveTextContent('300ms');
    expect(screen.getByTestId('map-focus-zoom')).toHaveTextContent('1.6x');
    expect(screen.getByTestId('map-focus-node')).toHaveTextContent('1-2');

    fireEvent.click(screen.getByTestId('sidebar-agent-button-alice'));

    await waitFor(() => expect(store.getState().selected_agent_revision).toBe(2));
    expect(screen.getByTestId('map-focus-request-count')).toHaveTextContent('2');

    fireEvent.click(screen.getByTestId('desktop-overlay-close'));

    await waitFor(() => expect(store.getState().selected_agent_id).toBeUndefined());
    expect(screen.getByTestId('map-selection-summary')).toHaveTextContent('未選択');
    expect(screen.getByTestId('map-focus-mode')).toHaveTextContent('idle');
  });

  it('loads selected-agent history from /api/history?agent_id=...&limit=20 and renders it in the overlay', async () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createReadySnapshot(),
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createResponse({
        items: [
          {
            event_id: 'event-new',
            type: 'action_completed',
            occurred_at: 1_780_000_010_000,
            agent_ids: ['alice'],
            summary: {
              emoji: '✅',
              title: 'Craft complete',
              text: 'Alice finished crafting.',
            },
            detail: {},
          },
          {
            event_id: 'event-old',
            type: 'movement_started',
            occurred_at: 1_780_000_000_000,
            agent_ids: ['alice'],
            summary: {
              emoji: '🚶',
              title: 'Moved',
              text: 'Alice started moving.',
            },
            detail: {},
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<App env={env} store={store} autoStartPolling={false} />);

    fireEvent.click(screen.getByTestId('sidebar-agent-button-alice'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        'https://relay.example.com/api/history?agent_id=alice&limit=20',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId('desktop-agent-history-list')).toBeInTheDocument());

    const items = within(screen.getByTestId('desktop-agent-history-list')).getAllByTestId('desktop-agent-history-item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Craft complete');
    expect(items[1]).toHaveTextContent('Moved');
    expect(screen.queryByText('履歴タイムラインと会話展開は後続 Unit で接続します。')).not.toBeInTheDocument();
  });

  it('shows a full-area initial history error with retry, distinct from append failures', async () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createReadySnapshot(),
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('upstream failed', { status: 503 }))
      .mockResolvedValueOnce(
        createResponse({
          items: [
            {
              event_id: 'event-1',
              type: 'action_completed',
              occurred_at: 1_780_000_020_000,
              agent_ids: ['alice'],
              summary: {
                emoji: '✅',
                title: 'Recovered history',
                text: 'Alice history recovered after retry.',
              },
              detail: {},
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<App env={env} store={store} autoStartPolling={false} />);

    fireEvent.click(screen.getByTestId('sidebar-agent-button-alice'));

    await waitFor(() => expect(screen.getByTestId('desktop-agent-history-error')).toHaveTextContent('履歴の取得に失敗しました'));
    expect(screen.queryByTestId('desktop-agent-history-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('desktop-agent-history-append-error')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('desktop-agent-history-retry'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        'https://relay.example.com/api/history?agent_id=alice&limit=20',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await waitFor(() => expect(screen.getAllByText('Recovered history')).toHaveLength(2));
    expect(screen.queryByTestId('desktop-agent-history-error')).not.toBeInTheDocument();
  });

  it('appends agent history pages with retryable inline errors while preserving existing items', async () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createReadySnapshot(),
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createResponse({
          items: [
            {
              event_id: 'event-2',
              type: 'action_completed',
              occurred_at: 1_780_000_020_000,
              agent_ids: ['alice'],
              summary: {
                emoji: '✅',
                title: 'Craft complete',
                text: 'Alice finished crafting.',
              },
              detail: {},
            },
          ],
          next_cursor: 'cursor-1',
        }),
      )
      .mockResolvedValueOnce(new Response('upstream failed', { status: 503 }))
      .mockResolvedValueOnce(
        createResponse({
          items: [
            {
              event_id: 'event-2',
              type: 'action_completed',
              occurred_at: 1_780_000_020_000,
              agent_ids: ['alice'],
              summary: {
                emoji: '✅',
                title: 'Craft complete duplicate',
                text: 'Duplicate event should be removed.',
              },
              detail: {},
            },
            {
              event_id: 'event-1',
              type: 'movement_started',
              occurred_at: 1_780_000_000_000,
              agent_ids: ['alice'],
              summary: {
                emoji: '🚶',
                title: 'Moved',
                text: 'Alice started moving.',
              },
              detail: {},
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<App env={env} store={store} autoStartPolling={false} />);

    fireEvent.click(screen.getByTestId('sidebar-agent-button-alice'));

    await waitFor(() => expect(screen.getByTestId('desktop-agent-history-load-more')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('desktop-agent-history-load-more'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        'https://relay.example.com/api/history?agent_id=alice&limit=20&cursor=cursor-1',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId('desktop-agent-history-append-error')).toHaveTextContent('続きの取得に失敗しました'));
    expect(screen.getByTestId('desktop-agent-history-list')).toBeInTheDocument();
    expect(screen.queryByTestId('desktop-agent-history-error')).not.toBeInTheDocument();
    expect(screen.getAllByText('Craft complete')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('desktop-agent-history-append-retry'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(within(screen.getByTestId('desktop-agent-history-list')).getAllByTestId('desktop-agent-history-item')).toHaveLength(2),
    );
    const items = within(screen.getByTestId('desktop-agent-history-list')).getAllByTestId('desktop-agent-history-item');
    expect(items[0]).toHaveTextContent('Craft complete');
    expect(items[1]).toHaveTextContent('Moved');
    expect(screen.queryByTestId('desktop-agent-history-append-error')).not.toBeInTheDocument();
  });

  it('keeps the last good history visible and retries a failed background replace fetch', async () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createReadySnapshot(),
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createResponse({
          items: [
            {
              event_id: 'event-1',
              type: 'action_started',
              occurred_at: 1_780_000_000_000,
              agent_ids: ['alice'],
              summary: {
                emoji: '🛠️',
                title: 'Craft started',
                text: 'Alice started crafting.',
              },
              detail: {},
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response('upstream failed', { status: 503 }))
      .mockResolvedValueOnce(
        createResponse({
          items: [
            {
              event_id: 'event-2',
              type: 'action_completed',
              occurred_at: 1_780_000_020_000,
              agent_ids: ['alice'],
              summary: {
                emoji: '✅',
                title: 'Craft complete',
                text: 'Alice finished crafting.',
              },
              detail: {},
            },
            {
              event_id: 'event-1',
              type: 'action_started',
              occurred_at: 1_780_000_000_000,
              agent_ids: ['alice'],
              summary: {
                emoji: '🛠️',
                title: 'Craft started',
                text: 'Alice started crafting.',
              },
              detail: {},
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<App env={env} store={store} autoStartPolling={false} />);

    fireEvent.click(screen.getByTestId('sidebar-agent-button-alice'));

    const desktopOverlay = screen.getByTestId('desktop-overlay');
    await waitFor(() => expect(within(desktopOverlay).getByText('Craft started')).toBeInTheDocument());

    store.setState((state) => ({
      history_cache: {
        ...state.history_cache,
        'agent:alice':
          state.history_cache['agent:alice']?.status === 'ready'
            ? {
                ...state.history_cache['agent:alice'],
                last_fetched_at: Date.now() - 31_000,
              }
            : state.history_cache['agent:alice'],
      },
    }));

    fireEvent.click(screen.getByTestId('sidebar-agent-button-alice'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(desktopOverlay).getByTestId('desktop-agent-history-warning')).toHaveTextContent('更新に失敗しました'));
    expect(within(desktopOverlay).getByText('Craft started')).toBeInTheDocument();
    expect(within(desktopOverlay).queryByTestId('desktop-agent-history-error')).not.toBeInTheDocument();

    fireEvent.click(within(desktopOverlay).getByTestId('desktop-agent-history-warning-retry'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(within(desktopOverlay).getByText('Craft complete')).toBeInTheDocument());
    expect(within(desktopOverlay).queryByTestId('desktop-agent-history-warning')).not.toBeInTheDocument();
  });

  it('keeps retry affordances visible when a stale empty history refresh fails', async () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createReadySnapshot(),
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createResponse({
          items: [],
        }),
      )
      .mockResolvedValueOnce(new Response('upstream failed', { status: 503 }))
      .mockResolvedValueOnce(
        createResponse({
          items: [
            {
              event_id: 'event-1',
              type: 'action_completed',
              occurred_at: 1_780_000_020_000,
              agent_ids: ['alice'],
              summary: {
                emoji: '✅',
                title: 'Craft complete',
                text: 'Alice finished crafting after retry.',
              },
              detail: {},
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<App env={env} store={store} autoStartPolling={false} />);

    fireEvent.click(screen.getByTestId('sidebar-agent-button-alice'));

    const desktopOverlay = screen.getByTestId('desktop-overlay');
    await waitFor(() =>
      expect(within(desktopOverlay).getByTestId('desktop-agent-history-empty')).toHaveTextContent('履歴はまだありません'),
    );

    store.setState((state) => ({
      history_cache: {
        ...state.history_cache,
        'agent:alice':
          state.history_cache['agent:alice']?.status === 'ready'
            ? {
                ...state.history_cache['agent:alice'],
                last_fetched_at: Date.now() - 31_000,
              }
            : state.history_cache['agent:alice'],
      },
    }));

    fireEvent.click(screen.getByTestId('sidebar-agent-button-alice'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(within(desktopOverlay).getByTestId('desktop-agent-history-warning')).toHaveTextContent('更新に失敗しました'),
    );
    expect(within(desktopOverlay).getByTestId('desktop-agent-history-empty')).toHaveTextContent('履歴はまだありません');

    fireEvent.click(within(desktopOverlay).getByTestId('desktop-agent-history-warning-retry'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(within(desktopOverlay).getByText('Craft complete')).toBeInTheDocument());
    expect(within(desktopOverlay).queryByTestId('desktop-agent-history-warning')).not.toBeInTheDocument();
  });

  it('retries the preserved append request on same-agent reselection after an append failure', async () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createReadySnapshot(),
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createResponse({
          items: [
            {
              event_id: 'event-2',
              type: 'action_completed',
              occurred_at: 1_780_000_020_000,
              agent_ids: ['alice'],
              summary: {
                emoji: '✅',
                title: 'Craft complete',
                text: 'Alice finished crafting.',
              },
              detail: {},
            },
          ],
          next_cursor: 'cursor-1',
        }),
      )
      .mockResolvedValueOnce(new Response('upstream failed', { status: 503 }))
      .mockResolvedValueOnce(
        createResponse({
          items: [
            {
              event_id: 'event-1',
              type: 'movement_started',
              occurred_at: 1_780_000_000_000,
              agent_ids: ['alice'],
              summary: {
                emoji: '🚶',
                title: 'Moved',
                text: 'Alice started moving.',
              },
              detail: {},
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<App env={env} store={store} autoStartPolling={false} />);

    fireEvent.click(screen.getByTestId('sidebar-agent-button-alice'));

    await waitFor(() => expect(screen.getByTestId('desktop-agent-history-load-more')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('desktop-agent-history-load-more'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        'https://relay.example.com/api/history?agent_id=alice&limit=20&cursor=cursor-1',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId('desktop-agent-history-append-error')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('sidebar-agent-button-alice'));

    await waitFor(() => expect(store.getState().selected_agent_revision).toBe(2));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        'https://relay.example.com/api/history?agent_id=alice&limit=20&cursor=cursor-1',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await waitFor(() =>
      expect(within(screen.getByTestId('desktop-agent-history-list')).getAllByTestId('desktop-agent-history-item')).toHaveLength(2),
    );

    const items = within(screen.getByTestId('desktop-agent-history-list')).getAllByTestId('desktop-agent-history-item');
    expect(items[0]).toHaveTextContent('Craft complete');
    expect(items[1]).toHaveTextContent('Moved');
    expect(screen.queryByTestId('desktop-agent-history-append-error')).not.toBeInTheDocument();
  });

  it('reuses fresh history on same-agent reselection and reloads stale history after 30 seconds', async () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createReadySnapshot(),
    });
    const reloadResponse = createDeferredResponse();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createResponse({
          items: [
            {
              event_id: 'event-1',
              type: 'action_started',
              occurred_at: 1_780_000_000_000,
              agent_ids: ['alice'],
              summary: {
                emoji: '🛠️',
                title: 'Craft started',
                text: 'Alice started crafting.',
              },
              detail: {},
            },
          ],
        }),
      )
      .mockImplementationOnce(() => reloadResponse.promise);
    vi.stubGlobal('fetch', fetchMock);

    render(<App env={env} store={store} autoStartPolling={false} />);

    fireEvent.click(screen.getByTestId('sidebar-agent-button-alice'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const desktopOverlay = screen.getByTestId('desktop-overlay');
    await waitFor(() => expect(within(desktopOverlay).getByTestId('desktop-agent-history-list')).toBeInTheDocument());
    expect(within(desktopOverlay).getByText('Craft started')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sidebar-agent-button-alice'));

    await waitFor(() => expect(store.getState().selected_agent_revision).toBe(2));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    store.setState((state) => ({
      history_cache: {
        ...state.history_cache,
        'agent:alice':
          state.history_cache['agent:alice']?.status === 'ready'
            ? {
                ...state.history_cache['agent:alice'],
                last_fetched_at: Date.now() - 31_000,
              }
            : state.history_cache['agent:alice'],
      },
    }));

    fireEvent.click(screen.getByTestId('sidebar-agent-button-alice'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(within(desktopOverlay).getByTestId('desktop-agent-history-updating')).toHaveTextContent('更新中…');
    expect(within(desktopOverlay).getByText('Craft started')).toBeInTheDocument();

    reloadResponse.resolve(
      createResponse({
        items: [
          {
            event_id: 'event-2',
            type: 'action_completed',
            occurred_at: 1_780_000_020_000,
            agent_ids: ['alice'],
            summary: {
              emoji: '✅',
              title: 'Craft complete',
              text: 'Alice finished crafting.',
            },
            detail: {},
          },
          {
            event_id: 'event-1',
            type: 'action_started',
            occurred_at: 1_780_000_000_000,
            agent_ids: ['alice'],
            summary: {
              emoji: '🛠️',
              title: 'Craft started',
              text: 'Alice started crafting.',
            },
            detail: {},
          },
        ],
      }),
    );

    await waitFor(() => expect(within(desktopOverlay).getByText('Craft complete')).toBeInTheDocument());
    const items = within(within(desktopOverlay).getByTestId('desktop-agent-history-list')).getAllByTestId(
      'desktop-agent-history-item',
    );
    expect(items[0]).toHaveTextContent('Craft complete');
    expect(items[1]).toHaveTextContent('Craft started');
  });

  it('keeps the rendered desktop overlay history in sync during the close animation', async () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createReadySnapshot(),
      initialSelectedAgentId: 'alice',
    });

    store.setState((state) => ({
      history_cache: {
        ...state.history_cache,
        'agent:alice': {
          status: 'ready',
          request: {
            limit: 20,
            merge: 'replace',
          },
          last_fetched_at: 1_780_000_010_000,
          response: {
            items: [
              {
                event_id: 'event-alice',
                type: 'action_completed',
                occurred_at: 1_780_000_010_000,
                agent_ids: ['alice'],
                summary: {
                  emoji: '✅',
                  title: 'Alice history',
                  text: 'Alice history stays visible while the overlay closes.',
                },
                detail: {},
              },
            ],
          },
        },
      },
    }));

    render(<App env={env} store={store} autoStartPolling={false} />);
    const desktopOverlay = screen.getByTestId('desktop-overlay');

    expect(within(desktopOverlay).getByText('Alice history')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('desktop-overlay-close'));

    expect(store.getState().selected_agent_id).toBeUndefined();
    expect(within(desktopOverlay).getByTestId('desktop-agent-name')).toHaveTextContent('Alice');
    expect(within(desktopOverlay).getByText('Alice history')).toBeInTheDocument();
    expect(within(desktopOverlay).queryByTestId('desktop-agent-history-loading')).not.toBeInTheDocument();
    expect(within(desktopOverlay).queryByTestId('desktop-agent-history-error')).not.toBeInTheDocument();

    await waitFor(() => expect(screen.queryByTestId('desktop-overlay')).not.toBeInTheDocument());
  });

  it('replaces an in-flight same-agent history load on reselection and clears the loading deadlock', async () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createReadySnapshot(),
    });
    const firstResponse = createDeferredResponse();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockResolvedValueOnce(
        createResponse({
          items: [
            {
              event_id: 'event-2',
              type: 'action_completed',
              occurred_at: 1_780_000_020_000,
              agent_ids: ['alice'],
              summary: {
                emoji: '✅',
                title: 'Replacement history',
                text: 'Alice finished crafting after reselection.',
              },
              detail: {},
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<App env={env} store={store} autoStartPolling={false} />);

    fireEvent.click(screen.getByTestId('sidebar-agent-button-alice'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('desktop-agent-history-loading')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sidebar-agent-button-alice'));

    await waitFor(() => expect(store.getState().selected_agent_revision).toBe(2));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByText('Replacement history')).toHaveLength(2));
    expect(store.getState().history_cache['agent:alice']?.status).toBe('ready');

    firstResponse.resolve(
      createResponse({
        items: [
          {
            event_id: 'event-1',
            type: 'action_started',
            occurred_at: 1_780_000_000_000,
            agent_ids: ['alice'],
            summary: {
              emoji: '🛠️',
              title: 'Stale history',
              text: 'Alice started crafting before the replacement request finished.',
            },
            detail: {},
          },
        ],
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getAllByText('Replacement history')).toHaveLength(2);
    expect(screen.queryByText('Stale history')).not.toBeInTheDocument();
    expect(store.getState().history_cache['agent:alice']?.status).toBe('ready');
  });

  it('recovers selected-agent history loading after a StrictMode cancellation remount', async () => {
    const store = createReadyStore();
    const firstResponse = createDeferredResponse();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockResolvedValueOnce(
        createResponse({
          items: [
            {
              event_id: 'event-2',
              type: 'action_completed',
              occurred_at: 1_780_000_020_000,
              agent_ids: ['alice'],
              summary: {
                emoji: '✅',
                title: 'StrictMode recovery',
                text: 'Alice history recovered after remount.',
              },
              detail: {},
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <StrictMode>
        <App env={env} store={store} autoStartPolling={false} />
      </StrictMode>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByText('StrictMode recovery')).toHaveLength(2));
    expect(store.getState().history_cache['agent:alice']?.status).toBe('ready');

    firstResponse.resolve(
      createResponse({
        items: [
          {
            event_id: 'event-1',
            type: 'action_started',
            occurred_at: 1_780_000_000_000,
            agent_ids: ['alice'],
            summary: {
              emoji: '🛠️',
              title: 'Cancelled StrictMode history',
              text: 'This cancelled response should not overwrite the recovered cache.',
            },
            detail: {},
          },
        ],
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getAllByText('StrictMode recovery')).toHaveLength(2);
    expect(screen.queryByText('Cancelled StrictMode history')).not.toBeInTheDocument();
    expect(store.getState().history_cache['agent:alice']?.status).toBe('ready');
  });

  it('does not refocus when polling replaces snapshot objects without geometry or selected-agent position changes', async () => {
    const store = createReadyStore();

    render(<App env={env} store={store} autoStartPolling={false} />);

    await waitFor(() => expect(screen.getByTestId('map-focus-request-count')).toHaveTextContent('1'));
    expect(screen.getByTestId('map-focus-node')).toHaveTextContent('1-2');
    expect(screen.getByTestId('map-view-state')).toHaveTextContent('144, 48 @ 1.60x');

    const refreshedSnapshot = createReadySnapshot({
      generated_at: 1_780_000_010_000,
      published_at: 1_780_000_015_000,
    });

    await act(async () => {
      store.setState(() => ({
        snapshot: refreshedSnapshot,
      }));
    });

    expect(screen.getByTestId('map-focus-request-count')).toHaveTextContent('1');
    expect(screen.getByTestId('map-focus-node')).toHaveTextContent('1-2');
    expect(screen.getByTestId('map-view-state')).toHaveTextContent('144, 48 @ 1.60x');

    const movedSnapshot = createReadySnapshot({
      generated_at: 1_780_000_020_000,
      published_at: 1_780_000_025_000,
      agents: refreshedSnapshot.agents.map((agent) =>
        agent.agent_id === 'alice' ? { ...agent, node_id: '2-2' } : agent,
      ),
    });

    await act(async () => {
      store.setState(() => ({
        snapshot: movedSnapshot,
      }));
    });

    await waitFor(() => expect(screen.getByTestId('map-focus-request-count')).toHaveTextContent('2'));
    expect(screen.getByTestId('map-focus-node')).toHaveTextContent('2-2');
    expect(screen.getByTestId('map-view-state')).toHaveTextContent('144, 144 @ 1.60x');
  });

  it('keeps the existing map view when a selected agent snapshot carries a malformed node id', async () => {
    const store = createReadyStore();
    const baselineSnapshot = createReadySnapshot();

    render(<App env={env} store={store} autoStartPolling={false} />);

    await waitFor(() => expect(screen.getByTestId('map-focus-request-count')).toHaveTextContent('1'));
    expect(screen.getByTestId('map-focus-node')).toHaveTextContent('1-2');
    expect(screen.getByTestId('map-view-state')).toHaveTextContent('144, 48 @ 1.60x');

    const malformedSnapshot = createReadySnapshot({
      generated_at: 1_780_000_030_000,
      published_at: 1_780_000_035_000,
      agents: baselineSnapshot.agents.map((agent) =>
        agent.agent_id === 'alice' ? { ...agent, node_id: 'not-a-node' } : agent,
      ) as SpectatorSnapshot['agents'],
    });

    await act(async () => {
      store.setState(() => ({
        snapshot: malformedSnapshot,
      }));
    });

    expect(screen.getByTestId('map-selection-summary')).toHaveTextContent('Alice @ not-a-node');
    expect(screen.getByTestId('map-focus-request-count')).toHaveTextContent('1');
    expect(screen.getByTestId('map-focus-node')).toHaveTextContent('1-2');
    expect(screen.getByTestId('map-view-state')).toHaveTextContent('144, 48 @ 1.60x');
  });

  it('lets map-origin selection open the shared desktop overlay and mobile detail views', async () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createReadySnapshot(),
    });

    render(<App env={env} store={store} autoStartPolling={false} />);

    fireEvent.click(screen.getByTestId('map-agent-button-bob'));

    await waitFor(() => expect(store.getState().selected_agent_id).toBe('bob'));
    expect(screen.getByTestId('desktop-agent-name')).toHaveTextContent('Bob');
    expect(screen.getByTestId('mobile-agent-state')).toHaveTextContent('待機中');
    expect(screen.getByTestId('map-selection-summary')).toHaveTextContent('Bob @ 2-1');
  });

  it('shows the mobile list panel with recent server events and the desktop-equivalent agent ordering after expanding from peek', async () => {
    const snapshot = createReadySnapshot({
      agents: [
        {
          agent_id: 'zeta',
          agent_name: 'Zeta',
          node_id: '1-1',
          state: 'idle',
          status_emoji: '💤',
        },
        {
          agent_id: 'bravo',
          agent_name: 'Bravo',
          node_id: '1-2',
          state: 'in_action',
          status_emoji: '🛠️',
        },
        {
          agent_id: 'alpha',
          agent_name: 'Alpha',
          node_id: '2-1',
          state: 'idle',
          status_emoji: '💤',
        },
        {
          agent_id: 'charlie',
          agent_name: 'Charlie',
          node_id: '2-2',
          state: 'moving',
          status_emoji: '🚶',
        },
      ],
      recent_server_events: [
        {
          server_event_id: 'event-1',
          description: 'Harvest Festival',
          occurred_at: 1_780_000_000_000,
          is_active: true,
        },
        {
          server_event_id: 'event-2',
          description: 'Market Closing Bell',
          occurred_at: 1_779_999_900_000,
          is_active: false,
        },
      ],
    });
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: snapshot,
    });

    render(<App env={env} store={store} autoStartPolling={false} />);

    fireEvent.click(screen.getByTestId('mobile-bottom-sheet-handle'));

    await waitFor(() => expect(screen.getByTestId('mobile-bottom-sheet')).toHaveAttribute('data-sheet-mode', 'list'));
    expect(screen.getByTestId('mobile-list-panel')).toBeInTheDocument();
    expect(screen.getAllByTestId('mobile-server-event-item')).toHaveLength(2);

    const buttons = within(screen.getByTestId('mobile-agent-list')).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
      expect.stringContaining('Bravo'),
      expect.stringContaining('Charlie'),
      expect.stringContaining('Alpha'),
      expect.stringContaining('Zeta'),
    ]);
  });

  it('supports mobile sheet transitions via handle taps and swipe gestures', async () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createReadySnapshot(),
    });

    render(<App env={env} store={store} autoStartPolling={false} />);

    const handle = screen.getByTestId('mobile-bottom-sheet-handle');
    expect(store.getState().mobile_sheet_mode).toBe('peek');

    fireEvent.click(handle);
    await waitFor(() => expect(store.getState().mobile_sheet_mode).toBe('list'));

    fireEvent.touchStart(handle, { touches: [{ clientY: 300 }] });
    fireEvent.touchEnd(handle, { changedTouches: [{ clientY: 200 }] });
    expect(store.getState().mobile_sheet_mode).toBe('list');

    fireEvent.click(screen.getByTestId('mobile-agent-button-alice'));
    await waitFor(() => expect(store.getState().mobile_sheet_mode).toBe('detail'));

    fireEvent.touchStart(handle, { touches: [{ clientY: 200 }] });
    fireEvent.touchEnd(handle, { changedTouches: [{ clientY: 320 }] });
    await waitFor(() => expect(store.getState().mobile_sheet_mode).toBe('list'));
    expect(store.getState().selected_agent_id).toBeUndefined();

    fireEvent.touchStart(handle, { touches: [{ clientY: 200 }] });
    fireEvent.touchEnd(handle, { changedTouches: [{ clientY: 320 }] });
    await waitFor(() => expect(store.getState().mobile_sheet_mode).toBe('peek'));
  });

  it('renders recent server events from recent_server_events while deriving active status from server_events', () => {
    const snapshot = createReadySnapshot({
      server_events: [
        {
          server_event_id: 'event-historical-flagged-active',
          description: 'Server truth says active',
          delivered_agent_ids: ['alice'],
          pending_agent_ids: ['bob'],
        },
      ],
      recent_server_events: [
        {
          server_event_id: 'event-historical-flagged-active',
          description: 'Server truth says active',
          occurred_at: 1_780_000_100_000,
          is_active: false,
        },
        {
          server_event_id: 'event-missing-from-active-list',
          description: 'Server truth says history',
          occurred_at: 1_780_000_090_000,
          is_active: true,
        },
      ],
    });

    render(
      <App
        env={env}
        store={createSnapshotStore({
          snapshotUrl: env.snapshotUrl,
          authMode: env.authMode,
          initialSnapshot: snapshot,
        })}
        autoStartPolling={false}
      />,
    );

    expect(screen.getByTestId('desktop-sidebar-server-event-count')).toHaveTextContent('未解決 1 件');
    expect(screen.getByTestId('desktop-server-event-status-event-historical-flagged-active')).toHaveTextContent('進行中');
    expect(screen.getByTestId('desktop-server-event-status-event-missing-from-active-list')).toHaveTextContent('履歴');
  });

  it('sorts agents with non-idle entries first and then by agent name', () => {
    const snapshot = createReadySnapshot({
      agents: [
        {
          agent_id: 'zeta',
          agent_name: 'Zeta',
          node_id: '1-1',
          state: 'idle',
          status_emoji: '💤',
        },
        {
          agent_id: 'bravo',
          agent_name: 'Bravo',
          node_id: '1-2',
          state: 'in_action',
          status_emoji: '🛠️',
        },
        {
          agent_id: 'alpha',
          agent_name: 'Alpha',
          node_id: '2-1',
          state: 'idle',
          status_emoji: '💤',
        },
        {
          agent_id: 'charlie',
          agent_name: 'Charlie',
          node_id: '2-2',
          state: 'moving',
          status_emoji: '🚶',
        },
      ],
    });

    render(
      <App
        env={env}
        store={createSnapshotStore({
          snapshotUrl: env.snapshotUrl,
          authMode: env.authMode,
          initialSnapshot: snapshot,
        })}
        autoStartPolling={false}
      />,
    );

    const buttons = within(screen.getByTestId('sidebar-agent-list')).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
      expect.stringContaining('Bravo'),
      expect.stringContaining('Charlie'),
      expect.stringContaining('Alpha'),
      expect.stringContaining('Zeta'),
    ]);
  });

  it('shows desktop empty states for server events and agents, and keeps stale and fetch error badges separate', () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createReadySnapshot({
        agents: [],
        server_events: [],
        recent_server_events: [],
      }),
      initialStatus: 'error',
    });

    store.setState(() => ({
      is_stale: true,
    }));

    render(<App env={env} store={store} autoStartPolling={false} />);

    const sidebar = screen.getByTestId('desktop-sidebar');
    expect(within(sidebar).getByText('サーバーイベントはまだありません')).toBeInTheDocument();
    expect(within(sidebar).getByText('エージェントが接続するとここに一覧が表示されます')).toBeInTheDocument();
    expect(screen.getByTestId('snapshot-stale-badge')).toHaveTextContent('接続遅延中');
    expect(screen.getByTestId('snapshot-error-badge')).toHaveTextContent('更新の取得に失敗しました');
  });

  it('keeps the mobile top badge and mobile snapshot status banner visible together with safe-area padding', () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createReadySnapshot(),
      initialStatus: 'error',
    });

    store.setState(() => ({
      is_stale: true,
    }));

    render(<App env={env} store={store} autoStartPolling={false} />);

    expect(screen.getByTestId('mobile-top-badge')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-snapshot-status-banner')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-snapshot-stale-badge')).toHaveTextContent('接続遅延中');
    expect(screen.getByTestId('mobile-snapshot-error-badge')).toHaveTextContent('更新の取得に失敗しました');
    expect(screen.getByTestId('mobile-top-stack')).toHaveStyle({
      paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1rem)',
    });
  });

  it('caps the mobile detail sheet to the remaining viewport height below the top stack', () => {
    const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        return this instanceof HTMLElement && this.dataset.testid === 'mobile-top-stack' ? 140 : 0;
      },
    });

    try {
      render(<App env={env} store={createReadyStore()} autoStartPolling={false} />);

      expect(screen.getByTestId('mobile-bottom-sheet')).toHaveStyle({
        maxHeight: 'calc(100dvh - 140px - env(safe-area-inset-bottom, 0px) - 1rem)',
      });
    } finally {
      Object.defineProperty(
        HTMLElement.prototype,
        'offsetHeight',
        offsetHeightDescriptor ?? {
          configurable: true,
          get() {
            return 0;
          },
        },
      );
    }
  });

  it('keeps reload guidance on the full-screen bootstrap path across retries before any snapshot exists', async () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ schema_version: 2 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(new Response('upstream failed', { status: 503 })),
    });

    render(<App env={env} store={store} autoStartPolling={false} />);

    await store.getState().poll();
    await waitFor(() => expect(store.getState().snapshot_status).toBe('incompatible'));

    await store.getState().poll();
    expect(store.getState().snapshot_status).toBe('incompatible');

    expect(screen.getByTestId('snapshot-loading-screen')).toBeInTheDocument();
    expect(screen.getByText('観戦 UI の更新が必要です。再読み込みしてください。')).toBeInTheDocument();
    expect(screen.queryByText('観戦ビューを準備しています…')).not.toBeInTheDocument();
    expect(screen.queryByText('最新スナップショットの再取得を待っています…')).not.toBeInTheDocument();
  });

  it('keeps the last good snapshot visible and shows reload guidance after incompatibility retries', async () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createFixtureSnapshot(),
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ schema_version: 2 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(new Response('upstream failed', { status: 503 })),
    });

    render(<App env={env} store={store} autoStartPolling={false} />);

    await store.getState().poll();
    await waitFor(() => expect(store.getState().snapshot_status).toBe('incompatible'));

    await store.getState().poll();
    expect(store.getState().snapshot_status).toBe('incompatible');

    expect(screen.getByTestId('desktop-shell')).toBeInTheDocument();
    expect(screen.getByTestId('snapshot-status-banner')).toBeInTheDocument();
    expect(screen.getByTestId('snapshot-incompatible-badge')).toHaveTextContent(
      '観戦 UI の更新が必要です。再読み込みしてください。',
    );
    expect(screen.getByTestId('mobile-snapshot-incompatible-badge')).toHaveTextContent(
      '観戦 UI の更新が必要です。再読み込みしてください。',
    );
    expect(screen.queryByTestId('snapshot-loading-screen')).not.toBeInTheDocument();
  });
});
