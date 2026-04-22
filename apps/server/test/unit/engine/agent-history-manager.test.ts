import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentHistoryManager } from '../../../src/engine/agent-history-manager.js';
import type { WorldEvent } from '../../../src/types/event.js';

function actionStartedEvent(eventId: string, occurredAt: number): WorldEvent {
  return {
    event_id: eventId,
    type: 'action_started',
    occurred_at: occurredAt,
    agent_id: 'alice',
    agent_name: 'Alice',
    action_id: 'craft',
    action_name: 'Craft',
    duration_ms: 60_000,
    completes_at: occurredAt + 60_000,
    cost_money: 100,
    items_consumed: [{ item_id: 'wood', quantity: 1 }],
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

describe('AgentHistoryManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records FIFO history buckets without leaking private fields', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const manager = new AgentHistoryManager({
      workerBaseUrl: new URL('https://relay.example.com'),
      authKey: 'publish-key',
      fetchImpl,
    });

    manager.recordEvent(actionStartedEvent('evt-1', 100));
    manager.recordEvent({
      event_id: 'evt-2',
      type: 'movement_completed',
      occurred_at: 200,
      agent_id: 'alice',
      agent_name: 'Alice',
      node_id: '1-2',
      delivered_server_event_ids: [],
    });
    manager.recordEvent({
      event_id: 'evt-3',
      type: 'conversation_message',
      occurred_at: 300,
      conversation_id: 'conv-1',
      speaker_agent_id: 'alice',
      listener_agent_ids: ['bob'],
      turn: 1,
      message: 'hello',
    });

    const history = manager.getHistory('alice');
    expect(history.items.map((entry) => entry.event_id)).toEqual(['evt-2']);
    expect(history.recent_actions.map((entry) => entry.event_id)).toEqual(['evt-1']);
    expect(history.recent_conversations.map((entry) => entry.event_id)).toEqual(['evt-3']);
    expect(history.recent_actions[0]?.detail).toEqual({
      type: 'action_started',
    });

    await vi.runAllTimersAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('dedupes repeated events and preserves buffered entries until the next successful publish', async () => {
    vi.useFakeTimers();
    let shouldFail = true;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      if (shouldFail) {
        throw new Error('offline');
      }
      return new Response(init?.body, { status: 204 });
    });
    const logger = { error: vi.fn() };
    const manager = new AgentHistoryManager({
      workerBaseUrl: new URL('https://relay.example.com'),
      authKey: 'publish-key',
      fetchImpl,
      logger,
      maxBufferedEntriesPerAgent: 3,
    });

    manager.recordEvent(actionStartedEvent('evt-1', 100));
    manager.recordEvent(actionStartedEvent('evt-1', 100));
    manager.recordEvent(actionStartedEvent('evt-2', 200));
    manager.recordEvent(actionStartedEvent('evt-3', 300));
    manager.recordEvent(actionStartedEvent('evt-4', 350));
    await vi.runAllTimersAsync();

    expect(logger.error).toHaveBeenCalledWith('HISTORY_BUFFER_OVERFLOW', {
      agent_id: 'alice',
      dropped: 1,
    });
    expect(manager.getHistory('alice').recent_actions.map((entry) => entry.event_id)).toEqual(['evt-4', 'evt-3', 'evt-2', 'evt-1']);

    shouldFail = false;
    manager.recordEvent({
      event_id: 'evt-5',
      type: 'conversation_message',
      occurred_at: 400,
      conversation_id: 'conv-1',
      speaker_agent_id: 'alice',
      listener_agent_ids: ['bob'],
      turn: 2,
      message: 'retry',
    });
    await vi.runAllTimersAsync();

    const alicePublish = fetchImpl.mock.calls
      .map((call) => JSON.parse(String(call[1]?.body)) as { agent_id: string; events: Array<{ event_id: string }> })
      .filter((body) => body.agent_id === 'alice')
      .at(-1);
    expect(alicePublish).toBeDefined();
    expect(alicePublish?.agent_id).toBe('alice');
    expect(alicePublish?.events.map((entry) => entry.event_id)).toEqual(['evt-3', 'evt-4', 'evt-5']);
    expect(logger.error).toHaveBeenCalledWith('AGENT_HISTORY_PUBLISH_FAILED', {
      agent_id: 'alice',
      error: 'offline',
    });
    const bobPublish = fetchImpl.mock.calls
      .map((call) => JSON.parse(String(call[1]?.body)) as { agent_id: string; events: Array<{ event_id: string }> })
      .filter((body) => body.agent_id === 'bob')
      .at(-1);
    expect(bobPublish).toBeDefined();
    expect(bobPublish?.events.map((entry) => entry.event_id)).toEqual(['evt-5']);
  });

  it('schedules a second flush when new events arrive during an in-flight publish', async () => {
    vi.useFakeTimers();
    const firstPublish = createDeferred<Response>();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => firstPublish.promise)
      .mockResolvedValue(new Response(null, { status: 204 }));
    const manager = new AgentHistoryManager({
      workerBaseUrl: new URL('https://relay.example.com'),
      authKey: 'publish-key',
      fetchImpl,
    });

    manager.recordEvent(actionStartedEvent('evt-1', 100));
    await vi.runOnlyPendingTimersAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    manager.recordEvent(actionStartedEvent('evt-2', 200));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    firstPublish.resolve(new Response(null, { status: 204 }));
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const finalPublish = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as {
      agent_id: string;
      events: Array<{ event_id: string }>;
    };
    expect(finalPublish.agent_id).toBe('alice');
    expect(finalPublish.events.map((entry) => entry.event_id)).toEqual(['evt-2']);
  });

  it('clears the dispose timeout when an in-flight flush finishes early', async () => {
    vi.useFakeTimers();
    const publish = createDeferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => publish.promise);
    const manager = new AgentHistoryManager({
      workerBaseUrl: new URL('https://relay.example.com'),
      authKey: 'publish-key',
      fetchImpl,
    });

    manager.recordEvent(actionStartedEvent('evt-1', 100));
    await vi.runOnlyPendingTimersAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const disposePromise = manager.dispose();
    expect(vi.getTimerCount()).toBe(1);

    publish.resolve(new Response(null, { status: 204 }));
    await Promise.resolve();
    await disposePromise;

    expect(vi.getTimerCount()).toBe(0);
  });
});
