import { describe, expect, it, vi } from 'vitest';

import relayWorker, { PRIMARY_BRIDGE_NAME, UIBridgeDurableObject } from '../src/index.js';
import { decodeSpectatorSnapshot } from '../src/contracts/snapshot-serializer.js';
import type {
  D1DatabaseLike,
  DurableObjectStateLike,
  RelayBindings,
  RelayFetchResponse,
  RelayWebSocketCloseEvent,
  RelayWebSocket,
} from '../src/relay/bridge.js';
import { parseSocketPayload } from '../src/relay/bridge.js';

class FakeWebSocket implements RelayWebSocket {
  private readonly messageListeners: Array<(event: { data: unknown }) => void> = [];
  private readonly closeListeners: Array<(event: RelayWebSocketCloseEvent) => void> = [];
  private readonly errorListeners: Array<(event: unknown) => void> = [];
  private readonly bufferedMessages: unknown[] = [];

  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: RelayWebSocketCloseEvent) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: ((event: { data: unknown }) => void) | ((event: RelayWebSocketCloseEvent) => void) | ((event: unknown) => void),
  ): void {
    if (type === 'message') {
      this.messageListeners.push(listener as (event: { data: unknown }) => void);
      while (this.bufferedMessages.length > 0) {
        listener({ data: this.bufferedMessages.shift() });
      }
      return;
    }

    if (type === 'close') {
      this.closeListeners.push(listener as (event: unknown) => void);
      return;
    }

    this.errorListeners.push(listener as (event: unknown) => void);
  }

  emitMessage(payload: unknown): void {
    this.emitRawMessage(JSON.stringify(payload));
  }

  emitRawMessage(data: unknown): void {
    if (this.messageListeners.length === 0) {
      this.bufferedMessages.push(data);
      return;
    }

    const event = { data };

    for (const listener of this.messageListeners) {
      listener(event);
    }
  }

  emitClose(event: RelayWebSocketCloseEvent = { reason: 'server closed connection' }): void {
    for (const listener of this.closeListeners) {
      listener(event);
    }
  }

  emitError(): void {
    for (const listener of this.errorListeners) {
      listener({ type: 'error' });
    }
  }
}

class FakeDurableObjectState implements DurableObjectStateLike {
  readonly alarmCalls: number[] = [];
  private currentAlarm: number | null = null;
  private readonly values = new Map<string, unknown>();

  readonly storage = {
    getAlarm: async () => this.currentAlarm,
    setAlarm: async (scheduledTime: number) => {
      this.currentAlarm = scheduledTime;
      this.alarmCalls.push(scheduledTime);
    },
    get: async <T>(key: string) => this.values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      this.values.set(key, value);
    },
    delete: async (key: string) => {
      this.values.delete(key);
    },
  };

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }

  getStoredValue<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
}

function createWorldSnapshot(generatedAt = 1_750_000_000_000) {
  return {
    world: {
      name: 'Karakuri World',
      description: 'Relay bootstrap test fixture',
    },
    calendar: {
      timezone: 'Asia/Tokyo',
      local_date: '2026-06-15',
      local_time: '12:04:05',
      season: 'summer' as const,
      season_label: '夏' as const,
      day_in_season: 15,
      display_label: '夏・15日目',
    },
    map: {
      rows: 1,
      cols: 1,
      nodes: {
        '1-1': {
          type: 'normal' as const,
          label: 'Square',
        },
      },
      buildings: [
        {
          building_id: 'kitchen',
          name: 'Kitchen',
          description: 'Test kitchen',
          wall_nodes: [],
          interior_nodes: ['1-1' as const],
          door_nodes: [],
          actions: [
            {
              action_id: 'cook',
              name: 'Cook',
              emoji: '🍳',
            },
          ],
        },
      ],
      npcs: [],
    },
    map_render_theme: {
      cell_size: 96,
      label_font_size: 14,
      node_id_font_size: 12,
      background_fill: '#e2e8f0',
      grid_stroke: '#94a3b8',
      default_node_fill: '#bbf7d0',
      normal_node_fill: '#f8fafc',
      wall_node_fill: '#334155',
      door_node_fill: '#b45309',
      npc_node_fill: '#fde68a',
      building_palette: ['#dbeafe'],
      wall_text_color: '#f8fafc',
      default_text_color: '#0f172a',
    },
    agents: [
      {
        agent_id: 'alice',
        agent_name: 'Alice',
        node_id: '1-1' as const,
        state: 'idle' as const,
        discord_channel_id: 'discord-channel-1',
        money: 500,
        items: [],
        status_emoji: '🙂',
      },
    ],
    conversations: [
      {
        conversation_id: 'conv-1',
        status: 'active' as const,
        participant_agent_ids: ['alice', 'bob'],
        current_speaker_agent_id: 'alice',
        current_turn: 2,
        initiator_agent_id: 'alice',
      },
    ],
    server_events: [],
    generated_at: generatedAt,
  };
}

function createJsonResponse(payload: unknown, status = 200) {
  return {
    status,
    json: async () => payload,
  };
}

function createWebSocketUpgradeResponse(socket: FakeWebSocket) {
  return {
    status: 101,
    webSocket: socket,
  };
}

type FetchMockStep = RelayFetchResponse | (() => RelayFetchResponse | Promise<RelayFetchResponse>);

function createRelayFetchMock({
  websocketResponses,
  snapshotResponses = [createJsonResponse(createWorldSnapshot())],
}: {
  websocketResponses: FetchMockStep[];
  snapshotResponses?: FetchMockStep[];
}) {
  const websocketQueue = [...websocketResponses];
  const snapshotQueue = [...snapshotResponses];

  return vi.fn(async (input: Request | string | URL) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
    const isWebSocketRequest = url.endsWith('/ws');
    const queue = isWebSocketRequest ? websocketQueue : snapshotQueue;
    const next = queue.shift();

    if (next === undefined) {
      if (!isWebSocketRequest) {
        return createJsonResponse(createWorldSnapshot());
      }

      throw new Error(`Unexpected websocket fetch: ${url}`);
    }

    const response = typeof next === 'function' ? await next() : next;

    return response;
  });
}

interface SnapshotPublishCall {
  key: string;
  body: string;
  options: {
    httpMetadata?: {
      contentType?: string;
      cacheControl?: string;
    };
    customMetadata?: Record<string, string>;
  };
}

interface MetricCall {
  kind: 'counter' | 'gauge';
  name: string;
  value: number;
  tags?: Record<string, string>;
}

interface LogCall {
  level: 'info' | 'warn' | 'error';
  message: string;
  context?: Record<string, unknown>;
}

function createObservabilitySpy() {
  const metrics: MetricCall[] = [];
  const logs: LogCall[] = [];

  return {
    metrics,
    logs,
    observer: {
      counter(name: string, tags?: Record<string, string>, value = 1) {
        metrics.push({ kind: 'counter', name, value, ...(tags ? { tags } : {}) });
      },
      gauge(name: string, value: number, tags?: Record<string, string>) {
        metrics.push({ kind: 'gauge', name, value, ...(tags ? { tags } : {}) });
      },
      log(level: 'info' | 'warn' | 'error', message: string, context?: Record<string, unknown>) {
        logs.push({ level, message, ...(context ? { context } : {}) });
      },
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

function createHistoryDb(rows: unknown[]): D1DatabaseLike {
  return {
    prepare: () => ({
      all: async () => ({
        results: rows,
      }),
    }),
  };
}

function createFailingHistoryDb(message: string): D1DatabaseLike {
  return {
    prepare: () => ({
      all: async () => {
        throw new Error(message);
      },
    }),
  };
}

describe('relay bootstrap', () => {
  it('boots the durable object, restores recent server events, and initializes snapshot state from the first websocket snapshot', async () => {
    const now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [createWebSocketUpgradeResponse(socket)],
    });
    const env: RelayBindings = {
      KW_BASE_URL: 'http://127.0.0.1:3000',
      KW_ADMIN_KEY: 'test-admin-key',
      HISTORY_DB: createHistoryDb([
        {
          server_event_id: 'event-2',
          description: 'Late arrival',
          occurred_at: 1_750_000_020_000,
        },
        {
          server_event_id: 'event-1',
          description: 'Harvest Festival',
          occurred_at: 1_750_000_010_000,
        },
      ]),
    };

    const bridge = new UIBridgeDurableObject(state, env, {
      fetchImpl,
      now: () => now,
    });

    await bridge.whenBooted();
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:3000/api/snapshot',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Admin-Key': 'test-admin-key',
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'ws://127.0.0.1:3000/ws',
      expect.objectContaining({
        headers: expect.objectContaining({
          Upgrade: 'websocket',
          'X-Admin-Key': 'test-admin-key',
        }),
      }),
    );
    expect(bridge.getDebugState().recent_server_events).toEqual([
      {
        server_event_id: 'event-2',
        description: 'Late arrival',
        occurred_at: 1_750_000_020_000,
        is_active: false,
      },
      {
        server_event_id: 'event-1',
        description: 'Harvest Festival',
        occurred_at: 1_750_000_010_000,
        is_active: false,
      },
    ]);
    await vi.waitFor(() => {
      expect(bridge.getDebugState().latest_snapshot).toMatchObject({
        published_at: now,
      });
    });

    const debugState = bridge.getDebugState();

    expect(debugState.latest_snapshot).toMatchObject({
      schema_version: 1,
      generated_at: 1_750_000_000_000,
      published_at: now,
      recent_server_events: [
        {
          server_event_id: 'event-2',
          description: 'Late arrival',
          occurred_at: 1_750_000_020_000,
          is_active: false,
        },
        {
          server_event_id: 'event-1',
          description: 'Harvest Festival',
          occurred_at: 1_750_000_010_000,
          is_active: false,
        },
      ],
    });
    expect(debugState.last_refresh_at).toBe(now);
    expect(debugState.conversations).toEqual({
      'conv-1': {
        conversation_id: 'conv-1',
        status: 'active',
        participant_agent_ids: ['alice', 'bob'],
        initiator_agent_id: 'alice',
        current_speaker_agent_id: 'alice',
        updated_at: now,
      },
    });
    expect(debugState.publish_alarm_at).toBeUndefined();
    expect(debugState.heartbeat_alarm_at).toBe(now + 30_000);
    expect(state.alarmCalls).toContain(now + 30_000);
  });

  it('routes worker requests through the singleton durable object namespace', async () => {
    const forwardedResponse = new Response('ok');
    const stub = {
      fetch: vi.fn(async () => forwardedResponse),
    };
    const namespace = {
      idFromName: vi.fn(() => ({ id: 'primary-id' })),
      get: vi.fn(() => stub),
    };

    const response = await relayWorker.fetch(new Request('https://relay.example.com/internal'), {
      UI_BRIDGE: namespace,
    } as never);

    expect(namespace.idFromName).toHaveBeenCalledWith(PRIMARY_BRIDGE_NAME);
    expect(namespace.get).toHaveBeenCalledTimes(1);
    expect(stub.fetch).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe('ok');
  });

  it('ignores non-JSON websocket frames without crashing the bridge state', async () => {
    const now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl: createRelayFetchMock({
          websocketResponses: [createWebSocketUpgradeResponse(socket)],
        }),
        now: () => now,
      },
    );

    await bridge.whenBooted();

    socket.emitRawMessage('not-json');
    socket.emitRawMessage(new Uint8Array([0xff, 0xfe, 0xfd]));

    expect(bridge.getDebugState()).toMatchObject({
      recent_server_events: [],
      conversations: {},
    });
    expect(bridge.getDebugState().latest_snapshot).toMatchObject({
      generated_at: 1_750_000_000_000,
    });
  });

  it('drops malformed snapshot frames before they can mutate bridge state', async () => {
    const now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl: createRelayFetchMock({
          websocketResponses: [createWebSocketUpgradeResponse(socket)],
        }),
        now: () => now,
      },
    );

    await bridge.whenBooted();

    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(),
    });

    const beforeInvalidFrame = bridge.getDebugState();

    expect(() => {
      socket.emitRawMessage(JSON.stringify({ type: 'snapshot', data: 42 }));
    }).not.toThrow();

    expect(bridge.getDebugState()).toEqual(beforeInvalidFrame);
  });

  it('refreshes snapshot state when a valid websocket event frame arrives', async () => {
    const now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [createWebSocketUpgradeResponse(socket)],
      snapshotResponses: [
        createJsonResponse(createWorldSnapshot()),
        createJsonResponse(createWorldSnapshot(1_750_000_090_000)),
      ],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl,
        now: () => now,
        random: () => 0.5,
      },
    );

    await bridge.whenBooted();

    socket.emitMessage({
      type: 'event',
      data: {
        event_id: 'event-1',
        type: 'action_completed',
        occurred_at: 1_750_000_060_000,
        agent_id: 'alice',
        agent_name: 'Alice',
        action_id: 'cook',
        action_name: 'Cook',
      },
    });

    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(bridge.getDebugState().latest_snapshot?.generated_at).toBe(1_750_000_090_000);
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:3000/api/snapshot',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Admin-Key': 'test-admin-key',
        }),
      }),
    );
    expect(bridge.getDebugState()).toMatchObject({
      last_event_at: 1_750_000_060_000,
      last_refresh_at: now,
      latest_snapshot: expect.objectContaining({
        generated_at: 1_750_000_090_000,
      }),
    });
  });

  it('discards stale async refresh results after a newer websocket snapshot lands', async () => {
    const now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const refreshDeferred = createDeferred<ReturnType<typeof createJsonResponse>>();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [createWebSocketUpgradeResponse(socket)],
      snapshotResponses: [createJsonResponse(createWorldSnapshot()), async () => refreshDeferred.promise],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl,
        now: () => now,
        random: () => 0.5,
      },
    );

    await bridge.whenBooted();
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(1_750_000_000_000),
    });
    socket.emitMessage({
      type: 'event',
      data: {
        event_id: 'event-1',
        type: 'action_completed',
        occurred_at: 1_750_000_060_000,
        agent_id: 'alice',
        agent_name: 'Alice',
        action_id: 'cook',
        action_name: 'Cook',
      },
    });

    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(1_750_000_120_000),
    });

    await vi.waitFor(() => {
      expect(bridge.getDebugState().latest_snapshot?.generated_at).toBe(1_750_000_120_000);
    });

    refreshDeferred.resolve(createJsonResponse(createWorldSnapshot(1_750_000_090_000)));

    await vi.waitFor(() => {
      expect(bridge.getDebugState().latest_snapshot?.generated_at).toBe(1_750_000_120_000);
    });

    expect(bridge.getDebugState()).toMatchObject({
      last_event_at: 1_750_000_060_000,
      last_refresh_at: now,
      latest_snapshot: expect.objectContaining({
        generated_at: 1_750_000_120_000,
      }),
    });
  });

  it('preserves the existing heartbeat schedule when a world event refresh fails', async () => {
    const now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [createWebSocketUpgradeResponse(socket)],
      snapshotResponses: [createJsonResponse(createWorldSnapshot()), createJsonResponse({ invalid: true })],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl,
        now: () => now,
        random: () => 0.5,
      },
    );

    await bridge.whenBooted();

    const heartbeatAlarmAt = bridge.getDebugState().heartbeat_alarm_at;

    socket.emitMessage({
      type: 'event',
      data: {
        event_id: 'event-1',
        type: 'action_completed',
        occurred_at: 1_750_000_060_000,
        agent_id: 'alice',
        agent_name: 'Alice',
        action_id: 'cook',
        action_name: 'Cook',
      },
    });

    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    expect(bridge.getDebugState()).toMatchObject({
      last_event_at: 1_750_000_060_000,
      last_refresh_at: now,
      heartbeat_alarm_at: heartbeatAlarmAt,
      heartbeat_failure_streak: 0,
      latest_snapshot: {
        generated_at: 1_750_000_000_000,
        published_at: now,
      },
    });
    expect(state.alarmCalls.at(-1)).toBe(now + 30_000);
  });

  it('merges server_event_fired frames into recent server events before refreshing', async () => {
    const now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [createWebSocketUpgradeResponse(socket)],
      snapshotResponses: [
        createJsonResponse(createWorldSnapshot()),
        createJsonResponse({
          ...createWorldSnapshot(1_750_000_090_000),
          server_events: [
            {
              server_event_id: 'festival',
              description: 'Harvest Festival',
              delivered_agent_ids: ['alice'],
              pending_agent_ids: [],
            },
          ],
        }),
      ],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
        HISTORY_DB: createHistoryDb([
          {
            server_event_id: 'event-1',
            description: 'Late arrival',
            occurred_at: 1_750_000_020_000,
          },
        ]),
      },
      {
        fetchImpl,
        now: () => now,
      },
    );

    await bridge.whenBooted();

    socket.emitMessage({
      type: 'event',
      data: {
        event_id: 'event-2',
        type: 'server_event_fired',
        occurred_at: 1_750_000_060_000,
        server_event_id: 'festival',
        description: 'Harvest Festival',
        delivered_agent_ids: ['alice'],
        pending_agent_ids: [],
        delayed: false,
      },
    });

    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(bridge.getDebugState().latest_snapshot?.recent_server_events).toEqual([
        {
          server_event_id: 'festival',
          description: 'Harvest Festival',
          occurred_at: 1_750_000_060_000,
          is_active: true,
        },
        {
          server_event_id: 'event-1',
          description: 'Late arrival',
          occurred_at: 1_750_000_020_000,
          is_active: false,
        },
      ]);
    });

    expect(bridge.getDebugState().recent_server_events).toEqual([
      {
        server_event_id: 'festival',
        description: 'Harvest Festival',
        occurred_at: 1_750_000_060_000,
        is_active: true,
      },
      {
        server_event_id: 'event-1',
        description: 'Late arrival',
        occurred_at: 1_750_000_020_000,
        is_active: false,
      },
    ]);
    expect(bridge.getDebugState().latest_snapshot?.recent_server_events).toEqual([
      {
        server_event_id: 'festival',
        description: 'Harvest Festival',
        occurred_at: 1_750_000_060_000,
        is_active: true,
      },
      {
        server_event_id: 'event-1',
        description: 'Late arrival',
        occurred_at: 1_750_000_020_000,
        is_active: false,
      },
    ]);
  });

  it('still refreshes snapshots when persistWorldEvent fails without mutating the live mirror', async () => {
    const now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const persistWorldEvent = vi.fn(async () => {
      throw new Error('D1 write failed');
    });
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [createWebSocketUpgradeResponse(socket)],
      snapshotResponses: [
        createJsonResponse(createWorldSnapshot()),
        createJsonResponse(createWorldSnapshot(1_750_000_090_000)),
      ],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl,
        now: () => now,
        persistWorldEvent,
      },
    );

    await bridge.whenBooted();

    socket.emitMessage({
      type: 'event',
      data: {
        event_id: 'event-1',
        type: 'server_event_fired',
        occurred_at: 1_750_000_060_000,
        server_event_id: 'festival',
        description: 'Harvest Festival',
        delivered_agent_ids: ['alice'],
        pending_agent_ids: [],
        delayed: false,
      },
    });

    await vi.waitFor(() => {
      expect(persistWorldEvent).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    expect(bridge.getDebugState().last_event_at).toBeUndefined();
    expect(bridge.getDebugState()).toMatchObject({
      recent_server_events: [],
      latest_snapshot: {
        generated_at: 1_750_000_090_000,
        recent_server_events: [],
      },
    });
  });

  it('deduplicates delayed server_event_fired replays without changing stored ordering', async () => {
    const now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [createWebSocketUpgradeResponse(socket)],
      snapshotResponses: [
        createJsonResponse(createWorldSnapshot()),
        createJsonResponse(createWorldSnapshot(1_750_000_090_000)),
      ],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
        HISTORY_DB: createHistoryDb([
          {
            server_event_id: 'festival',
            description: 'Harvest Festival',
            occurred_at: 1_750_000_010_000,
          },
          {
            server_event_id: 'event-1',
            description: 'Late arrival',
            occurred_at: 1_750_000_005_000,
          },
        ]),
      },
      {
        fetchImpl,
        now: () => now,
      },
    );

    await bridge.whenBooted();

    socket.emitMessage({
      type: 'event',
      data: {
        event_id: 'event-3',
        type: 'server_event_fired',
        occurred_at: 1_750_000_060_000,
        server_event_id: 'festival',
        description: 'Harvest Festival (delayed)',
        delivered_agent_ids: [],
        pending_agent_ids: ['alice'],
        delayed: true,
      },
    });

    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(bridge.getDebugState().recent_server_events).toEqual([
        {
          server_event_id: 'festival',
          description: 'Harvest Festival',
          occurred_at: 1_750_000_010_000,
          is_active: false,
        },
        {
          server_event_id: 'event-1',
          description: 'Late arrival',
          occurred_at: 1_750_000_005_000,
          is_active: false,
        },
      ]);
    });
  });

  it('drops unsupported or incomplete event frames before dispatch', () => {
    expect(
      parseSocketPayload(
        JSON.stringify({
          type: 'event',
          data: {
            event_id: 'event-1',
            type: 'idle_reminder_fired',
            occurred_at: 1_750_000_010_000,
            agent_id: 'alice',
            agent_name: 'Alice',
            idle_since: 1_750_000_000_000,
          },
        }),
      ),
    ).toBeNull();

    expect(
      parseSocketPayload(
        JSON.stringify({
          type: 'event',
          data: {
            event_id: 'event-2',
            type: 'conversation_message',
            occurred_at: 1_750_000_010_001,
            conversation_id: 'conv-1',
            speaker_agent_id: 'alice',
            message: 'hello',
          },
        }),
      ),
    ).toBeNull();

    expect(
      parseSocketPayload(
        JSON.stringify({
          type: 'event',
          data: {
            event_id: 'event-3',
            type: 'server_event_fired',
            occurred_at: 1_750_000_010_002,
            server_event_id: 'festival',
            description: 'Harvest Festival',
            delivered_agent_ids: ['alice'],
            pending_agent_ids: [],
            delayed: false,
          },
        }),
      ),
    ).toEqual({
      type: 'event',
      data: {
        event_id: 'event-3',
        type: 'server_event_fired',
        occurred_at: 1_750_000_010_002,
        server_event_id: 'festival',
        description: 'Harvest Festival',
        delivered_agent_ids: ['alice'],
        pending_agent_ids: [],
        delayed: false,
      },
    });
  });

  it('anchors heartbeat scheduling to the last successful refresh time', async () => {
    let now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl: vi.fn(async () => ({
          status: 101,
          webSocket: socket,
        })),
        now: () => now,
      },
    );

    await bridge.whenBooted();

    const internals = bridge as unknown as {
      getDebugState(): { heartbeat_alarm_at?: number; last_refresh_at?: number };
      scheduleHeartbeat(): Promise<void>;
    };

    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(),
    });
    now += 45_000;

    await internals.scheduleHeartbeat();

    const debugState = internals.getDebugState();
    expect(debugState.last_refresh_at).toBe(1_750_000_050_000);
    expect(debugState.heartbeat_alarm_at).toBe(1_750_000_080_000);
    expect(state.alarmCalls.at(-1)).toBe(1_750_000_080_000);
  });

  it('refreshes the snapshot and re-arms heartbeat alarms when a heartbeat alarm fires', async () => {
    let now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [createWebSocketUpgradeResponse(socket)],
      snapshotResponses: [
        createJsonResponse(createWorldSnapshot()),
        createJsonResponse(createWorldSnapshot(1_750_000_090_000)),
      ],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl,
        now: () => now,
      },
    );

    await bridge.whenBooted();
    await vi.waitFor(() => {
      expect(bridge.getDebugState()).toMatchObject({
        last_publish_at: 1_750_000_050_000,
      });
    });

    now += 30_000;
    await bridge.alarm();

    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:3000/api/snapshot',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Admin-Key': 'test-admin-key',
        }),
      }),
    );
    expect(bridge.getDebugState()).toMatchObject({
      last_refresh_at: now,
      heartbeat_alarm_at: now + 30_000,
      heartbeat_failure_streak: 0,
      latest_snapshot: {
        generated_at: 1_750_000_090_000,
        published_at: now,
      },
    });
    expect(state.alarmCalls.at(-1)).toBe(now + 30_000);
  });

  it('keeps heartbeat alarms alive when a heartbeat refresh fails', async () => {
    let now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [createWebSocketUpgradeResponse(socket)],
      snapshotResponses: [createJsonResponse(createWorldSnapshot()), createJsonResponse({ invalid: true })],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl,
        now: () => now,
      },
    );

    await bridge.whenBooted();
    await vi.waitFor(() => {
      expect(bridge.getDebugState()).toMatchObject({
        last_publish_at: 1_750_000_050_000,
      });
    });

    now += 30_000;
    await bridge.alarm();

    expect(bridge.getDebugState()).toMatchObject({
      last_refresh_at: 1_750_000_050_000,
      heartbeat_alarm_at: now + 30_000,
      heartbeat_failure_streak: 1,
      latest_snapshot: {
        generated_at: 1_750_000_000_000,
        published_at: 1_750_000_050_000,
      },
    });
    expect(state.alarmCalls.at(-1)).toBe(now + 30_000);
  });

  it('skips a queued heartbeat rerun after an in-flight world event refresh succeeds', async () => {
    let now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const refreshDeferred = createDeferred<ReturnType<typeof createJsonResponse>>();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [createWebSocketUpgradeResponse(socket)],
      snapshotResponses: [
        createJsonResponse(createWorldSnapshot()),
        async () => refreshDeferred.promise,
        createJsonResponse({ invalid: true }),
      ],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl,
        now: () => now,
      },
    );

    await bridge.whenBooted();
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(),
    });

    socket.emitMessage({
      type: 'event',
      data: {
        event_id: 'event-1',
        type: 'action_completed',
        occurred_at: 1_750_000_060_000,
        agent_id: 'alice',
        agent_name: 'Alice',
        action_id: 'cook',
        action_name: 'Cook',
      },
    });

    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(bridge.getDebugState()).toMatchObject({
        refresh_in_flight: true,
      });
    });

    now += 30_000;
    await bridge.alarm();

    expect(bridge.getDebugState()).toMatchObject({
      refresh_in_flight: true,
      refresh_queued: true,
      refresh_queued_reason: 'heartbeat',
      heartbeat_alarm_at: now + 30_000,
      heartbeat_failure_streak: 0,
    });

    refreshDeferred.resolve(createJsonResponse(createWorldSnapshot(1_750_000_090_000)));

    await vi.waitFor(() => {
      expect(bridge.getDebugState()).toMatchObject({
        refresh_in_flight: false,
        refresh_queued: false,
        refresh_queued_reason: undefined,
        last_refresh_at: now,
        heartbeat_alarm_at: now + 30_000,
        heartbeat_failure_streak: 0,
        latest_snapshot: {
          generated_at: 1_750_000_090_000,
          published_at: now,
        },
      });
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('keeps a queued world-event rerun ahead of heartbeat work', async () => {
    let now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const refreshDeferred = createDeferred<ReturnType<typeof createJsonResponse>>();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [createWebSocketUpgradeResponse(socket)],
      snapshotResponses: [
        createJsonResponse(createWorldSnapshot()),
        async () => refreshDeferred.promise,
        createJsonResponse(createWorldSnapshot(1_750_000_120_000)),
      ],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl,
        now: () => now,
      },
    );

    await bridge.whenBooted();
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(),
    });

    socket.emitMessage({
      type: 'event',
      data: {
        event_id: 'event-1',
        type: 'action_completed',
        occurred_at: 1_750_000_060_000,
        agent_id: 'alice',
        agent_name: 'Alice',
        action_id: 'cook',
        action_name: 'Cook',
      },
    });
    socket.emitMessage({
      type: 'event',
      data: {
        event_id: 'event-2',
        type: 'action_completed',
        occurred_at: 1_750_000_061_000,
        agent_id: 'bob',
        agent_name: 'Bob',
        action_id: 'fish',
        action_name: 'Fish',
      },
    });

    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(bridge.getDebugState()).toMatchObject({
        refresh_in_flight: true,
        refresh_queued: true,
        refresh_queued_reason: 'world-event',
      });
    });

    now += 30_000;
    await bridge.alarm();

    expect(bridge.getDebugState()).toMatchObject({
      refresh_in_flight: true,
      refresh_queued: true,
      refresh_queued_reason: 'world-event',
      heartbeat_alarm_at: now + 30_000,
      heartbeat_failure_streak: 0,
    });

    refreshDeferred.resolve(createJsonResponse(createWorldSnapshot(1_750_000_090_000)));

    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect(bridge.getDebugState()).toMatchObject({
        refresh_in_flight: false,
        refresh_queued: false,
        refresh_queued_reason: undefined,
        last_refresh_at: now,
        heartbeat_alarm_at: now + 30_000,
        heartbeat_failure_streak: 0,
        latest_snapshot: {
          generated_at: 1_750_000_120_000,
          published_at: now,
        },
      });
    });
  });

  it('upgrades a queued heartbeat rerun to world-event when a later event arrives', async () => {
    let now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const refreshDeferred = createDeferred<ReturnType<typeof createJsonResponse>>();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [createWebSocketUpgradeResponse(socket)],
      snapshotResponses: [
        createJsonResponse(createWorldSnapshot()),
        async () => refreshDeferred.promise,
        createJsonResponse(createWorldSnapshot(1_750_000_120_000)),
      ],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl,
        now: () => now,
      },
    );

    await bridge.whenBooted();
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(),
    });

    now += 30_000;
    const firstAlarm = bridge.alarm();

    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(bridge.getDebugState()).toMatchObject({
        refresh_in_flight: true,
      });
    });

    now += 30_000;
    await bridge.alarm();

    expect(bridge.getDebugState()).toMatchObject({
      refresh_in_flight: true,
      refresh_queued: true,
      refresh_queued_reason: 'heartbeat',
      heartbeat_alarm_at: now + 30_000,
      heartbeat_failure_streak: 0,
    });

    socket.emitMessage({
      type: 'event',
      data: {
        event_id: 'event-1',
        type: 'action_completed',
        occurred_at: 1_750_000_111_000,
        agent_id: 'alice',
        agent_name: 'Alice',
        action_id: 'cook',
        action_name: 'Cook',
      },
    });

    expect(bridge.getDebugState()).toMatchObject({
      refresh_in_flight: true,
      refresh_queued: true,
      refresh_queued_reason: 'world-event',
      heartbeat_alarm_at: now + 30_000,
      heartbeat_failure_streak: 0,
    });

    refreshDeferred.resolve(createJsonResponse(createWorldSnapshot(1_750_000_090_000)));
    await firstAlarm;

    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect(bridge.getDebugState()).toMatchObject({
        refresh_in_flight: false,
        refresh_queued: false,
        refresh_queued_reason: undefined,
        last_refresh_at: now,
        heartbeat_alarm_at: now + 30_000,
        heartbeat_failure_streak: 0,
        latest_snapshot: {
          generated_at: 1_750_000_120_000,
          published_at: now,
        },
      });
    });
  });

  it('publishes the first snapshot with cache headers and schema metadata', async () => {
    const now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const publishCalls: SnapshotPublishCall[] = [];
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl: vi.fn(async () => ({
          status: 101,
          webSocket: socket,
        })),
        now: () => now,
        publishSnapshot: vi.fn(async (input) => {
          publishCalls.push(input);
        }),
      },
    );

    await bridge.whenBooted();
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(),
    });

    await vi.waitFor(() => {
      expect(publishCalls).toHaveLength(1);
    });

    expect(publishCalls[0]).toMatchObject({
      key: 'snapshot/latest.json',
      options: {
        httpMetadata: {
          contentType: 'application/json; charset=utf-8',
          cacheControl: 'public, max-age=5',
        },
        customMetadata: {
          'schema-version': '1',
        },
      },
    });
    expect(decodeSpectatorSnapshot(publishCalls[0].body)).toMatchObject({
      generated_at: 1_750_000_000_000,
      published_at: now,
    });
    expect(bridge.getDebugState()).toMatchObject({
      last_publish_at: now,
      publish_alarm_at: undefined,
      publish_failure_streak: 0,
      latest_snapshot: {
        generated_at: 1_750_000_000_000,
        published_at: now,
      },
    });
  });

  it('throttles subsequent publishes and keeps the earliest alarm armed', async () => {
    let now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const publishSnapshot = vi.fn(async () => {});
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl: vi.fn(async () => ({
          status: 101,
          webSocket: socket,
        })),
        now: () => now,
        publishSnapshot,
      },
    );

    await bridge.whenBooted();
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(),
    });

    await vi.waitFor(() => {
      expect(publishSnapshot).toHaveBeenCalledTimes(1);
    });

    now += 1_000;
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(1_750_000_001_000),
    });

    await vi.waitFor(() => {
      expect(bridge.getDebugState()).toMatchObject({
        last_publish_at: 1_750_000_050_000,
        publish_alarm_at: 1_750_000_055_000,
        heartbeat_alarm_at: 1_750_000_081_000,
      });
    });

    expect(publishSnapshot).toHaveBeenCalledTimes(1);
    expect(state.alarmCalls.at(-1)).toBe(1_750_000_055_000);
  });

  it('backs off failed publishes up to 60 seconds and resets the streak after recovery', async () => {
    let now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const publishSnapshot = vi.fn<(input: SnapshotPublishCall) => Promise<void>>(async () => {
      throw new Error('R2 unavailable');
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
        SNAPSHOT_HEARTBEAT_INTERVAL_MS: '999999999',
      },
      {
        fetchImpl: vi.fn(async () => ({
          status: 101,
          webSocket: socket,
        })),
        now: () => now,
        publishSnapshot,
      },
    );

    await bridge.whenBooted();
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(),
    });

    await vi.waitFor(() => {
      expect(bridge.getDebugState()).toMatchObject({
        publish_failure_streak: 1,
        publish_alarm_at: now + 5_000,
        latest_snapshot: {
          published_at: 0,
        },
      });
    });

    now += 5_000;
    await bridge.alarm();
    expect(bridge.getDebugState()).toMatchObject({
      publish_failure_streak: 2,
      publish_alarm_at: now + 10_000,
    });

    now += 10_000;
    await bridge.alarm();
    expect(bridge.getDebugState()).toMatchObject({
      publish_failure_streak: 3,
      publish_alarm_at: now + 20_000,
    });

    now += 20_000;
    await bridge.alarm();
    expect(bridge.getDebugState()).toMatchObject({
      publish_failure_streak: 4,
      publish_alarm_at: now + 40_000,
    });

    now += 40_000;
    await bridge.alarm();
    expect(bridge.getDebugState()).toMatchObject({
      publish_failure_streak: 5,
      publish_alarm_at: now + 60_000,
    });

    publishSnapshot.mockImplementation(async () => undefined);
    now += 60_000;
    await bridge.alarm();

    expect(bridge.getDebugState()).toMatchObject({
      last_publish_at: now,
      publish_failure_streak: 0,
      publish_alarm_at: undefined,
      latest_snapshot: {
        published_at: now,
      },
    });
  });

  it('backs off heartbeat refresh retries after consecutive failures', async () => {
    let now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [createWebSocketUpgradeResponse(socket)],
      snapshotResponses: [
        createJsonResponse(createWorldSnapshot()),
        createJsonResponse({ invalid: true }),
        createJsonResponse({ invalid: true }),
      ],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl,
        now: () => now,
      },
    );

    await bridge.whenBooted();
    now += 30_000;
    await bridge.alarm();
    expect(bridge.getDebugState()).toMatchObject({
      heartbeat_failure_streak: 1,
      heartbeat_alarm_at: now + 30_000,
    });

    now += 30_000;
    await bridge.alarm();
    expect(bridge.getDebugState()).toMatchObject({
      heartbeat_failure_streak: 2,
      heartbeat_alarm_at: now + 60_000,
    });
  });

  it('transitions a transient bootstrap websocket failure into the reconnect loop', async () => {
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const now = 1_750_000_050_000;
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [
        () => {
          throw new Error('transient bootstrap failure');
        },
        createWebSocketUpgradeResponse(socket),
      ],
    });

    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl,
        now: () => now,
        random: () => 0.5,
      },
    );

    await expect(bridge.whenBooted()).rejects.toThrow('transient bootstrap failure');
    await expect(bridge.fetch(new Request('https://relay.example.com/internal'))).resolves.toMatchObject({ status: 204 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(state.alarmCalls.at(-1)).toBe(now + 1_000);
    expect(state.getStoredValue('relay:websocket-reconnect-state')).toEqual({
      reconnect_attempt: 0,
      disconnect_started_at: now,
      websocket_reconnect_alarm_at: now + 1_000,
    });
  });

  it('continues booting when the history schema has not been initialized yet', async () => {
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [createWebSocketUpgradeResponse(socket)],
    });

    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
        HISTORY_DB: createFailingHistoryDb('D1_ERROR: no such table: server_event_instances: SQLITE_ERROR'),
      },
      {
        fetchImpl,
        now: () => 1_750_000_050_000,
      },
    );

    await expect(bridge.whenBooted()).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bridge.getDebugState().recent_server_events).toEqual([]);
  });

  it('emits auth_rejected disconnect metrics when websocket upgrade is rejected', async () => {
    const state = new FakeDurableObjectState();
    const observability = createObservabilitySpy();
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl: vi.fn(async () => ({
          status: 403,
          webSocket: null,
        })),
        now: () => 1_750_000_050_000,
        observability: observability.observer,
      },
    );

    await expect(bridge.whenBooted()).rejects.toThrow('WebSocket upgrade failed with status 403');
    expect(observability.metrics).toContainEqual({
      kind: 'counter',
      name: 'relay.ws.disconnect_total',
      value: 1,
      tags: {
        reason: 'error',
        handshake_status: 'auth_rejected',
      },
    });
    expect(observability.logs).toContainEqual({
      level: 'error',
      message: 'relay websocket connect failed',
      context: {
        handshake_status: 'auth_rejected',
        reconnect_attempt: 1,
        disconnect_duration_ms: 0,
        error: 'WebSocket upgrade failed with status 403',
      },
    });
  });

  it.each([
    { status: 404, handshakeStatus: 'not_found' },
    { status: 503, handshakeStatus: 'server_error' },
    { status: 504, handshakeStatus: 'timeout' },
  ])('classifies websocket upgrade status $status as $handshakeStatus', async ({ status, handshakeStatus }) => {
    const state = new FakeDurableObjectState();
    const observability = createObservabilitySpy();
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl: vi.fn(async () => ({
          status,
          webSocket: null,
        })),
        now: () => 1_750_000_050_000,
        observability: observability.observer,
      },
    );

    await expect(bridge.whenBooted()).rejects.toThrow(`WebSocket upgrade failed with status ${status}`);
    expect(observability.metrics).toContainEqual({
      kind: 'counter',
      name: 'relay.ws.disconnect_total',
      value: 1,
      tags: {
        reason: 'error',
        handshake_status: handshakeStatus,
      },
    });
    expect(observability.logs).toContainEqual({
      level: 'warn',
      message: 'relay websocket connect failed',
      context: {
        handshake_status: handshakeStatus,
        reconnect_attempt: 1,
        disconnect_duration_ms: 0,
        error: `WebSocket upgrade failed with status ${status}`,
      },
    });
  });

  it('reports unknown websocket event types through observability hooks', async () => {
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const observability = createObservabilitySpy();
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl: vi.fn(async () => ({
          status: 101,
          webSocket: socket,
        })),
        now: () => 1_750_000_050_000,
        observability: observability.observer,
      },
    );

    await bridge.whenBooted();
    socket.emitMessage({
      type: 'event',
      data: {
        event_id: 'evt-unknown',
        type: 'idle_reminder_fired',
        occurred_at: 1_750_000_060_000,
      },
    });

    expect(observability.metrics).toContainEqual({
      kind: 'counter',
      name: 'relay.event.unknown_total',
      value: 1,
      tags: {
        event_type: 'idle_reminder_fired',
      },
    });
    expect(observability.logs).toContainEqual({
      level: 'warn',
      message: 'relay dropped unknown websocket event type',
      context: {
        event_type: 'idle_reminder_fired',
      },
    });
  });

  it('emits snapshot publish age metrics based on the previously published snapshot age', async () => {
    let now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const observability = createObservabilitySpy();
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl: vi.fn(async () => ({
          status: 101,
          webSocket: socket,
        })),
        now: () => now,
        observability: observability.observer,
      },
    );

    await bridge.whenBooted();
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(now - 20_000),
    });

    await vi.waitFor(() => {
      expect(
        observability.metrics.some((metric) => metric.kind === 'gauge' && metric.name === 'relay.snapshot.published_age_ms'),
      ).toBe(true);
    });

    now += 6_000;
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(now - 10_000),
    });

    await vi.waitFor(() => {
      expect(
        observability.metrics.some(
          (metric) =>
            metric.kind === 'gauge' && metric.name === 'relay.snapshot.generated_age_ms' && metric.value === 10_000,
        ),
      ).toBe(true);
    });
    expect(observability.metrics).toContainEqual({
      kind: 'gauge',
      name: 'relay.snapshot.published_age_ms',
      value: 6_000,
    });
    expect(observability.metrics).toContainEqual({
      kind: 'gauge',
      name: 'relay.r2.publish_failure_streak',
      value: 0,
    });
    expect(observability.metrics).toContainEqual({
      kind: 'gauge',
      name: 'relay.heartbeat.failure_streak',
      value: 0,
    });
  });

  it('emits publish failure metrics when snapshot publication fails', async () => {
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const observability = createObservabilitySpy();
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl: vi.fn(async () => ({
          status: 101,
          webSocket: socket,
        })),
        now: () => 1_750_000_050_000,
        publishSnapshot: vi.fn(async () => {
          throw new Error('R2 unavailable');
        }),
        observability: observability.observer,
      },
    );

    await bridge.whenBooted();
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(),
    });

    await vi.waitFor(() => {
      expect(bridge.getDebugState().publish_failure_streak).toBe(1);
    });
    expect(observability.metrics).toContainEqual({
      kind: 'counter',
      name: 'relay.r2.publish_failure_total',
      value: 1,
    });
    expect(observability.metrics).toContainEqual({
      kind: 'gauge',
      name: 'relay.r2.publish_failure_streak',
      value: 1,
    });
    expect(observability.logs).toContainEqual({
      level: 'error',
      message: 'relay snapshot publish failed',
      context: {
        publish_failure_streak: 1,
        publish_alarm_at: 1_750_000_055_000,
        error: 'R2 unavailable',
      },
    });
  });

  it('emits refresh failure metrics when a heartbeat refresh fails', async () => {
    let now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const observability = createObservabilitySpy();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [createWebSocketUpgradeResponse(socket)],
      snapshotResponses: [createJsonResponse(createWorldSnapshot()), { status: 500 }],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl,
        now: () => now,
        observability: observability.observer,
      },
    );

    await bridge.whenBooted();
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(),
    });
    await vi.waitFor(() => {
      expect(bridge.getDebugState().last_refresh_at).toBe(now);
    });

    now += 30_000;
    await bridge.alarm();

    expect(observability.metrics).toContainEqual({
      kind: 'counter',
      name: 'relay.snapshot.refresh_failure_total',
      value: 1,
      tags: {
        reason: 'heartbeat',
      },
    });
    expect(observability.metrics).toContainEqual({
      kind: 'gauge',
      name: 'relay.heartbeat.failure_streak',
      value: 1,
    });
    expect(observability.logs).toContainEqual({
      level: 'error',
      message: 'relay snapshot refresh failed',
      context: {
        reason: 'heartbeat',
        error: 'Snapshot refresh failed with status 500',
        heartbeat_failure_streak: 1,
      },
    });
  });

  it('fetches /api/snapshot during boot and records boot refresh failures without aborting startup', async () => {
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const observability = createObservabilitySpy();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [createWebSocketUpgradeResponse(socket)],
      snapshotResponses: [{ status: 500 }],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl,
        now: () => 1_750_000_050_000,
        observability: observability.observer,
      },
    );

    await expect(bridge.whenBooted()).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:3000/api/snapshot',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Admin-Key': 'test-admin-key',
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'ws://127.0.0.1:3000/ws',
      expect.objectContaining({
        headers: expect.objectContaining({
          Upgrade: 'websocket',
          'X-Admin-Key': 'test-admin-key',
        }),
      }),
    );
    expect(observability.metrics).toContainEqual({
      kind: 'counter',
      name: 'relay.snapshot.refresh_failure_total',
      value: 1,
      tags: {
        reason: 'boot',
      },
    });
  });

  it('keeps retrying websocket reconnects across durable object restarts until one succeeds', async () => {
    let now = 1_750_000_050_000;
    const initialSocket = new FakeWebSocket();
    const reconnectSocket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const observability = createObservabilitySpy();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [
        createWebSocketUpgradeResponse(initialSocket),
        () => {
          throw new Error('first reconnect failed');
        },
        () => {
          throw new Error('second reconnect failed');
        },
        createWebSocketUpgradeResponse(reconnectSocket),
      ],
    });

    const createBridge = () =>
      new UIBridgeDurableObject(
        state,
        {
          KW_BASE_URL: 'http://127.0.0.1:3000',
          KW_ADMIN_KEY: 'test-admin-key',
        },
        {
          fetchImpl,
          now: () => now,
          random: () => 0.5,
          observability: observability.observer,
        },
      );

    const firstBridge = createBridge();
    await firstBridge.whenBooted();
    initialSocket.emitClose();

    await vi.waitFor(() => {
      expect(firstBridge.getDebugState().websocket_reconnect_alarm_at).toBe(now + 1_000);
    });
    expect(state.getStoredValue('relay:websocket-reconnect-state')).toEqual({
      reconnect_attempt: 0,
      disconnect_started_at: now,
      websocket_reconnect_alarm_at: now + 1_000,
    });

    now += 1_000;
    await firstBridge.alarm();
    expect(firstBridge.getDebugState()).toMatchObject({
      reconnect_attempt: 1,
      disconnect_started_at: 1_750_000_050_000,
      websocket_reconnect_alarm_at: 1_750_000_053_000,
    });
    expect(state.getStoredValue('relay:websocket-reconnect-state')).toEqual({
      reconnect_attempt: 1,
      disconnect_started_at: 1_750_000_050_000,
      websocket_reconnect_alarm_at: 1_750_000_053_000,
    });

    const secondBridge = createBridge();
    now = 1_750_000_053_000;
    await expect(secondBridge.whenBooted()).resolves.toBeUndefined();
    expect(secondBridge.getDebugState()).toMatchObject({
      reconnect_attempt: 2,
      disconnect_started_at: 1_750_000_050_000,
      websocket_reconnect_alarm_at: 1_750_000_057_000,
    });
    expect(state.getStoredValue('relay:websocket-reconnect-state')).toEqual({
      reconnect_attempt: 2,
      disconnect_started_at: 1_750_000_050_000,
      websocket_reconnect_alarm_at: 1_750_000_057_000,
    });

    now = 1_750_000_057_000;
    await secondBridge.alarm();
    expect(secondBridge.getDebugState()).toMatchObject({
      reconnect_attempt: 0,
      disconnect_started_at: undefined,
      websocket_reconnect_alarm_at: undefined,
    });
    expect(state.getStoredValue('relay:websocket-reconnect-state')).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('starts the reconnect loop after an initial boot websocket failure and keeps retrying until one succeeds', async () => {
    let now = 1_750_000_050_000;
    const reconnectSocket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [
        () => {
          throw new Error('initial boot failed');
        },
        () => {
          throw new Error('first reconnect failed');
        },
        createWebSocketUpgradeResponse(reconnectSocket),
      ],
    });

    const createBridge = () =>
      new UIBridgeDurableObject(
        state,
        {
          KW_BASE_URL: 'http://127.0.0.1:3000',
          KW_ADMIN_KEY: 'test-admin-key',
        },
        {
          fetchImpl,
          now: () => now,
          random: () => 0.5,
        },
      );

    const firstBridge = createBridge();
    await expect(firstBridge.whenBooted()).rejects.toThrow('initial boot failed');
    expect(state.alarmCalls.at(-1)).toBe(now + 1_000);
    expect(state.getStoredValue('relay:websocket-reconnect-state')).toEqual({
      reconnect_attempt: 0,
      disconnect_started_at: now,
      websocket_reconnect_alarm_at: now + 1_000,
    });

    now += 1_000;
    const secondBridge = createBridge();
    await expect(secondBridge.whenBooted()).resolves.toBeUndefined();
    expect(secondBridge.getDebugState()).toMatchObject({
      reconnect_attempt: 1,
      disconnect_started_at: 1_750_000_050_000,
      websocket_reconnect_alarm_at: 1_750_000_053_000,
    });
    expect(state.getStoredValue('relay:websocket-reconnect-state')).toEqual({
      reconnect_attempt: 1,
      disconnect_started_at: 1_750_000_050_000,
      websocket_reconnect_alarm_at: 1_750_000_053_000,
    });

    now = 1_750_000_053_000;
    await secondBridge.alarm();
    expect(secondBridge.getDebugState()).toMatchObject({
      websocket: reconnectSocket,
      reconnect_attempt: 0,
      disconnect_started_at: undefined,
      websocket_reconnect_alarm_at: undefined,
    });
    expect(state.getStoredValue('relay:websocket-reconnect-state')).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('restores outage snapshot state after restart so publish and heartbeat continue before websocket recovery', async () => {
    let now = 1_750_000_050_000;
    const initialSocket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const publishCalls: SnapshotPublishCall[] = [];
    const publishSnapshot = vi.fn(async (input: SnapshotPublishCall) => {
      publishCalls.push(input);
    });
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [
        createWebSocketUpgradeResponse(initialSocket),
        () => {
          throw new Error('first reconnect failed');
        },
        () => {
          throw new Error('second reconnect failed');
        },
        () => {
          throw new Error('third reconnect failed');
        },
      ],
      snapshotResponses: [
        createJsonResponse(createWorldSnapshot()),
        createJsonResponse(createWorldSnapshot(1_750_000_090_000)),
      ],
    });

    const createBridge = () =>
      new UIBridgeDurableObject(
        state,
        {
          KW_BASE_URL: 'http://127.0.0.1:3000',
          KW_ADMIN_KEY: 'test-admin-key',
        },
        {
          fetchImpl,
          now: () => now,
          random: () => 0.5,
          publishSnapshot,
        },
      );

    const firstBridge = createBridge();
    await firstBridge.whenBooted();
    await vi.waitFor(() => {
      expect(publishCalls).toHaveLength(1);
    });

    now += 1_000;
    initialSocket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(1_750_000_001_000),
    });

    await vi.waitFor(() => {
      expect(firstBridge.getDebugState()).toMatchObject({
        last_refresh_at: 1_750_000_051_000,
        publish_alarm_at: 1_750_000_055_000,
        heartbeat_alarm_at: 1_750_000_081_000,
        latest_snapshot: {
          generated_at: 1_750_000_001_000,
          published_at: 1_750_000_050_000,
        },
      });
    });

    initialSocket.emitClose();
    await vi.waitFor(() => {
      expect(firstBridge.getDebugState().websocket_reconnect_alarm_at).toBe(1_750_000_052_000);
    });
    await vi.waitFor(() => {
      expect(state.getStoredValue('relay:outage-runtime-state')).toMatchObject({
        last_publish_at: 1_750_000_050_000,
        last_refresh_at: 1_750_000_051_000,
        publish_alarm_at: 1_750_000_055_000,
        heartbeat_alarm_at: 1_750_000_081_000,
        publish_failure_streak: 0,
        heartbeat_failure_streak: 0,
        latest_snapshot: expect.objectContaining({
          generated_at: 1_750_000_001_000,
          published_at: 1_750_000_050_000,
        }),
      });
    });

    now = 1_750_000_051_500;
    const secondBridge = createBridge();
    await secondBridge.whenBooted();
    expect(secondBridge.getDebugState()).toMatchObject({
      last_publish_at: 1_750_000_050_000,
      last_refresh_at: 1_750_000_051_000,
      publish_alarm_at: 1_750_000_055_000,
      heartbeat_alarm_at: 1_750_000_081_000,
      websocket_reconnect_alarm_at: 1_750_000_052_000,
      latest_snapshot: {
        generated_at: 1_750_000_001_000,
        published_at: 1_750_000_050_000,
      },
    });

    now = 1_750_000_052_000;
    await secondBridge.alarm();
    expect(secondBridge.getDebugState()).toMatchObject({
      reconnect_attempt: 1,
      publish_alarm_at: 1_750_000_055_000,
      heartbeat_alarm_at: 1_750_000_081_000,
      websocket_reconnect_alarm_at: 1_750_000_054_000,
    });

    now = 1_750_000_054_000;
    await secondBridge.alarm();
    expect(secondBridge.getDebugState()).toMatchObject({
      reconnect_attempt: 2,
      publish_alarm_at: 1_750_000_055_000,
      heartbeat_alarm_at: 1_750_000_081_000,
      websocket_reconnect_alarm_at: 1_750_000_058_000,
    });

    now = 1_750_000_055_000;
    await secondBridge.alarm();
    expect(publishCalls).toHaveLength(2);
    expect(decodeSpectatorSnapshot(publishCalls[1].body)).toMatchObject({
      generated_at: 1_750_000_001_000,
      published_at: 1_750_000_055_000,
    });
    expect(secondBridge.getDebugState()).toMatchObject({
      last_publish_at: 1_750_000_055_000,
      latest_snapshot: {
        generated_at: 1_750_000_001_000,
        published_at: 1_750_000_055_000,
      },
      websocket_reconnect_alarm_at: 1_750_000_058_000,
    });

    now = 1_750_000_081_000;
    await secondBridge.alarm();
    expect(publishCalls).toHaveLength(3);
    expect(decodeSpectatorSnapshot(publishCalls[2].body)).toMatchObject({
      generated_at: 1_750_000_090_000,
      published_at: 1_750_000_081_000,
    });
    expect(secondBridge.getDebugState()).toMatchObject({
      last_refresh_at: 1_750_000_081_000,
      last_publish_at: 1_750_000_081_000,
      heartbeat_alarm_at: 1_750_000_111_000,
      websocket_reconnect_alarm_at: 1_750_000_089_000,
      latest_snapshot: {
        generated_at: 1_750_000_090_000,
        published_at: 1_750_000_081_000,
      },
    });
  });

  it('re-arms publish and heartbeat alarms after a boot-time reconnect succeeds from restored outage state', async () => {
    let now = 1_750_000_050_000;
    const initialSocket = new FakeWebSocket();
    const reconnectSocket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const publishCalls: SnapshotPublishCall[] = [];
    const publishSnapshot = vi.fn(async (input: SnapshotPublishCall) => {
      publishCalls.push(input);
    });
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [createWebSocketUpgradeResponse(initialSocket), createWebSocketUpgradeResponse(reconnectSocket)],
      snapshotResponses: [createJsonResponse(createWorldSnapshot())],
    });

    const createBridge = () =>
      new UIBridgeDurableObject(
        state,
        {
          KW_BASE_URL: 'http://127.0.0.1:3000',
          KW_ADMIN_KEY: 'test-admin-key',
        },
        {
          fetchImpl,
          now: () => now,
          random: () => 0.5,
          publishSnapshot,
        },
      );

    const firstBridge = createBridge();
    await firstBridge.whenBooted();
    await vi.waitFor(() => {
      expect(publishCalls).toHaveLength(1);
    });

    now += 1_000;
    initialSocket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(1_750_000_001_000),
    });

    await vi.waitFor(() => {
      expect(firstBridge.getDebugState()).toMatchObject({
        last_refresh_at: 1_750_000_051_000,
        publish_alarm_at: 1_750_000_055_000,
        heartbeat_alarm_at: 1_750_000_081_000,
      });
    });

    initialSocket.emitClose();
    await vi.waitFor(() => {
      expect(firstBridge.getDebugState().websocket_reconnect_alarm_at).toBe(1_750_000_052_000);
    });

    now = 1_750_000_052_000;
    const secondBridge = createBridge();
    await secondBridge.whenBooted();

    expect(secondBridge.getDebugState()).toMatchObject({
      websocket: reconnectSocket,
      reconnect_attempt: 0,
      websocket_reconnect_alarm_at: undefined,
      publish_alarm_at: 1_750_000_055_000,
      heartbeat_alarm_at: 1_750_000_081_000,
    });
    expect(state.alarmCalls.at(-1)).toBe(1_750_000_055_000);
    expect(state.getStoredValue('relay:websocket-reconnect-state')).toBeUndefined();
    expect(state.getStoredValue('relay:outage-runtime-state')).toBeUndefined();
  });

  it('keeps retrying live websocket reconnects with jittered backoff until one succeeds', async () => {
    let now = 1_750_000_050_000;
    const initialSocket = new FakeWebSocket();
    const reconnectSocket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [
        createWebSocketUpgradeResponse(initialSocket),
        () => {
          throw new Error('first reconnect failed');
        },
        () => {
          throw new Error('second reconnect failed');
        },
        createWebSocketUpgradeResponse(reconnectSocket),
      ],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl,
        now: () => now,
        random: () => 1,
      },
    );

    await bridge.whenBooted();
    initialSocket.emitClose();

    await vi.waitFor(() => {
      expect(bridge.getDebugState().websocket_reconnect_alarm_at).toBe(now + 1_200);
    });
    expect(state.getStoredValue('relay:websocket-reconnect-state')).toEqual({
      reconnect_attempt: 0,
      disconnect_started_at: now,
      websocket_reconnect_alarm_at: now + 1_200,
    });

    now += 1_200;
    await bridge.alarm();
    expect(bridge.getDebugState()).toMatchObject({
      reconnect_attempt: 1,
      disconnect_started_at: 1_750_000_050_000,
      websocket_reconnect_alarm_at: 1_750_000_053_600,
    });
    expect(state.getStoredValue('relay:websocket-reconnect-state')).toEqual({
      reconnect_attempt: 1,
      disconnect_started_at: 1_750_000_050_000,
      websocket_reconnect_alarm_at: 1_750_000_053_600,
    });

    now = 1_750_000_053_600;
    await bridge.alarm();
    expect(bridge.getDebugState()).toMatchObject({
      reconnect_attempt: 2,
      disconnect_started_at: 1_750_000_050_000,
      websocket_reconnect_alarm_at: 1_750_000_058_400,
    });
    expect(state.getStoredValue('relay:websocket-reconnect-state')).toEqual({
      reconnect_attempt: 2,
      disconnect_started_at: 1_750_000_050_000,
      websocket_reconnect_alarm_at: 1_750_000_058_400,
    });

    now = 1_750_000_058_400;
    await bridge.alarm();
    expect(bridge.getDebugState()).toMatchObject({
      reconnect_attempt: 0,
      disconnect_started_at: undefined,
      websocket_reconnect_alarm_at: undefined,
      websocket: reconnectSocket,
    });
    expect(state.getStoredValue('relay:websocket-reconnect-state')).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('caps reconnect backoff at 30 seconds after applying jitter', async () => {
    let now = 1_750_000_050_000;
    const initialSocket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [
        createWebSocketUpgradeResponse(initialSocket),
        () => {
          throw new Error('reconnect-1 failed');
        },
        () => {
          throw new Error('reconnect-2 failed');
        },
        () => {
          throw new Error('reconnect-3 failed');
        },
        () => {
          throw new Error('reconnect-4 failed');
        },
        () => {
          throw new Error('reconnect-5 failed');
        },
        () => {
          throw new Error('reconnect-6 failed');
        },
      ],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl,
        now: () => now,
        random: () => 1,
      },
    );

    await bridge.whenBooted();
    initialSocket.emitClose();

    await vi.waitFor(() => {
      expect(bridge.getDebugState().websocket_reconnect_alarm_at).toBe(now + 1_200);
    });

    now += 1_200;
    await bridge.alarm();
    expect(bridge.getDebugState().websocket_reconnect_alarm_at).toBe(1_750_000_053_600);

    now = 1_750_000_053_600;
    await bridge.alarm();
    expect(bridge.getDebugState().websocket_reconnect_alarm_at).toBe(1_750_000_058_400);

    now = 1_750_000_058_400;
    await bridge.alarm();
    expect(bridge.getDebugState().websocket_reconnect_alarm_at).toBe(1_750_000_068_000);

    now = 1_750_000_068_000;
    await bridge.alarm();
    expect(bridge.getDebugState().websocket_reconnect_alarm_at).toBe(1_750_000_087_200);

    now = 1_750_000_087_200;
    await bridge.alarm();
    expect(bridge.getDebugState().websocket_reconnect_alarm_at).toBe(1_750_000_117_200);

    now = 1_750_000_117_200;
    await bridge.alarm();
    expect(bridge.getDebugState()).toMatchObject({
      reconnect_attempt: 6,
      websocket_reconnect_alarm_at: 1_750_000_147_200,
    });
  });

  it('emits disconnect and reconnect duration metrics when the websocket reconnects', async () => {
    let now = 1_750_000_050_000;
    const initialSocket = new FakeWebSocket();
    const reconnectSocket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const observability = createObservabilitySpy();
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [
        createWebSocketUpgradeResponse(initialSocket),
        createWebSocketUpgradeResponse(reconnectSocket),
      ],
      snapshotResponses: [createJsonResponse(createWorldSnapshot())],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl,
        now: () => now,
        random: () => 0.5,
        observability: observability.observer,
      },
    );

    await bridge.whenBooted();
    initialSocket.emitClose();
    await vi.waitFor(() => {
      expect(bridge.getDebugState().websocket_reconnect_alarm_at).toBe(1_750_000_051_000);
    });
    now += 15_000;
    await bridge.alarm();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => {
      expect(
        observability.metrics.some(
          (metric) => metric.kind === 'gauge' && metric.name === 'relay.ws.connect_duration_ms' && metric.value === 15_000,
        ),
      ).toBe(true);
    });
    expect(observability.metrics).toContainEqual({
      kind: 'counter',
      name: 'relay.ws.disconnect_total',
      value: 1,
      tags: {
        reason: 'close',
        handshake_status: 'server_close',
      },
    });
    expect(
      observability.metrics.some(
        (metric) => metric.kind === 'gauge' && metric.name === 'relay.ws.event_gap_ms' && metric.value === 15_000,
      ),
    ).toBe(true);
    expect(observability.logs).toContainEqual({
      level: 'warn',
      message: 'relay websocket reconnected after downtime',
      context: {
        reconnect_attempt: 0,
        connect_duration_ms: 15_000,
        event_gap_ms: 15_000,
      },
    });
  });

  it('classifies post-connect websocket errors as network disconnects', async () => {
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const observability = createObservabilitySpy();
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl: createRelayFetchMock({
          websocketResponses: [createWebSocketUpgradeResponse(socket)],
          snapshotResponses: [createJsonResponse(createWorldSnapshot())],
        }),
        now: () => 1_750_000_050_000,
        observability: observability.observer,
      },
    );

    await bridge.whenBooted();
    socket.emitError();

    await vi.waitFor(() => {
      expect(bridge.getDebugState().websocket_reconnect_alarm_at).toBeDefined();
    });
    expect(observability.metrics).toContainEqual({
      kind: 'counter',
      name: 'relay.ws.disconnect_total',
      value: 1,
      tags: {
        reason: 'error',
        handshake_status: 'network',
      },
    });
    expect(observability.logs).toContainEqual({
      level: 'warn',
      message: 'relay websocket disconnected',
      context: expect.objectContaining({
        reason: 'error',
        handshake_status: 'network',
        reconnect_attempt: 0,
        disconnect_duration_ms: 0,
      }),
    });
  });

  it('classifies idle websocket closes separately from server closes', async () => {
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const observability = createObservabilitySpy();
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl: createRelayFetchMock({
          websocketResponses: [createWebSocketUpgradeResponse(socket)],
          snapshotResponses: [createJsonResponse(createWorldSnapshot())],
        }),
        now: () => 1_750_000_050_000,
        observability: observability.observer,
      },
    );

    await bridge.whenBooted();
    socket.emitClose({ code: 1001, reason: 'idle timeout' });

    await vi.waitFor(() => {
      expect(bridge.getDebugState().websocket_reconnect_alarm_at).toBeDefined();
    });
    expect(observability.metrics).toContainEqual({
      kind: 'counter',
      name: 'relay.ws.disconnect_total',
      value: 1,
      tags: {
        reason: 'idle',
        handshake_status: 'server_close',
      },
    });
    expect(observability.logs).toContainEqual({
      level: 'warn',
      message: 'relay websocket disconnected',
      context: expect.objectContaining({
        reason: 'idle',
        handshake_status: 'server_close',
        reconnect_attempt: 0,
        disconnect_duration_ms: 0,
      }),
    });
  });
});

describe('Phase 1 acceptance', () => {
  it('keeps freshness continuity through websocket downtime and rebuilds live state from the first snapshot after reconnect', async () => {
    let now = 1_750_000_050_000;
    const initialSocket = new FakeWebSocket();
    const reconnectSocket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const observability = createObservabilitySpy();
    const createAcceptanceSnapshot = ({
      generatedAt,
      speakerAgentId,
      participantAgentIds,
    }: {
      generatedAt: number;
      speakerAgentId: string;
      participantAgentIds: string[];
    }) => ({
      ...createWorldSnapshot(generatedAt),
      conversations: [
        {
          ...createWorldSnapshot(generatedAt).conversations[0]!,
          participant_agent_ids: participantAgentIds,
          current_speaker_agent_id: speakerAgentId,
        },
      ],
    });
    const fetchImpl = createRelayFetchMock({
      websocketResponses: [
        createWebSocketUpgradeResponse(initialSocket),
        () => {
          throw new Error('reconnect-1 failed');
        },
        () => {
          throw new Error('reconnect-2 failed');
        },
        () => {
          throw new Error('reconnect-3 failed');
        },
        () => {
          throw new Error('reconnect-4 failed');
        },
        createWebSocketUpgradeResponse(reconnectSocket),
      ],
      snapshotResponses: [
        createJsonResponse(createAcceptanceSnapshot({
          generatedAt: 1_750_000_000_000,
          speakerAgentId: 'alice',
          participantAgentIds: ['alice', 'bob'],
        })),
        createJsonResponse(createAcceptanceSnapshot({
          generatedAt: 1_750_000_090_000,
          speakerAgentId: 'bob',
          participantAgentIds: ['alice', 'bob'],
        })),
      ],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      },
      {
        fetchImpl,
        now: () => now,
        random: () => 0.5,
        observability: observability.observer,
      },
    );

    await bridge.whenBooted();
    initialSocket.emitClose();

    await vi.waitFor(() => {
      expect(bridge.getDebugState().websocket_reconnect_alarm_at).toBe(1_750_000_051_000);
    });

    now = 1_750_000_051_000;
    await bridge.alarm();
    expect(bridge.getDebugState().websocket_reconnect_alarm_at).toBe(1_750_000_053_000);

    now = 1_750_000_053_000;
    await bridge.alarm();
    expect(bridge.getDebugState().websocket_reconnect_alarm_at).toBe(1_750_000_057_000);

    now = 1_750_000_057_000;
    await bridge.alarm();
    expect(bridge.getDebugState().websocket_reconnect_alarm_at).toBe(1_750_000_065_000);

    now = 1_750_000_065_000;
    await bridge.alarm();
    expect(bridge.getDebugState().websocket_reconnect_alarm_at).toBe(1_750_000_081_000);

    now = 1_750_000_080_000;
    await bridge.alarm();
    expect(bridge.getDebugState()).toMatchObject({
      latest_snapshot: {
        generated_at: 1_750_000_090_000,
        published_at: 1_750_000_080_000,
      },
      last_refresh_at: 1_750_000_080_000,
      websocket_reconnect_alarm_at: 1_750_000_081_000,
      heartbeat_alarm_at: 1_750_000_110_000,
    });

    now = 1_750_000_081_000;
    await bridge.alarm();
    expect(bridge.getDebugState()).toMatchObject({
      websocket: reconnectSocket,
      reconnect_attempt: 0,
      disconnect_started_at: undefined,
      websocket_reconnect_alarm_at: undefined,
    });

    reconnectSocket.emitMessage({
      type: 'snapshot',
      data: createAcceptanceSnapshot({
        generatedAt: 1_750_000_120_000,
        speakerAgentId: 'carol',
        participantAgentIds: ['alice', 'carol'],
      }),
    });

    await vi.waitFor(() => {
      expect(bridge.getDebugState()).toMatchObject({
        latest_snapshot: {
          generated_at: 1_750_000_120_000,
        },
        conversations: {
          'conv-1': {
            participant_agent_ids: ['alice', 'carol'],
            current_speaker_agent_id: 'carol',
          },
        },
      });
    });
    expect(
      observability.metrics.some(
        (metric) => metric.kind === 'gauge' && metric.name === 'relay.ws.connect_duration_ms' && metric.value === 31_000,
      ),
    ).toBe(true);
    expect(
      observability.metrics.some(
        (metric) => metric.kind === 'gauge' && metric.name === 'relay.ws.event_gap_ms' && metric.value === 31_000,
      ),
    ).toBe(true);
  });
});
