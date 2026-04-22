import { describe, expect, it, vi } from 'vitest';

import type { SnapshotManifest } from '../src/contracts/snapshot-manifest.js';
import relayWorker, { PRIMARY_BRIDGE_NAME, UIBridgeDurableObject } from '../src/index.js';
import { decodeSpectatorSnapshot } from '../src/contracts/snapshot-serializer.js';
import type { DurableObjectStateLike } from '../src/relay/bridge.js';

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
      display_label: '2026-06-15 12:04 (Asia/Tokyo)',
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
    known_agents: [
      {
        agent_id: 'alice',
        agent_name: 'Alice',
      },
    ],
    conversations: [
      {
        conversation_id: 'conv-1',
        status: 'active' as const,
        participant_agent_ids: ['alice', 'bob'],
        current_speaker_agent_id: 'alice',
        initiator_agent_id: 'alice',
      },
    ],
    recent_server_events: [],
    generated_at: generatedAt,
    ...overrides,
  };
}

function publishSnapshotRequest(body: unknown): Request {
  return new Request('https://relay.example.com/api/publish-snapshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

function publishedKeys(publishSnapshot: { mock: { calls: Array<[SnapshotPublishCall]> } }) {
  return publishSnapshot.mock.calls.map(([call]) => call.key);
}

function latestManifest(publishSnapshot: { mock: { calls: Array<[SnapshotPublishCall]> } }): SnapshotManifest | null {
  const manifestCall = [...publishSnapshot.mock.calls].reverse().find(([call]) => call.key === 'snapshot/manifest.json');
  return manifestCall ? (JSON.parse(manifestCall[0].body) as SnapshotManifest) : null;
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

  it('returns 404 for the removed /ws worker path without forwarding to the durable object', async () => {
    const stub = {
      fetch: vi.fn(async () => new Response('unexpected')),
    };
    const namespace = {
      idFromName: vi.fn(() => ({ id: 'primary-id' })),
      get: vi.fn(() => stub),
    };

    const response = await relayWorker.fetch(new Request('https://relay.example.com/ws'), {
      UI_BRIDGE: namespace,
    } as never);

    expect(response.status).toBe(404);
    expect(namespace.idFromName).not.toHaveBeenCalled();
    expect(namespace.get).not.toHaveBeenCalled();
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('applies a pushed snapshot body and publishes immediately', async () => {
    const now = 1_750_000_050_000;
    const state = new FakeDurableObjectState();
    const publishSnapshot = vi.fn<(input: SnapshotPublishCall) => Promise<void>>(async () => undefined);
    const bridge = new UIBridgeDurableObject(
      state,
      {},
      {
        now: () => now,
        publishSnapshot,
      },
    );

    const response = await bridge.fetch(publishSnapshotRequest(createWorldSnapshot()));

    expect(response.status).toBe(204);
    expect(bridge.getDebugState()).toMatchObject({
      last_publish_at: now,
      last_published_generated_at: 1_750_000_000_000,
      publish_failure_streak: 0,
    });
    expect(publishedKeys(publishSnapshot)).toEqual([
      'snapshot/v/1750000000000.json',
      'snapshot/manifest.json',
      'snapshot/latest.json',
    ]);
    expect(decodeSpectatorSnapshot(publishSnapshot.mock.calls[0]![0].body)).toMatchObject({
      generated_at: 1_750_000_000_000,
      published_at: now,
    });
  });

  it('forwards recent_server_events from the pushed body to the published spectator snapshot', async () => {
    const now = 1_750_000_050_000;
    const state = new FakeDurableObjectState();
    const publishSnapshot = vi.fn<(input: SnapshotPublishCall) => Promise<void>>(async () => undefined);
    const bridge = new UIBridgeDurableObject(
      state,
      {},
      {
        now: () => now,
        publishSnapshot,
      },
    );

    const response = await bridge.fetch(
      publishSnapshotRequest(
        createWorldSnapshot(1_750_000_010_000, {
          recent_server_events: [
            {
              server_event_id: 'festival',
              description: 'Harvest Festival',
              occurred_at: 1_750_000_005_000,
              is_active: true,
            },
          ],
        }),
      ),
    );

    expect(response.status).toBe(204);
    const firstPayload = decodeSpectatorSnapshot(publishSnapshot.mock.calls[0]![0].body);
    expect(firstPayload).toMatchObject({
      generated_at: 1_750_000_010_000,
      recent_server_events: [
        {
          server_event_id: 'festival',
          description: 'Harvest Festival',
          occurred_at: 1_750_000_005_000,
          is_active: true,
        },
      ],
    });
  });

  it('retries a failed R2 publish via alarm-driven exponential backoff', async () => {
    let now = 1_750_000_050_000;
    const state = new FakeDurableObjectState();
    const publishSnapshot = vi
      .fn<(input: SnapshotPublishCall) => Promise<void>>()
      .mockRejectedValueOnce(new Error('R2 unavailable'))
      .mockRejectedValueOnce(new Error('R2 still unavailable'))
      .mockResolvedValue(undefined);
    const bridge = new UIBridgeDurableObject(
      state,
      {},
      {
        publishSnapshot,
        observability: createObservabilitySpy().observer,
        now: () => now,
      },
    );

    await bridge.fetch(publishSnapshotRequest(createWorldSnapshot(1_750_000_000_000)));
    expect(publishedKeys(publishSnapshot)).toEqual(['snapshot/v/1750000000000.json']);
    expect(bridge.getDebugState()).toMatchObject({
      publish_failure_streak: 1,
      publish_alarm_at: now + 5_000,
      last_publish_error_at: now,
      last_publish_error_code: 'R2_PUBLISH_FAILED',
    });

    now += 5_000;
    await bridge.alarm();
    expect(publishedKeys(publishSnapshot)).toEqual([
      'snapshot/v/1750000000000.json',
      'snapshot/v/1750000000000.json',
    ]);
    expect(bridge.getDebugState()).toMatchObject({
      publish_failure_streak: 2,
      publish_alarm_at: now + 10_000,
    });

    now += 10_000;
    await bridge.alarm();
    expect(publishedKeys(publishSnapshot)).toEqual([
      'snapshot/v/1750000000000.json',
      'snapshot/v/1750000000000.json',
      'snapshot/v/1750000000000.json',
      'snapshot/manifest.json',
      'snapshot/latest.json',
    ]);
    expect(bridge.getDebugState()).toMatchObject({
      publish_failure_streak: 0,
      publish_alarm_at: undefined,
      last_publish_at: now,
      latest_snapshot: {
        generated_at: 1_750_000_000_000,
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
      {},
      {
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

    await bridge.fetch(publishSnapshotRequest(createWorldSnapshot(now - 50_000)));

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
    await bridge.fetch(publishSnapshotRequest(createWorldSnapshot(now)));

    expect(publishedKeys(publishSnapshot)).toEqual([
      'snapshot/v/1750000000000.json',
      'snapshot/manifest.json',
      'snapshot/latest.json',
      'snapshot/v/1750000055000.json',
      'snapshot/manifest.json',
      'snapshot/latest.json',
    ]);
    expect(bridge.getDebugState()).toMatchObject({
      publish_in_flight: false,
      publish_failure_streak: 0,
      last_publish_at: now,
      latest_snapshot: {
        generated_at: 1_750_000_055_000,
        published_at: now,
      },
    });
  });

  it('emits ui freshness metrics from the current published snapshot on successful publishes', async () => {
    let now = 1_750_000_050_000;
    const state = new FakeDurableObjectState();
    const observability = createObservabilitySpy();
    const publishSnapshot = vi.fn<(input: SnapshotPublishCall) => Promise<void>>(async () => undefined);
    const bridge = new UIBridgeDurableObject(
      state,
      {},
      {
        publishSnapshot,
        observability: observability.observer,
        now: () => now,
      },
    );

    await bridge.fetch(publishSnapshotRequest(createWorldSnapshot(now - 20_000)));
    now += 6_000;
    await bridge.fetch(publishSnapshotRequest(createWorldSnapshot(now - 10_000)));

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

  it('emits ui freshness metrics from the last published snapshot when a publish fails', async () => {
    let now = 1_750_000_050_000;
    const state = new FakeDurableObjectState();
    const observability = createObservabilitySpy();
    const publishSnapshot = vi
      .fn<(input: SnapshotPublishCall) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('R2 unavailable'));
    const bridge = new UIBridgeDurableObject(
      state,
      {},
      {
        publishSnapshot,
        observability: observability.observer,
        now: () => now,
      },
    );

    await bridge.fetch(publishSnapshotRequest(createWorldSnapshot(now - 20_000)));
    now += 6_000;
    await bridge.fetch(publishSnapshotRequest(createWorldSnapshot(now - 10_000)));

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

  it('republishes stale manifest metadata when a subsequent publish fails after an earlier success', async () => {
    let now = 1_750_000_050_000;
    const state = new FakeDurableObjectState();
    const publishSnapshot = vi
      .fn<(input: SnapshotPublishCall) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('R2 unavailable'))
      .mockResolvedValueOnce(undefined);
    const bridge = new UIBridgeDurableObject(
      state,
      {},
      {
        publishSnapshot,
        now: () => now,
      },
    );

    await bridge.fetch(publishSnapshotRequest(createWorldSnapshot(1_750_000_000_000)));

    now += 180_000;
    await bridge.fetch(publishSnapshotRequest(createWorldSnapshot(1_750_000_005_000)));

    expect(publishedKeys(publishSnapshot)).toEqual([
      'snapshot/v/1750000000000.json',
      'snapshot/manifest.json',
      'snapshot/latest.json',
      'snapshot/v/1750000005000.json',
      'snapshot/manifest.json',
    ]);
    expect(latestManifest(publishSnapshot)).toEqual({
      schema_version: 1,
      latest_snapshot_key: 'snapshot/v/1750000000000.json',
      generated_at: 1_750_000_000_000,
      published_at: 1_750_000_050_000,
      last_publish_error_at: now,
    });
    expect(bridge.getDebugState()).toMatchObject({
      last_publish_at: 1_750_000_050_000,
      last_published_generated_at: 1_750_000_000_000,
      publish_failure_streak: 1,
      last_publish_error_at: now,
      last_publish_error_code: 'R2_PUBLISH_FAILED',
    });
  });

  it('keeps the alarm loop alive when failure observability throws during a publish', async () => {
    const now = 1_750_000_050_000;
    const state = new FakeDurableObjectState();
    const publishSnapshot = vi
      .fn<(input: SnapshotPublishCall) => Promise<void>>()
      .mockRejectedValue(new Error('R2 unavailable'));
    const bridge = new UIBridgeDurableObject(
      state,
      {},
      {
        publishSnapshot,
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

    const response = await bridge.fetch(publishSnapshotRequest(createWorldSnapshot(now - 50_000)));

    expect(response.status).toBe(502);
    expect(bridge.getDebugState()).toMatchObject({
      publish_in_flight: false,
      publish_failure_streak: 1,
      publish_alarm_at: now + 5_000,
    });
  });
});
