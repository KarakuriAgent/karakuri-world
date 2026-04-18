import { describe, expect, it, vi } from 'vitest';

import relayWorker, { PRIMARY_BRIDGE_NAME, UIBridgeDurableObject } from '../src/index.js';
import { decodeSpectatorSnapshot } from '../src/contracts/snapshot-serializer.js';
import type {
  D1DatabaseLike,
  DurableObjectStateLike,
  RelayBindings,
  RelayFetchResponse,
} from '../src/relay/bridge.js';

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
}

function createWorldSnapshot(generatedAt = 1_750_000_000_000, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

type FetchMockStep = RelayFetchResponse | (() => RelayFetchResponse | Promise<RelayFetchResponse>);

function createJsonResponse(payload: unknown, status = 200): RelayFetchResponse {
  return {
    status,
    json: async () => payload,
  };
}


function createRelayFetchMock({
  snapshotResponses = [createJsonResponse(createWorldSnapshot())],
}: {
  snapshotResponses?: FetchMockStep[];
}) {
  const snapshotQueue = [...snapshotResponses];

  return vi.fn(async (_input: Request | string | URL) => {
    const next = snapshotQueue.shift();

    if (next === undefined) {
      return createJsonResponse(createWorldSnapshot());
    }

    return typeof next === 'function' ? await next() : next;
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

function createObservabilitySpy() {
  const metrics: MetricCall[] = [];
  const logs: Array<{ level: 'info' | 'warn' | 'error'; message: string; context?: Record<string, unknown> }> = [];

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
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
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

describe('relay bootstrap', () => {
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

  it('boots from /api/snapshot, restores recent server events, publishes immediately, and arms the 5-second cadence', async () => {
    const now = 1_750_000_050_000;
    const state = new FakeDurableObjectState();
    const publishSnapshot = vi.fn<(input: SnapshotPublishCall) => Promise<void>>(async () => undefined);
    const fetchImpl = createRelayFetchMock({
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
        HISTORY_DB: createHistoryDb([
          {
            server_event_id: 'event-2',
            description: 'Late arrival',
            occurred_at: 1_750_000_020_000,
          },
        ]),
      },
      {
        fetchImpl,
        now: () => now,
        publishSnapshot,
      },
    );

    await bridge.whenBooted();

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:3000/api/snapshot',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Admin-Key': 'test-admin-key',
        }),
      }),
    );
    expect(bridge.getDebugState()).toMatchObject({
      recent_server_events: [
        {
          server_event_id: 'event-2',
          description: 'Late arrival',
          occurred_at: 1_750_000_020_000,
          is_active: false,
        },
      ],
      last_refresh_at: now,
      last_publish_at: now,
      refresh_alarm_at: now + 5_000,
      publish_failure_streak: 0,
      active_server_event_ids: [],
    });
    expect(state.alarmCalls).toContain(now + 5_000);
    expect(publishSnapshot).toHaveBeenCalledTimes(1);
    expect(decodeSpectatorSnapshot(publishSnapshot.mock.calls[0]![0].body)).toMatchObject({
      generated_at: 1_750_000_000_000,
      published_at: now,
    });
  });

  it('keeps polling and publishing on the fixed cadence during quiet periods', async () => {
    let now = 1_750_000_050_000;
    const state = new FakeDurableObjectState();
    const publishSnapshot = vi.fn<(input: SnapshotPublishCall) => Promise<void>>(async () => undefined);
    const fetchImpl = createRelayFetchMock({
      snapshotResponses: [
        createJsonResponse(createWorldSnapshot(1_750_000_000_000)),
        createJsonResponse(createWorldSnapshot(1_750_000_005_000)),
      ],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      { KW_BASE_URL: 'http://127.0.0.1:3000', KW_ADMIN_KEY: 'test-admin-key' },
      { fetchImpl, publishSnapshot, now: () => now },
    );

    await bridge.whenBooted();

    now += 5_000;
    await bridge.alarm();

    expect(bridge.getDebugState()).toMatchObject({
      last_refresh_at: now,
      last_publish_at: now,
      refresh_alarm_at: now + 5_000,
      latest_snapshot: {
        generated_at: 1_750_000_005_000,
        published_at: now,
      },
    });
    expect(publishSnapshot).toHaveBeenCalledTimes(2);
  });

  it('builds recent_server_events from polling edges even without relay events', async () => {
    let now = 1_750_000_050_000;
    const state = new FakeDurableObjectState();
    const fetchImpl = createRelayFetchMock({
      snapshotResponses: [
        createJsonResponse(createWorldSnapshot(1_750_000_000_000)),
        createJsonResponse(
          createWorldSnapshot(1_750_000_010_000, {
            server_events: [
              {
                server_event_id: 'festival',
                description: 'Harvest Festival',
                delivered_agent_ids: ['alice'],
                pending_agent_ids: [],
              },
            ],
          }),
        ),
      ],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      { KW_BASE_URL: 'http://127.0.0.1:3000', KW_ADMIN_KEY: 'test-admin-key' },
      { fetchImpl, now: () => now },
    );

    await bridge.whenBooted();
    now += 5_000;
    await bridge.alarm();

    expect(bridge.getDebugState()).toMatchObject({
      active_server_event_ids: ['festival'],
      recent_server_events: [
        {
          server_event_id: 'festival',
          description: 'Harvest Festival',
          occurred_at: 1_750_000_010_000,
          is_active: true,
        },
      ],
    });
  });

  it('does not let refresh cadence bypass an active publish backoff window', async () => {
    let now = 1_750_000_050_000;
    const state = new FakeDurableObjectState();
    const publishSnapshot = vi
      .fn<(input: SnapshotPublishCall) => Promise<void>>()
      .mockRejectedValueOnce(new Error('R2 unavailable'))
      .mockRejectedValueOnce(new Error('R2 still unavailable'))
      .mockResolvedValue(undefined);
    const bridge = new UIBridgeDurableObject(
      state,
      { KW_BASE_URL: 'http://127.0.0.1:3000', KW_ADMIN_KEY: 'test-admin-key' },
      {
        fetchImpl: createRelayFetchMock({
          snapshotResponses: [
            createJsonResponse(createWorldSnapshot(now - 50_000)),
            createJsonResponse(createWorldSnapshot(now - 45_000)),
            createJsonResponse(createWorldSnapshot(now - 40_000)),
            createJsonResponse(createWorldSnapshot(now - 35_000)),
          ],
        }),
        publishSnapshot,
        observability: createObservabilitySpy().observer,
        now: () => now,
      },
    );

    await bridge.whenBooted();
    expect(publishSnapshot).toHaveBeenCalledTimes(1);
    expect(bridge.getDebugState()).toMatchObject({
      publish_failure_streak: 1,
      publish_alarm_at: now + 5_000,
    });

    now += 5_000;
    await bridge.alarm();

    expect(publishSnapshot).toHaveBeenCalledTimes(2);
    expect(bridge.getDebugState()).toMatchObject({
      publish_failure_streak: 2,
      publish_alarm_at: now + 10_000,
      refresh_alarm_at: now + 5_000,
    });

    now += 5_000;
    await bridge.alarm();

    expect(publishSnapshot).toHaveBeenCalledTimes(2);
    expect(bridge.getDebugState()).toMatchObject({
      publish_failure_streak: 2,
      publish_alarm_at: now + 5_000,
      refresh_alarm_at: now + 5_000,
      latest_snapshot: {
        generated_at: 1_750_000_010_000,
        published_at: 0,
      },
    });

    now += 5_000;
    await bridge.alarm();

    expect(publishSnapshot).toHaveBeenCalledTimes(3);
    expect(bridge.getDebugState()).toMatchObject({
      publish_failure_streak: 0,
      publish_alarm_at: undefined,
      last_publish_at: now,
      latest_snapshot: {
        generated_at: 1_750_000_015_000,
        published_at: now,
      },
    });
  });

  it('keeps publish cleanup live when observability emission throws', async () => {
    let now = 1_750_000_050_000;
    const state = new FakeDurableObjectState();
    const publishSnapshot = vi.fn<(input: SnapshotPublishCall) => Promise<void>>().mockResolvedValue(undefined);
    const bridge = new UIBridgeDurableObject(
      state,
      { KW_BASE_URL: 'http://127.0.0.1:3000', KW_ADMIN_KEY: 'test-admin-key' },
      {
        fetchImpl: createRelayFetchMock({
          snapshotResponses: [
            createJsonResponse(createWorldSnapshot(now - 50_000)),
            createJsonResponse(createWorldSnapshot(now - 45_000)),
          ],
        }),
        publishSnapshot,
        observability: {
          counter() {},
          gauge() {
            throw new Error('metrics unavailable');
          },
          log() {},
        },
        now: () => now,
      },
    );

    await bridge.whenBooted();

    expect(bridge.getDebugState()).toMatchObject({
      publish_in_flight: false,
      publish_failure_streak: 0,
      last_publish_at: now,
      latest_snapshot: {
        generated_at: now - 50_000,
        published_at: now,
      },
    });

    now += 5_000;
    await bridge.alarm();

    expect(publishSnapshot).toHaveBeenCalledTimes(2);
    expect(bridge.getDebugState()).toMatchObject({
      publish_in_flight: false,
      publish_failure_streak: 0,
      last_publish_at: now,
      latest_snapshot: {
        generated_at: 1_750_000_005_000,
        published_at: now,
      },
    });
  });

  it('emits ui freshness metrics from the current published snapshot on successful publishes', async () => {
    let now = 1_750_000_050_000;
    const state = new FakeDurableObjectState();
    const observability = createObservabilitySpy();
    const bridge = new UIBridgeDurableObject(
      state,
      { KW_BASE_URL: 'http://127.0.0.1:3000', KW_ADMIN_KEY: 'test-admin-key' },
      {
        fetchImpl: createRelayFetchMock({
          snapshotResponses: [
            createJsonResponse(createWorldSnapshot(now - 20_000)),
            createJsonResponse(createWorldSnapshot(1_750_000_046_000)),
          ],
        }),
        observability: observability.observer,
        now: () => now,
      },
    );

    await bridge.whenBooted();
    now += 6_000;
    await bridge.alarm();

    expect(observability.metrics).toContainEqual({
      kind: 'gauge',
      name: 'ui.snapshot.generated_age_ms',
      value: 10_000,
    });
    expect(observability.metrics).toContainEqual({
      kind: 'gauge',
      name: 'ui.snapshot.published_age_ms',
      value: 0,
    });
  });

  it('emits ui freshness metrics from the last known snapshot when a refresh fails', async () => {
    let now = 1_750_000_050_000;
    const state = new FakeDurableObjectState();
    const observability = createObservabilitySpy();
    const fetchImpl = createRelayFetchMock({
      snapshotResponses: [createJsonResponse(createWorldSnapshot(now - 20_000)), { status: 500 }],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      { KW_BASE_URL: 'http://127.0.0.1:3000', KW_ADMIN_KEY: 'test-admin-key' },
      { fetchImpl, observability: observability.observer, now: () => now },
    );

    await bridge.whenBooted();
    now += 5_000;
    await bridge.alarm();

    expect(observability.metrics).toContainEqual({
      kind: 'gauge',
      name: 'ui.snapshot.generated_age_ms',
      value: 25_000,
    });
    expect(observability.metrics).toContainEqual({
      kind: 'gauge',
      name: 'ui.snapshot.published_age_ms',
      value: 5_000,
    });
  });

  it('emits ui freshness metrics from the last published snapshot when a publish fails', async () => {
    let now = 1_750_000_050_000;
    const state = new FakeDurableObjectState();
    const observability = createObservabilitySpy();
    const publishSnapshot = vi
      .fn<(input: SnapshotPublishCall) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('R2 unavailable'));
    const bridge = new UIBridgeDurableObject(
      state,
      { KW_BASE_URL: 'http://127.0.0.1:3000', KW_ADMIN_KEY: 'test-admin-key' },
      {
        fetchImpl: createRelayFetchMock({
          snapshotResponses: [
            createJsonResponse(createWorldSnapshot(now - 20_000)),
            createJsonResponse(createWorldSnapshot(1_750_000_046_000)),
          ],
        }),
        publishSnapshot,
        observability: observability.observer,
        now: () => now,
      },
    );

    await bridge.whenBooted();
    now += 6_000;
    await bridge.alarm();

    expect(observability.metrics).toContainEqual({
      kind: 'gauge',
      name: 'ui.snapshot.generated_age_ms',
      value: 10_000,
    });
    expect(observability.metrics).toContainEqual({
      kind: 'gauge',
      name: 'ui.snapshot.published_age_ms',
      value: 6_000,
    });
  });

  it('records fixed-cadence refresh failures and keeps the cadence alive', async () => {
    let now = 1_750_000_050_000;
    const state = new FakeDurableObjectState();
    const observability = createObservabilitySpy();
    const fetchImpl = createRelayFetchMock({
      snapshotResponses: [createJsonResponse(createWorldSnapshot()), { status: 500 }],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      { KW_BASE_URL: 'http://127.0.0.1:3000', KW_ADMIN_KEY: 'test-admin-key' },
      { fetchImpl, observability: observability.observer, now: () => now },
    );

    await bridge.whenBooted();
    now += 5_000;
    await bridge.alarm();

    expect(observability.metrics).toContainEqual({
      kind: 'counter',
      name: 'ui.snapshot.refresh_failure_total',
      value: 1,
      tags: { reason: 'fixed-cadence' },
    });
    expect(bridge.getDebugState()).toMatchObject({
      last_refresh_at: 1_750_000_050_000,
      refresh_alarm_at: now + 5_000,
    });
  });

  it('keeps fixed-cadence refresh rescheduling live when failure observability throws', async () => {
    let now = 1_750_000_050_000;
    const state = new FakeDurableObjectState();
    const fetchImpl = createRelayFetchMock({
      snapshotResponses: [createJsonResponse(createWorldSnapshot(now - 20_000)), { status: 500 }],
    });
    const bridge = new UIBridgeDurableObject(
      state,
      { KW_BASE_URL: 'http://127.0.0.1:3000', KW_ADMIN_KEY: 'test-admin-key' },
      {
        fetchImpl,
        observability: {
          counter() {
            throw new Error('metrics unavailable');
          },
          gauge() {
            throw new Error('metrics unavailable');
          },
          log() {
            throw new Error('logs unavailable');
          },
        },
        now: () => now,
      },
    );

    await bridge.whenBooted();
    now += 5_000;

    await expect(bridge.alarm()).resolves.toBeUndefined();
    expect(bridge.getDebugState()).toMatchObject({
      refresh_in_flight: false,
      last_refresh_at: 1_750_000_050_000,
      refresh_alarm_at: now + 5_000,
    });
  });

});
