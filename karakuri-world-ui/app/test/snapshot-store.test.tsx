// @vitest-environment jsdom

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App.js';
import {
  buildAuthModeRequestInit,
  buildSnapshotRequestInit,
  createSnapshotStore,
  getHistoryRetryOptions,
  mergeHistoryResponses,
  SNAPSHOT_CONDITIONAL_FETCH_GATE,
} from '../store/snapshot-store.js';
import { createFixtureSnapshot } from './fixtures/snapshot.js';

const env = {
  snapshotUrl: 'https://snapshot.example.com/snapshot/latest.json',
  authMode: 'public' as const,
  apiBaseUrl: 'https://relay.example.com/api/history',
};

function createResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
    ...init,
  });
}

function createSnapshot(overrides: Partial<ReturnType<typeof createFixtureSnapshot>> = {}) {
  return {
    ...createFixtureSnapshot(),
    ...overrides,
  };
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

describe('snapshot store polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T09:30:00.000Z'));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        createResponse({
          items: [],
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps the full-screen loading gate until the first successful snapshot arrives after an initial fetch error', async () => {
    vi.useRealTimers();
    const snapshot = createSnapshot();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('upstream failed', { status: 503 }))
      .mockResolvedValueOnce(createResponse(snapshot));
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: fetchMock,
      pollIntervalMs: 5_000,
    });

    render(<App env={env} store={store} autoStartPolling={false} />);

    await store.getState().poll();
    expect(store.getState().snapshot_status).toBe('error');
    expect(screen.getByTestId('snapshot-loading-screen')).toBeInTheDocument();
    expect(store.getState().snapshot).toBeUndefined();

    await store.getState().poll();
    await waitFor(() => expect(store.getState().snapshot_status).toBe('ready'));
    expect(screen.queryByTestId('snapshot-loading-screen')).not.toBeInTheDocument();
    expect(screen.getByTestId('desktop-shell')).toBeInTheDocument();
  });

  it('switches browser fetch options by auth mode for both snapshot and history requests', async () => {
    expect(buildAuthModeRequestInit('public')).toEqual({});
    expect(buildAuthModeRequestInit('access')).toEqual({ credentials: 'include' });
    expect(buildSnapshotRequestInit('public')).toEqual({});
    expect(buildSnapshotRequestInit('access')).toEqual({ credentials: 'include' });
    expect(SNAPSHOT_CONDITIONAL_FETCH_GATE.enabled).toBe(false);

    const accessFetch = vi.fn<typeof fetch>().mockResolvedValue(createResponse(createSnapshot()));
    const accessStore = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: 'access',
      historyApiUrl: env.apiBaseUrl,
      fetchImpl: accessFetch,
    });

    await accessStore.getState().poll();
    await accessStore.getState().fetchHistory({ agent_id: 'alice' });

    expect(accessFetch).toHaveBeenCalledWith(
      env.snapshotUrl,
      expect.objectContaining({ credentials: 'include', signal: expect.any(AbortSignal) }),
    );
    expect(accessFetch).toHaveBeenCalledWith(
      'https://relay.example.com/api/history?agent_id=alice&limit=20',
      expect.objectContaining({ credentials: 'include', signal: expect.any(AbortSignal) }),
    );

    const publicFetch = vi.fn<typeof fetch>().mockResolvedValue(createResponse({ items: [] }));
    const publicStore = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: 'public',
      historyApiUrl: env.apiBaseUrl,
      fetchImpl: publicFetch,
    });

    await publicStore.getState().fetchHistory({ agent_id: 'alice' });

    expect(publicFetch).toHaveBeenCalledWith(
      'https://relay.example.com/api/history?agent_id=alice&limit=20',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const publicHistoryCall = publicFetch.mock.calls[0]?.[1];
    expect(publicHistoryCall).toBeDefined();
    expect(publicHistoryCall).not.toHaveProperty('credentials');
  });

  it('keeps conditional snapshot fetch gated off and treats unexpected 304 responses as transient errors', async () => {
    const snapshot = createSnapshot({ generated_at: 1_780_000_000_000, published_at: 1_780_000_005_000 });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createResponse(snapshot, {
          headers: {
            'content-type': 'application/json',
            etag: '"snapshot-v1"',
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag: '"snapshot-v1"' } }));
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: fetchMock,
    });

    await store.getState().poll();
    expect(store.getState().snapshot_status).toBe('ready');

    await store.getState().poll();

    expect(store.getState().snapshot_status).toBe('error');
    expect(store.getState().snapshot).toEqual(snapshot);
    expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty('headers');
  });

  it('marks HTTP failures and JSON parse failures as transient errors', async () => {
    const httpStore = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('nope', { status: 500 })),
      initialSnapshot: createSnapshot(),
    });

    await httpStore.getState().poll();
    expect(httpStore.getState().snapshot_status).toBe('error');
    expect(httpStore.getState().snapshot).toBeDefined();

    const parseStore = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response('{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
      initialSnapshot: createSnapshot(),
    });

    await parseStore.getState().poll();
    expect(parseStore.getState().snapshot_status).toBe('error');
  });

  it('treats schema_version mismatch as incompatible and recovers on the next valid poll', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createResponse({ schema_version: 2 }))
      .mockResolvedValueOnce(createResponse(createSnapshot()));
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: fetchMock,
      initialSnapshot: createSnapshot({ generated_at: 1_780_000_000_000, published_at: 1_780_000_005_000 }),
    });

    await store.getState().poll();
    expect(store.getState().snapshot_status).toBe('incompatible');

    await store.getState().poll();
    expect(store.getState().snapshot_status).toBe('ready');
  });

  it('preserves bootstrap incompatibility across retries until a valid snapshot is accepted', async () => {
    const snapshot = createSnapshot();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createResponse({ schema_version: 2 }))
      .mockResolvedValueOnce(new Response('upstream failed', { status: 503 }))
      .mockResolvedValueOnce(createResponse(snapshot));
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: fetchMock,
    });

    await store.getState().poll();
    expect(store.getState().snapshot_status).toBe('incompatible');
    expect(store.getState().snapshot).toBeUndefined();

    await store.getState().poll();
    expect(store.getState().snapshot_status).toBe('incompatible');
    expect(store.getState().snapshot).toBeUndefined();

    await store.getState().poll();
    expect(store.getState().snapshot_status).toBe('ready');
    expect(store.getState().snapshot).toEqual(snapshot);
  });

  it('preserves incompatible status after a cached snapshot becomes incompatible until a valid snapshot is accepted', async () => {
    const current = createSnapshot({ generated_at: 1_780_000_000_000, published_at: 1_780_000_005_000 });
    const next = createSnapshot({ generated_at: 1_780_000_010_000, published_at: 1_780_000_015_000 });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createResponse({ schema_version: 2 }))
      .mockResolvedValueOnce(new Response('upstream failed', { status: 503 }))
      .mockResolvedValueOnce(createResponse(next));
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: fetchMock,
      initialSnapshot: current,
    });

    await store.getState().poll();
    expect(store.getState().snapshot_status).toBe('incompatible');
    expect(store.getState().snapshot).toEqual(current);

    await store.getState().poll();
    expect(store.getState().snapshot_status).toBe('incompatible');
    expect(store.getState().snapshot).toEqual(current);

    await store.getState().poll();
    expect(store.getState().snapshot_status).toBe('ready');
    expect(store.getState().snapshot).toEqual(next);
  });

  it('validates schema_version before version comparison', async () => {
    const current = createSnapshot({ generated_at: 2_000, published_at: 3_000 });
    const olderButIncompatible = { ...createSnapshot({ generated_at: 1_000, published_at: 1_500 }), schema_version: 2 };
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(createResponse(olderButIncompatible)),
      initialSnapshot: current,
    });

    await store.getState().poll();

    expect(store.getState().snapshot_status).toBe('incompatible');
    expect(store.getState().snapshot).toEqual(current);
  });

  it('ignores older responses and keeps snapshot version monotonic', async () => {
    const current = createSnapshot({ generated_at: 2_000, published_at: 2_100 });
    const older = createSnapshot({ generated_at: 1_000, published_at: 1_100 });
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(createResponse(older)),
      initialSnapshot: current,
    });

    const lastSuccessAt = store.getState().last_success_at;
    await store.getState().poll();

    expect(store.getState().snapshot).toEqual(current);
    expect(store.getState().snapshot_status).toBe('ready');
    expect(store.getState().last_success_at).toBe(lastSuccessAt);
  });

  it('recovers from fetch error when the same snapshot version succeeds again', async () => {
    const now = Date.now();
    const current = createSnapshot({ generated_at: now - 10_000, published_at: now - 9_000 });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockResolvedValueOnce(createResponse(current));
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: fetchMock,
      initialSnapshot: current,
    });

    await store.getState().poll();
    expect(store.getState().snapshot_status).toBe('error');

    await store.getState().poll();
    expect(store.getState().snapshot_status).toBe('ready');
    expect(store.getState().snapshot).toEqual(current);
  });

  it('preserves static map references for new-object live-only poll snapshots', async () => {
    const current = createSnapshot();
    const next = createSnapshot({
      agents: current.agents.map((agent) =>
        agent.agent_id === 'alice'
          ? {
              ...agent,
              node_id: '2-2',
            }
          : agent,
      ),
      published_at: current.published_at + 1,
    });
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(createResponse(next)),
      initialSnapshot: current,
    });

    const initialMap = store.getState().snapshot!.map;
    const initialTheme = store.getState().snapshot!.map_render_theme;

    await store.getState().poll();

    const updatedSnapshot = store.getState().snapshot!;
    expect(updatedSnapshot).not.toBe(current);
    expect(updatedSnapshot.agents.find((agent) => agent.agent_id === 'alice')?.node_id).toBe('2-2');
    expect(updatedSnapshot.map).toBe(initialMap);
    expect(updatedSnapshot.map_render_theme).toBe(initialTheme);
  });

  it('marks stale from generated_at and does not clear it with fetch-success time alone', async () => {
    const baseNow = Date.now();
    const current = createSnapshot({ generated_at: baseNow - 50_000, published_at: baseNow - 45_000 });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(createResponse(current));
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: fetchMock,
      initialSnapshot: current,
    });

    expect(store.getState().is_stale).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(10_001);
    });
    expect(store.getState().is_stale).toBe(true);

    vi.setSystemTime(new Date(baseNow + 12_000));
    await store.getState().poll();
    expect(store.getState().snapshot_status).toBe('ready');
    expect(store.getState().is_stale).toBe(true);
  });

  it('re-evaluates stale state immediately when polling restarts with an existing snapshot', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const current = createSnapshot({ generated_at: Date.now(), published_at: Date.now() + 1_000 });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: fetchMock,
      staleAfterMs: 10_000,
      initialSnapshot: current,
    });

    store.getState().stopPolling();

    await act(async () => {
      vi.advanceTimersByTime(10_001);
    });
    expect(store.getState().is_stale).toBe(false);

    const startPollingPromise = store.getState().startPolling();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.getState().is_stale).toBe(true);

    resolveFetch?.(createResponse(current));
    await startPollingPromise;
  });

  it('keeps the interval active during a slow initial poll and collapses overlap to one trailing poll', async () => {
    const firstFetch = createDeferredResponse();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstFetch.promise)
      .mockResolvedValueOnce(createResponse(createSnapshot({ generated_at: Date.now() + 5_000, published_at: Date.now() + 6_000 })));
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: fetchMock,
      pollIntervalMs: 5_000,
    });

    const startPollingPromise = store.getState().startPolling();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    firstFetch.resolve(createResponse(createSnapshot()));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    await startPollingPromise;
  });

  it('queues at most one trailing poll while a request is in flight', async () => {
    vi.useRealTimers();
    let resolveFirstFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirstFetch = resolve;
          }),
      )
      .mockResolvedValueOnce(
        createResponse(createSnapshot({ generated_at: 1_780_000_010_000, published_at: 1_780_000_015_000 })),
      );
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: fetchMock,
    });

    const firstPoll = store.getState().poll();
    const secondPoll = store.getState().poll();
    const thirdPoll = store.getState().poll();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFirstFetch?.(createResponse(createSnapshot()));
    await firstPoll;
    await secondPoll;
    await thirdPoll;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('times out a hung fetch so later polls can recover', async () => {
    let firstSignal: AbortSignal | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce((_, init) => {
        firstSignal = init?.signal ?? undefined;
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              reject(new DOMException(String(init.signal?.reason ?? 'aborted'), 'AbortError'));
            },
            { once: true },
          );
        });
      })
      .mockResolvedValueOnce(createResponse(createSnapshot()));
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: fetchMock,
      fetchTimeoutMs: 250,
    });

    const firstPoll = store.getState().poll();
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
    });
    await firstPoll;

    expect(firstSignal?.aborted).toBe(true);
    expect(firstSignal?.reason).toBe('snapshot-poll-timeout');
    expect(store.getState().snapshot_status).toBe('error');

    await store.getState().poll();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getState().snapshot_status).toBe('ready');
  });

  it('does not recreate intervals, queued polls, or stale timers after stop and restart races', async () => {
    let resolveSecondFetch: ((response: Response) => void) | undefined;
    const firstSnapshot = createSnapshot({ generated_at: Date.now(), published_at: Date.now() + 1_000 });
    const secondSnapshot = createSnapshot({ generated_at: Date.now() + 2_000, published_at: Date.now() + 3_000 });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        (_, init) =>
          new Promise<Response>((resolve) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                resolve(createResponse(firstSnapshot));
              },
              { once: true },
            );
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveSecondFetch = resolve;
          }),
      );
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: fetchMock,
      pollIntervalMs: 5_000,
      staleAfterMs: 10_000,
    });

    const firstStart = store.getState().startPolling();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    store.getState().stopPolling();
    const secondStart = store.getState().startPolling();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveSecondFetch?.(createResponse(secondSnapshot));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await firstStart;
    await secondStart;

    expect(store.getState().snapshot).toEqual(secondSnapshot);
    expect(store.getState().snapshot_status).toBe('ready');

    store.getState().stopPolling();

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getState().is_stale).toBe(false);
  });

  it('keeps the interval active during a slow restarted poll and queues one immediate follow-up', async () => {
    const initialSnapshot = createSnapshot({ generated_at: Date.now(), published_at: Date.now() + 1_000 });
    const firstFetch = createDeferredResponse();
    const restartedFetch = createDeferredResponse();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce((_, init) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            firstFetch.resolve(createResponse(initialSnapshot));
          },
          { once: true },
        );
        return firstFetch.promise;
      })
      .mockImplementationOnce(() => restartedFetch.promise)
      .mockResolvedValueOnce(
        createResponse(createSnapshot({ generated_at: Date.now() + 10_000, published_at: Date.now() + 11_000 })),
      );
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      fetchImpl: fetchMock,
      pollIntervalMs: 5_000,
      initialSnapshot,
    });

    const firstStart = store.getState().startPolling();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    store.getState().stopPolling();
    await firstStart;

    const secondStart = store.getState().startPolling();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    restartedFetch.resolve(createResponse(createSnapshot({ generated_at: Date.now() + 5_000, published_at: Date.now() + 6_000 })));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);

    await secondStart;
  });

  it('opens mobile detail automatically when selecting an agent and initializes selected stores in detail mode', () => {
    const initialSelectedStore = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createSnapshot(),
      initialSelectedAgentId: 'alice',
    });

    expect(initialSelectedStore.getState().mobile_sheet_mode).toBe('detail');
    expect(initialSelectedStore.getState().selected_agent_revision).toBe(1);

    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createSnapshot(),
    });

    expect(store.getState().mobile_sheet_mode).toBe('peek');
    expect(store.getState().selected_agent_revision).toBe(0);

    store.getState().setSelectedAgentId('alice');

    expect(store.getState().selected_agent_id).toBe('alice');
    expect(store.getState().selected_agent_revision).toBe(1);
    expect(store.getState().mobile_sheet_mode).toBe('detail');

    store.getState().setSelectedAgentId('alice');

    expect(store.getState().selected_agent_revision).toBe(2);
  });

  it('clears selected_agent_id when mobile detail closes and blocks detail without a selection', () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createSnapshot(),
      initialSelectedAgentId: 'alice',
    });

    store.getState().setMobileSheetMode('list');

    expect(store.getState().mobile_sheet_mode).toBe('list');
    expect(store.getState().selected_agent_id).toBeUndefined();

    store.getState().setMobileSheetMode('detail');
    expect(store.getState().mobile_sheet_mode).toBe('list');

    store.getState().setSelectedAgentId('bob');
    expect(store.getState().mobile_sheet_mode).toBe('detail');

    store.getState().setSelectedAgentId(undefined);
    expect(store.getState().selected_agent_id).toBeUndefined();
    expect(store.getState().selected_agent_revision).toBe(3);
    expect(store.getState().mobile_sheet_mode).toBe('list');
  });

  it('reconciles vanished selections when adopting a newer snapshot', async () => {
    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      initialSnapshot: createSnapshot(),
      initialSelectedAgentId: 'alice',
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        createResponse(
          createSnapshot({
            agents: [
              {
                agent_id: 'bob',
                agent_name: 'Bob',
                node_id: '2-1',
                state: 'idle',
                status_emoji: '💤',
              },
            ],
            generated_at: 1_780_000_010_000,
            published_at: 1_780_000_015_000,
          }),
        ),
      ),
    });

    expect(store.getState().selected_agent_id).toBe('alice');
    expect(store.getState().mobile_sheet_mode).toBe('detail');

    await store.getState().poll();

    expect(store.getState().selected_agent_id).toBeUndefined();
    expect(store.getState().mobile_sheet_mode).toBe('list');
    expect(store.getState().snapshot?.agents.map((agent) => agent.agent_id)).toEqual(['bob']);
  });

  it('merges appended history pages with event dedupe and descending order', () => {
    const merged = mergeHistoryResponses(
      {
        items: [
          {
            event_id: 'event-3',
            type: 'action_completed',
            occurred_at: 300,
            agent_ids: ['alice'],
            summary: { emoji: '✅', title: 'Newest', text: 'Newest event' },
            detail: {},
          },
          {
            event_id: 'event-2',
            type: 'action_started',
            occurred_at: 200,
            agent_ids: ['alice'],
            summary: { emoji: '🛠️', title: 'Middle', text: 'Middle event' },
            detail: {},
          },
        ],
        next_cursor: 'cursor-1',
      },
      {
        items: [
          {
            event_id: 'event-2',
            type: 'action_started',
            occurred_at: 200,
            agent_ids: ['alice'],
            summary: { emoji: '🛠️', title: 'Middle duplicate', text: 'Duplicate middle event' },
            detail: {},
          },
          {
            event_id: 'event-1',
            type: 'movement_started',
            occurred_at: 100,
            agent_ids: ['alice'],
            summary: { emoji: '🚶', title: 'Oldest', text: 'Oldest event' },
            detail: {},
          },
        ],
        next_cursor: 'cursor-2',
      },
    );

    expect(merged.items.map((item) => item.event_id)).toEqual(['event-3', 'event-2', 'event-1']);
    expect(merged.next_cursor).toBe('cursor-2');
  });

  it('preserves cached history and cursor state when an append request fails', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('upstream failed', { status: 503 })));

    const store = createSnapshotStore({
      snapshotUrl: env.snapshotUrl,
      authMode: env.authMode,
      historyApiUrl: env.apiBaseUrl,
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
          last_fetched_at: 1_780_000_000_000,
          response: {
            items: [
              {
                event_id: 'event-2',
                type: 'action_completed',
                occurred_at: 200,
                agent_ids: ['alice'],
                summary: { emoji: '✅', title: 'Craft complete', text: 'Alice finished crafting.' },
                detail: {},
              },
            ],
            next_cursor: 'cursor-1',
          },
        },
      },
    }));

    await store.getState().fetchHistory({ agent_id: 'alice' }, { cursor: 'cursor-1', merge: 'append' });

    const entry = store.getState().history_cache['agent:alice'];
    expect(entry?.status).toBe('error');
    expect(entry && entry.status !== 'idle' ? entry.request : undefined).toEqual({
      cursor: 'cursor-1',
      limit: 20,
      merge: 'append',
    });
    expect(entry && 'response' in entry ? entry.response?.items.map((item) => item.event_id) : []).toEqual(['event-2']);
    expect(entry && 'response' in entry ? entry.response?.next_cursor : undefined).toBe('cursor-1');
    expect(entry && 'last_fetched_at' in entry ? entry.last_fetched_at : undefined).toBe(1_780_000_000_000);
    expect(getHistoryRetryOptions(entry)).toEqual({
      cursor: 'cursor-1',
      limit: 20,
      merge: 'append',
    });
  });
});
