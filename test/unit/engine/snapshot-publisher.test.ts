import { afterEach, describe, expect, it, vi } from 'vitest';

import { SnapshotPublisher, isSnapshotTriggerEvent } from '../../../src/engine/snapshot-publisher.js';
import type { WorldSnapshot } from '../../../src/types/snapshot.js';

function createMinimalSnapshot(generatedAt = 1_000): WorldSnapshot {
  return {
    world: { name: 'test-world', description: 'test', skill_name: 'test-skill' },
    map: {
      rows: 1,
      cols: 1,
      nodes: { '1-1': { type: 'normal' } },
      buildings: [],
      npcs: [],
    },
    calendar: {
      timezone: 'UTC',
      local_date: '2026-01-01',
      local_time: '00:00:00',
      display_label: '2026-01-01 00:00 (UTC)',
    },
    map_render_theme: {
      cell_size: 1,
      label_font_size: 1,
      node_id_font_size: 1,
      background_fill: '#000',
      grid_stroke: '#000',
      default_node_fill: '#000',
      normal_node_fill: '#000',
      wall_node_fill: '#000',
      door_node_fill: '#000',
      npc_node_fill: '#000',
      building_palette: [],
      wall_text_color: '#000',
      default_text_color: '#000',
    },
    agents: [],
    conversations: [],
    server_events: [],
    recent_server_events: [],
    generated_at: generatedAt,
  };
}

describe('SnapshotPublisher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('classifies snapshot trigger events exhaustively', () => {
    expect(isSnapshotTriggerEvent('movement_started')).toBe(true);
    expect(isSnapshotTriggerEvent('conversation_inactive_check')).toBe(false);
    expect(isSnapshotTriggerEvent('available_actions_requested')).toBe(false);
  });

  it('pushes the snapshot body with JSON content-type and bearer auth', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const snapshot = createMinimalSnapshot(42);
    const buildSnapshot = vi.fn(() => snapshot);
    const publisher = new SnapshotPublisher({
      workerBaseUrl: new URL('https://relay.example.com'),
      authKey: 'publish-key',
      fetchImpl,
      buildSnapshot,
      debounceMs: 10,
      now: () => 100,
    });

    publisher.requestPublish();
    await vi.runAllTimersAsync();

    expect(buildSnapshot).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://relay.example.com/api/publish-snapshot');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer publish-key');
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toEqual(snapshot);
  });

  it('calls buildSnapshot on every retry to send the latest snapshot', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const buildSnapshot = vi
      .fn<() => WorldSnapshot>()
      .mockReturnValueOnce(createMinimalSnapshot(1))
      .mockReturnValueOnce(createMinimalSnapshot(2));
    const publisher = new SnapshotPublisher({
      workerBaseUrl: new URL('https://relay.example.com'),
      authKey: 'publish-key',
      fetchImpl,
      buildSnapshot,
      debounceMs: 10,
      retryBaseIntervalMs: 10,
      retryMaxIntervalMs: 10,
      retryMaxAttempts: 3,
      now: () => 5,
    });

    publisher.requestPublish();
    await vi.runAllTimersAsync();

    expect(buildSnapshot).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    const secondBody = JSON.parse((fetchImpl.mock.calls[1]![1] as RequestInit).body as string);
    expect(firstBody.generated_at).toBe(1);
    expect(secondBody.generated_at).toBe(2);
  });

  it('gives up after the retry budget is exhausted', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('boom'));
    const publisher = new SnapshotPublisher({
      workerBaseUrl: new URL('https://relay.example.com'),
      authKey: 'publish-key',
      fetchImpl,
      buildSnapshot: () => createMinimalSnapshot(),
      debounceMs: 10,
      retryBaseIntervalMs: 10,
      retryMaxIntervalMs: 10,
      retryMaxAttempts: 3,
      now: () => 123,
    });
    const results: string[] = [];

    publisher.onPublish((result) => {
      results.push(result.type);
    });

    publisher.requestPublish();
    await vi.runAllTimersAsync();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(results).toEqual(['failed', 'failed', 'failed', 'gave_up']);
    expect(publisher.getStats()).toMatchObject({
      pending: false,
      consecutiveFailures: 3,
      gaveUp: true,
      state: 'failed',
    });
  });

  it('flushes a pending debounce on dispose', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const publisher = new SnapshotPublisher({
      workerBaseUrl: new URL('https://relay.example.com'),
      authKey: 'publish-key',
      fetchImpl,
      buildSnapshot: () => createMinimalSnapshot(),
      debounceMs: 1_000,
      retryBaseIntervalMs: 10,
      retryMaxIntervalMs: 10,
      retryMaxAttempts: 1,
      now: () => 456,
    });

    publisher.requestPublish();
    await publisher.dispose();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(publisher.getStats()).toMatchObject({
      pending: false,
      consecutiveFailures: 0,
      gaveUp: false,
      lastPublishedAt: 456,
      state: 'idle',
    });
  });

  it('preserves retry backoff when new publish requests arrive during an outage', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const publisher = new SnapshotPublisher({
      workerBaseUrl: new URL('https://relay.example.com'),
      authKey: 'publish-key',
      fetchImpl,
      buildSnapshot: () => createMinimalSnapshot(),
      debounceMs: 10,
      retryBaseIntervalMs: 100,
      retryMaxIntervalMs: 100,
      retryMaxAttempts: 3,
      now: () => 789,
    });

    publisher.requestPublish();
    await vi.advanceTimersByTimeAsync(10);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(publisher.getStats()).toMatchObject({
      pending: true,
      consecutiveFailures: 1,
      gaveUp: false,
      state: 'retrying',
    });

    await vi.advanceTimersByTimeAsync(50);
    publisher.requestPublish();
    await vi.advanceTimersByTimeAsync(49);

    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(publisher.getStats()).toMatchObject({
      pending: false,
      consecutiveFailures: 0,
      gaveUp: false,
      lastPublishedAt: 789,
      state: 'idle',
    });
  });

  it('resets the retry budget after a gave-up publisher receives a new request', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('boom-1'))
      .mockRejectedValueOnce(new Error('boom-2'))
      .mockRejectedValueOnce(new Error('boom-3'))
      .mockRejectedValueOnce(new Error('boom-4'))
      .mockRejectedValueOnce(new Error('boom-5'))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const publisher = new SnapshotPublisher({
      workerBaseUrl: new URL('https://relay.example.com'),
      authKey: 'publish-key',
      fetchImpl,
      buildSnapshot: () => createMinimalSnapshot(),
      debounceMs: 10,
      retryBaseIntervalMs: 10,
      retryMaxIntervalMs: 10,
      retryMaxAttempts: 3,
      now: () => 999,
    });

    publisher.requestPublish();
    await vi.runAllTimersAsync();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(publisher.getStats()).toMatchObject({
      pending: false,
      consecutiveFailures: 3,
      gaveUp: true,
      state: 'failed',
    });

    publisher.requestPublish();
    await vi.runAllTimersAsync();

    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(publisher.getStats()).toMatchObject({
      pending: false,
      consecutiveFailures: 0,
      gaveUp: false,
      lastPublishedAt: 999,
      state: 'idle',
    });
  });

  it('clears the dispose timeout when publish finishes before the timeout', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const publisher = new SnapshotPublisher({
      workerBaseUrl: new URL('https://relay.example.com'),
      authKey: 'publish-key',
      fetchImpl,
      buildSnapshot: () => createMinimalSnapshot(),
      debounceMs: 1_000,
    });

    publisher.requestPublish();
    await publisher.dispose(5_000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps timer callback rejections contained', async () => {
    vi.useFakeTimers();
    const logger = {
      error: vi.fn(),
    };
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('network down'));
    const publisher = new SnapshotPublisher({
      workerBaseUrl: new URL('https://relay.example.com'),
      authKey: 'publish-key',
      fetchImpl,
      buildSnapshot: () => createMinimalSnapshot(),
      debounceMs: 10,
      retryBaseIntervalMs: 10,
      retryMaxIntervalMs: 10,
      retryMaxAttempts: 1,
      logger,
    });

    publisher.requestPublish();
    await vi.runAllTimersAsync();

    expect(logger.error).toHaveBeenCalledWith('SNAPSHOT_PUBLISH_EXHAUSTED', {
      attempt: 1,
      error: 'network down',
    });
    expect(logger.error).not.toHaveBeenCalledWith('SNAPSHOT_PUBLISH_UNCAUGHT', expect.anything());
  });

  it('isolates publish listener failures from successful publishes', async () => {
    vi.useFakeTimers();
    const logger = {
      error: vi.fn(),
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const publisher = new SnapshotPublisher({
      workerBaseUrl: new URL('https://relay.example.com'),
      authKey: 'publish-key',
      fetchImpl,
      buildSnapshot: () => createMinimalSnapshot(),
      debounceMs: 10,
      logger,
      now: () => 321,
    });
    const healthyListener = vi.fn();

    publisher.onPublish(() => {
      throw new Error('listener blew up');
    });
    publisher.onPublish(healthyListener);

    publisher.requestPublish();
    await vi.runAllTimersAsync();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(healthyListener).toHaveBeenCalledWith({ type: 'success', publishedAt: 321 });
    expect(publisher.getStats()).toMatchObject({
      pending: false,
      consecutiveFailures: 0,
      gaveUp: false,
      lastPublishedAt: 321,
      state: 'idle',
    });
    expect(logger.error).toHaveBeenCalledWith('SNAPSHOT_PUBLISH_LISTENER_FAILED', {
      error: 'listener blew up',
      result: 'success',
    });
  });
});
