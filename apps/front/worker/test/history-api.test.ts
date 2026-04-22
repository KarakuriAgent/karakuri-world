import { describe, expect, it } from 'vitest';

import relayWorker, { type RelayWorkerEnv } from '../src/index.js';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  type PersistedHistoryEntry,
} from '../src/history/api.js';
import type { R2BucketLike, R2ObjectBodyLike } from '../src/relay/bridge.js';

class FakeR2Object implements R2ObjectBodyLike {
  constructor(private readonly body: string) {}

  async text(): Promise<string> {
    return this.body;
  }
}

class FakeR2Bucket implements R2BucketLike {
  constructor(
    private readonly objects: Record<string, unknown>,
    private readonly options: { throwOnGet?: boolean } = {},
  ) {}

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    if (this.options.throwOnGet) {
      throw new Error('boom');
    }

    if (!(key in this.objects)) {
      return null;
    }

    return new FakeR2Object(JSON.stringify(this.objects[key]));
  }

  async put(): Promise<unknown> {
    return undefined;
  }
}

function historyEntry(overrides: Partial<PersistedHistoryEntry> & Pick<PersistedHistoryEntry, 'event_id' | 'type' | 'occurred_at'>): PersistedHistoryEntry {
  const baseDetail =
    overrides.type === 'conversation_message'
      ? {
          type: 'conversation_message' as const,
          conversation_id: 'conv-1',
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
    ...overrides,
    event_id: overrides.event_id,
    type: overrides.type,
    occurred_at: overrides.occurred_at,
    agent_ids: ['alice'],
    summary: {
      emoji: '🧪',
      title: 'test',
      text: 'test payload',
    },
    detail: baseDetail,
    ...(overrides.conversation_id ? { conversation_id: overrides.conversation_id } : {}),
  } as PersistedHistoryEntry;
}

function createRelayEnv(bucket?: R2BucketLike) {
  return {
    KW_BASE_URL: 'https://kw.example.com',
    KW_ADMIN_KEY: 'admin-key',
    AUTH_MODE: 'public',
    SNAPSHOT_BUCKET: bucket,
    UI_BRIDGE: {
      idFromName: () => ({}),
      get: () => ({
        fetch: async () => new Response('proxied', { status: 200 }),
      }),
    },
  } as const;
}

async function readJson(response: Response): Promise<unknown> {
  return JSON.parse(await response.text()) as unknown;
}

describe('GET /api/history', () => {
  it('round-trips cursors', () => {
    const cursor = {
      occurred_at: 1_750_000_000_000,
      event_id: 'evt-123',
    };

    expect(decodeHistoryCursor(encodeHistoryCursor(cursor))).toEqual(cursor);
  });

  it('rejects invalid scope combinations, limits, and cursors', async () => {
    const env = createRelayEnv(new FakeR2Bucket({}));

    const missingScope = await relayWorker.fetch(new Request('https://relay.example.com/api/history'), env);
    const bothScopes = await relayWorker.fetch(
      new Request('https://relay.example.com/api/history?agent_id=alice&conversation_id=conv-1'),
      env,
    );
    const invalidLimit = await relayWorker.fetch(
      new Request('https://relay.example.com/api/history?agent_id=alice&limit=0'),
      env,
    );
    const invalidCursor = await relayWorker.fetch(
      new Request('https://relay.example.com/api/history?agent_id=alice&cursor=not-base64url'),
      env,
    );

    await expect(readJson(missingScope)).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'exactly one of agent_id or conversation_id is required',
      },
    });
    await expect(readJson(bothScopes)).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'exactly one of agent_id or conversation_id is required',
      },
    });
    await expect(readJson(invalidLimit)).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'limit must be an integer between 1 and 100',
      },
    });
    await expect(readJson(invalidCursor)).resolves.toEqual({
      error: {
        code: 'invalid_cursor',
        message: 'cursor must be base64url(`${occurred_at}:${event_id}`)',
      },
    });
  });

  it('reads agent history from R2, filters types, and paginates with stable cursors', async () => {
    const first = historyEntry({ event_id: 'evt-3', type: 'action_started', occurred_at: 3_000 });
    const second = historyEntry({ event_id: 'evt-2', type: 'conversation_message', occurred_at: 2_000, conversation_id: 'conv-1', agent_ids: ['alice', 'bob'] });
    const third = historyEntry({ event_id: 'evt-1', type: 'action_started', occurred_at: 1_000 });
    const bucket = new FakeR2Bucket({
      'history/agents/alice.json': {
        recent_actions: [first, third],
        recent_conversations: [second],
      },
    });
    const env = createRelayEnv(bucket);

    const firstPage = await relayWorker.fetch(
      new Request('https://relay.example.com/api/history?agent_id=alice&types=action_started,conversation_message&limit=2'),
      env,
    );
    const firstPageJson = (await readJson(firstPage)) as {
      items: PersistedHistoryEntry[];
      next_cursor?: string;
    };

    expect(firstPageJson.items.map((item) => item.event_id)).toEqual(['evt-3', 'evt-2']);
    expect(firstPageJson.next_cursor).toBeDefined();

    const secondPage = await relayWorker.fetch(
      new Request(
        `https://relay.example.com/api/history?agent_id=alice&types=action_started,conversation_message&limit=2&cursor=${firstPageJson.next_cursor}`,
      ),
      env,
    );

    await expect(readJson(secondPage)).resolves.toEqual({
      items: [third],
    });
  });

  it('dedupes agent history rows by event_id across mixed legacy document sections', async () => {
    const duplicate = historyEntry({ event_id: 'evt-2', type: 'action_started', occurred_at: 2_000 });
    const newest = historyEntry({ event_id: 'evt-3', type: 'conversation_message', occurred_at: 3_000, conversation_id: 'conv-1', agent_ids: ['alice', 'bob'] });
    const oldest = historyEntry({ event_id: 'evt-1', type: 'action_started', occurred_at: 1_000 });
    const bucket = new FakeR2Bucket({
      'history/agents/alice.json': {
        items: [duplicate, oldest],
        recent_actions: [duplicate],
        recent_conversations: [newest],
      },
    });
    const env = createRelayEnv(bucket);

    const response = await relayWorker.fetch(
      new Request('https://relay.example.com/api/history?agent_id=alice&limit=10'),
      env,
    );
    const payload = (await readJson(response)) as { items: PersistedHistoryEntry[] };

    expect(payload.items.map((item) => item.event_id)).toEqual(['evt-3', 'evt-2', 'evt-1']);
  });

  it('reads conversation history from the conversation R2 object', async () => {
    const message = historyEntry({
      event_id: 'evt-10',
      type: 'conversation_message',
      occurred_at: 10_000,
      conversation_id: 'conv-1',
      agent_ids: ['alice', 'bob'],
    });
    const bucket = new FakeR2Bucket({
      'history/conversations/conv-1.json': {
        items: [message],
      },
    });
    const env = createRelayEnv(bucket);

    const response = await relayWorker.fetch(
      new Request('https://relay.example.com/api/history?conversation_id=conv-1&limit=50'),
      env,
    );

    await expect(readJson(response)).resolves.toEqual({
      items: [message],
    });
  });

  it('distinguishes an R2 miss from an internal R2 failure', async () => {
    const missEnv = createRelayEnv(new FakeR2Bucket({}));
    const missResponse = await relayWorker.fetch(
      new Request('https://relay.example.com/api/history?agent_id=alice&limit=1'),
      missEnv,
    );
    await expect(readJson(missResponse)).resolves.toEqual({
      items: [],
      hydration: 'never-recorded',
    });

    const errorEnv = createRelayEnv(new FakeR2Bucket({}, { throwOnGet: true }));
    const errorResponse = await relayWorker.fetch(
      new Request('https://relay.example.com/api/history?agent_id=alice&limit=1'),
      errorEnv,
    );
    expect(errorResponse.status).toBe(500);
    await expect(readJson(errorResponse)).resolves.toEqual({
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred.',
      },
    });
  });

  it('emits explicit cross-origin CORS headers for allowed Pages origins and credentialed access mode', async () => {
    const bucket = new FakeR2Bucket({
      'history/agents/alice.json': {
        items: [historyEntry({ event_id: 'evt-1', type: 'action_started', occurred_at: 1_000 })],
      },
    });
    const publicEnv = {
      ...createRelayEnv(bucket),
      HISTORY_CORS_ALLOWED_ORIGINS: 'https://ui.example.com',
    };
    const accessEnv = {
      ...createRelayEnv(bucket),
      AUTH_MODE: 'access' as const,
      HISTORY_CORS_ALLOWED_ORIGINS: 'https://ui.example.com, https://preview-ui.example.com',
    };

    const publicResponse = await relayWorker.fetch(
      new Request('https://relay.example.com/api/history?agent_id=alice&limit=1', {
        headers: { Origin: 'https://ui.example.com' },
      }),
      publicEnv,
    );
    const accessResponse = await relayWorker.fetch(
      new Request('https://relay.example.com/api/history?agent_id=alice&limit=1', {
        headers: { Origin: 'https://preview-ui.example.com' },
      }),
      accessEnv,
    );

    expect(publicResponse.headers.get('access-control-allow-origin')).toBe('https://ui.example.com');
    expect(publicResponse.headers.get('access-control-allow-credentials')).toBeNull();
    expect(accessResponse.headers.get('access-control-allow-origin')).toBe('https://preview-ui.example.com');
    expect(accessResponse.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('returns a controlled 500 when SNAPSHOT_BUCKET is unavailable', async () => {
    const env = createRelayEnv(undefined) as unknown as RelayWorkerEnv;

    const response = await relayWorker.fetch(
      new Request('https://relay.example.com/api/history?agent_id=alice&limit=1'),
      env,
    );

    expect(response.status).toBe(500);
    await expect(readJson(response)).resolves.toEqual({
      error: {
        code: 'internal_error',
        message: 'SNAPSHOT_BUCKET is required for GET /api/history',
      },
    });
  });
});
