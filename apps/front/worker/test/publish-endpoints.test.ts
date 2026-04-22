import { describe, expect, it, vi } from 'vitest';

import relayWorker from '../src/index.js';
import type { PersistedHistoryEntry } from '../src/history/api.js';
import { UIBridgeDurableObject, type DurableObjectStateLike, type R2BucketLike, type R2ObjectBodyLike } from '../src/relay/bridge.js';

class FakeR2Object implements R2ObjectBodyLike {
  constructor(private readonly body: string) {}

  async text(): Promise<string> {
    return this.body;
  }
}

class MutableR2Bucket implements R2BucketLike {
  readonly objects = new Map<string, string>();

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const value = this.objects.get(key);
    return value === undefined ? null : new FakeR2Object(value);
  }

  async put(key: string, value: string): Promise<unknown> {
    this.objects.set(key, value);
    return undefined;
  }
}

class FakeDurableObjectState implements DurableObjectStateLike {
  readonly storage = {
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    get: async () => undefined,
    put: async () => undefined,
    delete: async () => undefined,
  };

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }
}

function createWorldSnapshot(generatedAt = 1_750_000_000_000) {
  return {
    world: { name: 'Karakuri World', description: 'test' },
    calendar: {
      timezone: 'Asia/Tokyo',
      local_date: '2026-06-15',
      local_time: '12:04:05',
      display_label: '2026-06-15 12:04 (Asia/Tokyo)',
    },
    map: {
      rows: 1,
      cols: 1,
      nodes: { '1-1': { type: 'normal', label: 'Square' } },
      buildings: [],
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
    agents: [],
    known_agents: [],
    conversations: [],
    recent_server_events: [],
    generated_at: generatedAt,
  };
}

function historyEntry(overrides: Partial<PersistedHistoryEntry> & Pick<PersistedHistoryEntry, 'event_id' | 'type' | 'occurred_at'>): PersistedHistoryEntry {
  const detail = overrides.type === 'conversation_message'
    ? {
        type: 'conversation_message' as const,
        conversation_id: overrides.conversation_id ?? 'conv-1',
        speaker_agent_id: 'alice',
        listener_agent_ids: ['bob'],
        turn: 1,
        message: 'hello',
      }
    : {
        type: 'action_started' as const,
        agent_id: 'alice',
        agent_name: 'Alice',
        action_id: 'craft',
        action_name: 'Craft',
        duration_ms: 60_000,
        completes_at: overrides.occurred_at + 60_000,
      };

  return {
    event_id: overrides.event_id,
    type: overrides.type,
    occurred_at: overrides.occurred_at,
    agent_ids: overrides.agent_ids ?? ['alice'],
    ...(overrides.conversation_id ? { conversation_id: overrides.conversation_id } : {}),
    summary: overrides.summary ?? {
      emoji: '🧪',
      title: 'test',
      text: 'payload',
    },
    detail,
  } as PersistedHistoryEntry;
}

describe('publish endpoints', () => {
  it('defaults to deny when the publish auth key is unset', async () => {
    const response = await relayWorker.fetch(new Request('https://relay.example.com/api/publish-snapshot', {
      method: 'POST',
      headers: { Authorization: 'Bearer publish-key' },
    }), {
      UI_BRIDGE: {
        idFromName: () => ({}),
        get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
      },
    } as never);

    expect(response.status).toBe(503);
  });

  it('propagates durable object failures without turning them into a silent 200', async () => {
    const stub = {
      fetch: vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 })),
    };
    const response = await relayWorker.fetch(new Request('https://relay.example.com/api/publish-snapshot', {
      method: 'POST',
      headers: { Authorization: 'Bearer publish-key' },
    }), {
      SNAPSHOT_PUBLISH_AUTH_KEY: 'publish-key',
      UI_BRIDGE: {
        idFromName: () => ({}),
        get: () => stub,
      },
    } as never);

    expect(response.status).toBe(500);
    expect(stub.fetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed when snapshot publishing is requested without an R2 bucket binding', async () => {
    const bridge = new UIBridgeDurableObject(
      new FakeDurableObjectState(),
      {
        SNAPSHOT_PUBLISH_AUTH_KEY: 'publish-key',
      },
    );

    const response = await relayWorker.fetch(
      new Request('https://relay.example.com/api/publish-snapshot', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer publish-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(createWorldSnapshot()),
      }),
      {
        SNAPSHOT_PUBLISH_AUTH_KEY: 'publish-key',
        UI_BRIDGE: {
          idFromName: () => ({}),
          get: () => ({ fetch: async (request: Request) => bridge.fetch(request) }),
        },
      } as never,
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'publish_failed' });
  });

  it('publishes per-agent history and materializes conversation scope from the same append path', async () => {
    const bucket = new MutableR2Bucket();
    const bridge = new UIBridgeDurableObject(
      new FakeDurableObjectState(),
      {
        SNAPSHOT_BUCKET: bucket,
        SNAPSHOT_PUBLISH_AUTH_KEY: 'publish-key',
      },
      {
        publishSnapshot: vi.fn(async () => undefined),
      },
    );
    const env = {
      SNAPSHOT_PUBLISH_AUTH_KEY: 'publish-key',
      SNAPSHOT_BUCKET: bucket,
      UI_BRIDGE: {
        idFromName: () => ({}),
        get: () => ({ fetch: async (request: Request) => bridge.fetch(request) }),
      },
    } as never;

    const action = historyEntry({ event_id: 'evt-1', type: 'action_started', occurred_at: 1_000 });
    const message = historyEntry({
      event_id: 'evt-2',
      type: 'conversation_message',
      occurred_at: 2_000,
      conversation_id: 'conv-1',
      agent_ids: ['alice', 'bob'],
    });

    const publishResponse = await relayWorker.fetch(new Request('https://relay.example.com/api/publish-agent-history', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer publish-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: 'alice',
        events: [action, message],
      }),
    }), env);
    expect(publishResponse.status).toBe(204);

    const agentHistory = await relayWorker.fetch(new Request('https://relay.example.com/api/history?agent_id=alice&limit=10'), env);
    await expect(agentHistory.json()).resolves.toEqual({
      items: [message, action],
    });

    const conversationHistory = await relayWorker.fetch(new Request('https://relay.example.com/api/history?conversation_id=conv-1&limit=10'), env);
    await expect(conversationHistory.json()).resolves.toEqual({
      items: [message],
    });
    expect(bucket.objects.has('history/agents/alice.json')).toBe(true);
    expect(bucket.objects.has('history/conversations/conv-1.json')).toBe(true);
  });

  it('returns 404 for removed legacy /ws requests that reach the durable object fallback path', async () => {
    const bridge = new UIBridgeDurableObject(new FakeDurableObjectState(), {});

    const response = await bridge.fetch(new Request('https://relay.example.com/ws'));

    expect(response.status).toBe(404);
  });
});
