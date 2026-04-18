import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';

import relayWorker, { type RelayWorkerEnv } from '../src/index.js';
import { sanitize, type PersistedSpectatorEvent, type PersistedSpectatorEventType } from '../src/contracts/persisted-spectator-event.js';
import type { WorldEvent } from '../src/contracts/world-event.js';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  type HistoryEntry,
  type PersistedHistoryEntry,
} from '../src/history/api.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../src/relay/bridge.js';

const schemaPath = fileURLToPath(new URL('../../schema/history.sql', import.meta.url));

type SeededEvent = {
  worldEvent: WorldEvent;
  agentIds: string[];
  conversationIds?: string[];
};

class SqlitePreparedStatement implements D1PreparedStatementLike {
  constructor(
    private readonly db: DatabaseSync,
    private readonly query: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new SqlitePreparedStatement(this.db, this.query, values);
  }

  async all() {
    return {
      results: this.db.prepare(this.query).all(...(this.values as SQLInputValue[])),
    };
  }
}

class SqliteHistoryDb implements D1DatabaseLike {
  readonly sqlite = new DatabaseSync(':memory:');

  constructor() {
    this.sqlite.exec(readFileSync(schemaPath, 'utf8'));
  }

  prepare(query: string): D1PreparedStatementLike {
    return new SqlitePreparedStatement(this.sqlite, query.trim());
  }

  close(): void {
    this.sqlite.close();
  }
}

class ThrowingHistoryDb implements D1DatabaseLike {
  prepare(): D1PreparedStatementLike {
    throw new Error('boom');
  }
}

function createRelayEnv(db: D1DatabaseLike) {
  return {
    KW_BASE_URL: 'https://kw.example.com',
    KW_ADMIN_KEY: 'admin-key',
    AUTH_MODE: 'public',
    HISTORY_DB: db,
    UI_BRIDGE: {
      idFromName: () => ({}),
      get: () => ({
        fetch: async () => new Response('proxied', { status: 200 }),
      }),
    },
  } as const;
}

function insertSeededEvents(db: SqliteHistoryDb, seededEvents: readonly SeededEvent[]): void {
  const insertWorldEvent = db.sqlite.prepare(`
    INSERT INTO world_events (
      event_id,
      event_type,
      occurred_at,
      conversation_id,
      server_event_id,
      summary_emoji,
      summary_title,
      summary_text,
      payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertWorldEventAgent = db.sqlite.prepare(`
    INSERT INTO world_event_agents (
      event_id,
      agent_id,
      occurred_at,
      event_type,
      role
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const insertWorldEventConversation = db.sqlite.prepare(`
    INSERT INTO world_event_conversations (
      event_id,
      conversation_id,
      occurred_at,
      event_type
    ) VALUES (?, ?, ?, ?)
  `);

  for (const [index, seededEvent] of seededEvents.entries()) {
    const detail = sanitize(seededEvent.worldEvent);

    if (!detail) {
      throw new Error(`failed to sanitize seeded event: ${seededEvent.worldEvent.type}`);
    }

    insertWorldEvent.run(
      seededEvent.worldEvent.event_id,
      seededEvent.worldEvent.type,
      seededEvent.worldEvent.occurred_at,
      'conversation_id' in seededEvent.worldEvent ? seededEvent.worldEvent.conversation_id : null,
      'server_event_id' in seededEvent.worldEvent ? seededEvent.worldEvent.server_event_id : null,
      `emoji-${index}`,
      `title-${index}`,
      `text-${index}`,
      JSON.stringify(detail),
    );

    seededEvent.agentIds.forEach((agentId, agentIndex) => {
      insertWorldEventAgent.run(
        seededEvent.worldEvent.event_id,
        agentId,
        seededEvent.worldEvent.occurred_at,
        seededEvent.worldEvent.type,
        agentIndex === 0 ? 'subject' : 'participant',
      );
    });

    seededEvent.conversationIds?.forEach((conversationId) => {
      insertWorldEventConversation.run(
        seededEvent.worldEvent.event_id,
        conversationId,
        seededEvent.worldEvent.occurred_at,
        seededEvent.worldEvent.type,
      );
    });
  }
}

function createSeededEvents(): SeededEvent[] {
  return [
    {
      worldEvent: {
        event_id: 'evt-100',
        type: 'action_started',
        occurred_at: 5_000,
        agent_id: 'alice',
        agent_name: 'Alice',
        action_id: 'craft',
        action_name: 'Craft',
        duration_ms: 60_000,
        completes_at: 65_000,
        cost_money: 100,
        items_consumed: [{ item_id: 'wood', quantity: 1 }],
      },
      agentIds: ['alice'],
    },
    {
      worldEvent: {
        event_id: 'evt-099',
        type: 'conversation_message',
        occurred_at: 5_000,
        conversation_id: 'conv-1',
        speaker_agent_id: 'alice',
        listener_agent_ids: ['bob'],
        turn: 2,
        message: 'Hello Bob',
      },
      agentIds: ['alice', 'bob'],
      conversationIds: ['conv-1'],
    },
    {
      worldEvent: {
        event_id: 'evt-090',
        type: 'movement_started',
        occurred_at: 4_000,
        agent_id: 'alice',
        agent_name: 'Alice',
        from_node_id: '1-1',
        to_node_id: '1-2',
        path: ['1-1', '1-2'],
        arrives_at: 4_500,
      },
      agentIds: ['alice'],
    },
    {
      worldEvent: {
        event_id: 'evt-080',
        type: 'conversation_join',
        occurred_at: 3_000,
        conversation_id: 'conv-1',
        agent_id: 'carol',
        agent_name: 'Carol',
        participant_agent_ids: ['alice', 'bob', 'carol'],
      },
      agentIds: ['alice', 'bob', 'carol'],
      conversationIds: ['conv-1'],
    },
    {
      worldEvent: {
        event_id: 'evt-070',
        type: 'conversation_ended',
        occurred_at: 2_000,
        conversation_id: 'conv-1',
        initiator_agent_id: 'alice',
        participant_agent_ids: ['alice', 'bob', 'carol'],
        reason: 'ended_by_agent',
        final_message: 'bye',
        final_speaker_agent_id: 'alice',
      },
      agentIds: ['alice', 'bob', 'carol'],
      conversationIds: ['conv-1'],
    },
  ];
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

  it('rejects invalid scope combinations, invalid limits, and invalid cursors', async () => {
    const db = new SqliteHistoryDb();

    try {
      const env = createRelayEnv(db);

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
      const emptyCursor = await relayWorker.fetch(
        new Request('https://relay.example.com/api/history?agent_id=alice&cursor='),
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
      await expect(readJson(emptyCursor)).resolves.toEqual({
        error: {
          code: 'invalid_cursor',
          message: 'cursor must be base64url(`${occurred_at}:${event_id}`)',
        },
      });
      expect(missingScope.status).toBe(400);
      expect(bothScopes.status).toBe(400);
      expect(invalidLimit.status).toBe(400);
      expect(invalidCursor.status).toBe(400);
      expect(emptyCursor.status).toBe(400);
    } finally {
      db.close();
    }
  });

  it('emits explicit cross-origin CORS headers for allowed Pages origins and credentialed access mode', async () => {
    const db = new SqliteHistoryDb();

    try {
      insertSeededEvents(db, createSeededEvents());
      const publicEnv = {
        ...createRelayEnv(db),
        HISTORY_CORS_ALLOWED_ORIGINS: 'https://ui.example.com',
      };
      const accessEnv = {
        ...createRelayEnv(db),
        AUTH_MODE: 'access' as const,
        HISTORY_CORS_ALLOWED_ORIGINS: 'https://ui.example.com, https://preview-ui.example.com',
      };

      const publicResponse = await relayWorker.fetch(
        new Request('https://relay.example.com/api/history?agent_id=alice&limit=1', {
          headers: {
            Origin: 'https://ui.example.com',
          },
        }),
        publicEnv,
      );
      const accessResponse = await relayWorker.fetch(
        new Request('https://relay.example.com/api/history?agent_id=alice&limit=1', {
          headers: {
            Origin: 'https://preview-ui.example.com',
          },
        }),
        accessEnv,
      );

      expect(publicResponse.headers.get('access-control-allow-origin')).toBe('https://ui.example.com');
      expect(publicResponse.headers.get('access-control-allow-credentials')).toBeNull();
      expect(publicResponse.headers.get('vary')).toContain('Origin');
      expect(accessResponse.headers.get('access-control-allow-origin')).toBe('https://preview-ui.example.com');
      expect(accessResponse.headers.get('access-control-allow-credentials')).toBe('true');
      expect(accessResponse.headers.get('vary')).toContain('Origin');
      await expect(readJson(publicResponse)).resolves.toMatchObject({
        items: [{ event_id: 'evt-100' }],
      });
      await expect(readJson(accessResponse)).resolves.toMatchObject({
        items: [{ event_id: 'evt-100' }],
      });
    } finally {
      db.close();
    }
  });

  it('fails closed for disallowed cross-origin history requests and answers GET preflight with mode-aware headers', async () => {
    const db = new SqliteHistoryDb();

    try {
      insertSeededEvents(db, createSeededEvents());
      const env = {
        ...createRelayEnv(db),
        AUTH_MODE: 'access' as const,
        HISTORY_CORS_ALLOWED_ORIGINS: 'https://ui.example.com',
      };

      const disallowedResponse = await relayWorker.fetch(
        new Request('https://relay.example.com/api/history?agent_id=alice&limit=1', {
          headers: {
            Origin: 'https://other.example.com',
          },
        }),
        env,
      );
      const preflightResponse = await relayWorker.fetch(
        new Request('https://relay.example.com/api/history', {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://ui.example.com',
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'content-type',
          },
        }),
        env,
      );
      const rejectedPreflightResponse = await relayWorker.fetch(
        new Request('https://relay.example.com/api/history', {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://other.example.com',
            'Access-Control-Request-Method': 'GET',
          },
        }),
        env,
      );

      expect(disallowedResponse.headers.get('access-control-allow-origin')).toBeNull();
      expect(disallowedResponse.headers.get('access-control-allow-credentials')).toBeNull();
      expect(disallowedResponse.headers.get('vary')).toContain('Origin');
      expect(preflightResponse.status).toBe(204);
      expect(preflightResponse.headers.get('access-control-allow-origin')).toBe('https://ui.example.com');
      expect(preflightResponse.headers.get('access-control-allow-credentials')).toBe('true');
      expect(preflightResponse.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
      expect(preflightResponse.headers.get('access-control-allow-headers')).toBe('content-type');
      expect(preflightResponse.headers.get('access-control-max-age')).toBe('86400');
      expect(preflightResponse.headers.get('vary')).toContain('Origin');
      expect(preflightResponse.headers.get('vary')).toContain('Access-Control-Request-Headers');
      expect(rejectedPreflightResponse.status).toBe(403);
      expect(rejectedPreflightResponse.headers.get('access-control-allow-origin')).toBeNull();
      expect(rejectedPreflightResponse.headers.get('vary')).toContain('Origin');
    } finally {
      db.close();
    }
  });

  it('returns CORS headers on unexpected internal errors for allowed cross-origin requests', async () => {
    const env = {
      ...createRelayEnv(new ThrowingHistoryDb()),
      HISTORY_CORS_ALLOWED_ORIGINS: 'https://ui.example.com',
    };

    const response = await relayWorker.fetch(
      new Request('https://relay.example.com/api/history?agent_id=alice&limit=1', {
        headers: {
          Origin: 'https://ui.example.com',
        },
      }),
      env,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://ui.example.com');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('vary')).toContain('Origin');
    await expect(readJson(response)).resolves.toEqual({
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred.',
      },
    });
  });

  it('returns a controlled debuggable 500 when AUTH_MODE is invalid before history handling', async () => {
    const db = new SqliteHistoryDb();

    try {
      insertSeededEvents(db, createSeededEvents());
      const env = {
        ...createRelayEnv(db),
        AUTH_MODE: 'broken',
        HISTORY_CORS_ALLOWED_ORIGINS: 'https://ui.example.com',
      } as unknown as RelayWorkerEnv;

      const response = await relayWorker.fetch(
        new Request('https://relay.example.com/api/history?agent_id=alice&limit=1', {
          headers: {
            Origin: 'https://ui.example.com',
          },
        }),
        env,
      );

      expect(response.status).toBe(500);
      expect(response.headers.get('access-control-allow-origin')).toBe('https://ui.example.com');
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
      expect(response.headers.get('vary')).toContain('Origin');
      await expect(readJson(response)).resolves.toEqual({
        error: {
          code: 'internal_error',
          message: 'AUTH_MODE must be public or access',
        },
      });
    } finally {
      db.close();
    }
  });

  it('returns a controlled debuggable 500 when history CORS origins are malformed before history handling', async () => {
    const db = new SqliteHistoryDb();

    try {
      insertSeededEvents(db, createSeededEvents());
      const env = {
        ...createRelayEnv(db),
        HISTORY_CORS_ALLOWED_ORIGINS: 'https://ui.example.com/path',
      };

      const response = await relayWorker.fetch(
        new Request('https://relay.example.com/api/history?agent_id=alice&limit=1', {
          headers: {
            Origin: 'https://ui.example.com',
          },
        }),
        env,
      );

      expect(response.status).toBe(500);
      expect(response.headers.get('access-control-allow-origin')).toBe('https://ui.example.com');
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
      expect(response.headers.get('vary')).toContain('Origin');
      await expect(readJson(response)).resolves.toEqual({
        error: {
          code: 'internal_error',
          message: 'HISTORY_CORS_ALLOWED_ORIGINS entries must be bare origins without path, query, or fragment',
        },
      });
    } finally {
      db.close();
    }
  });

  it('paginates agent timelines with stable append cursors', async () => {
    const db = new SqliteHistoryDb();

    try {
      insertSeededEvents(db, createSeededEvents());
      const env = createRelayEnv(db);

      const firstPageResponse = await relayWorker.fetch(
        new Request('https://relay.example.com/api/history?agent_id=alice&limit=2'),
        env,
      );
      const firstPage = (await readJson(firstPageResponse)) as {
        items: PersistedHistoryEntry[];
        next_cursor?: string;
      };

      const secondPageResponse = await relayWorker.fetch(
        new Request(
          `https://relay.example.com/api/history?agent_id=alice&limit=2&cursor=${encodeURIComponent(firstPage.next_cursor ?? '')}`,
        ),
        env,
      );
      const secondPage = (await readJson(secondPageResponse)) as {
        items: PersistedHistoryEntry[];
        next_cursor?: string;
      };

      const thirdPageResponse = await relayWorker.fetch(
        new Request(
          `https://relay.example.com/api/history?agent_id=alice&limit=2&cursor=${encodeURIComponent(secondPage.next_cursor ?? '')}`,
        ),
        env,
      );
      const thirdPage = (await readJson(thirdPageResponse)) as {
        items: PersistedHistoryEntry[];
        next_cursor?: string;
      };

      expect(firstPage.items.map((item) => item.event_id)).toEqual(['evt-100', 'evt-099']);
      expect(secondPage.items.map((item) => item.event_id)).toEqual(['evt-090', 'evt-080']);
      expect(thirdPage.items.map((item) => item.event_id)).toEqual(['evt-070']);
      expect(firstPage.next_cursor).toBe(encodeHistoryCursor({ occurred_at: 5_000, event_id: 'evt-099' }));
      expect(secondPage.next_cursor).toBe(encodeHistoryCursor({ occurred_at: 3_000, event_id: 'evt-080' }));
      expect(thirdPage.next_cursor).toBeUndefined();
      expect([...firstPage.items, ...secondPage.items, ...thirdPage.items].map((item) => item.event_id)).toEqual([
        'evt-100',
        'evt-099',
        'evt-090',
        'evt-080',
        'evt-070',
      ]);
    } finally {
      db.close();
    }
  });

  it('filters agent and conversation timelines by persisted event type', async () => {
    const db = new SqliteHistoryDb();

    try {
      insertSeededEvents(db, createSeededEvents());
      const env = createRelayEnv(db);

      const agentResponse = await relayWorker.fetch(
        new Request(
          'https://relay.example.com/api/history?agent_id=alice&types=conversation_message,action_started,conversation_message',
        ),
        env,
      );
      const conversationResponse = await relayWorker.fetch(
        new Request('https://relay.example.com/api/history?conversation_id=conv-1&types=conversation_join'),
        env,
      );

      await expect(readJson(agentResponse)).resolves.toMatchObject({
        items: [
          { event_id: 'evt-100', type: 'action_started' },
          { event_id: 'evt-099', type: 'conversation_message' },
        ],
      });
      await expect(readJson(conversationResponse)).resolves.toEqual({
        items: [
          {
            event_id: 'evt-080',
            type: 'conversation_join',
            occurred_at: 3000,
            agent_ids: ['alice', 'bob', 'carol'],
            conversation_id: 'conv-1',
            summary: {
              emoji: 'emoji-3',
              title: 'title-3',
              text: 'text-3',
            },
            detail: {
              type: 'conversation_join',
              conversation_id: 'conv-1',
              agent_id: 'carol',
              agent_name: 'Carol',
              participant_agent_ids: ['alice', 'bob', 'carol'],
            },
          },
        ],
      });
    } finally {
      db.close();
    }
  });

  it('returns sanitized detail payloads that stay aligned with the persisted event allowlist', async () => {
    const db = new SqliteHistoryDb();

    try {
      const seededEvents = createSeededEvents();
      insertSeededEvents(db, seededEvents);
      const env = createRelayEnv(db);

      const response = await relayWorker.fetch(
        new Request('https://relay.example.com/api/history?agent_id=alice&types=action_started'),
        env,
      );
      const payload = (await readJson(response)) as {
        items: PersistedHistoryEntry[];
      };

      expect(payload.items[0].detail).toEqual(sanitize(seededEvents[0].worldEvent));
      expect(payload.items[0].detail).toMatchInlineSnapshot(`
        {
          "action_id": "craft",
          "action_name": "Craft",
          "agent_id": "alice",
          "agent_name": "Alice",
          "completes_at": 65000,
          "duration_ms": 60000,
          "type": "action_started",
        }
      `);
    } finally {
      db.close();
    }
  });

  it('keeps history entry types narrow while the public detail shape stays generic', () => {
    expectTypeOf<HistoryEntry['type']>().toEqualTypeOf<PersistedSpectatorEventType>();
    expectTypeOf<HistoryEntry['detail']>().toEqualTypeOf<Record<string, unknown>>();
    expectTypeOf<PersistedHistoryEntry['type']>().toEqualTypeOf<PersistedSpectatorEventType>();
    expectTypeOf<PersistedHistoryEntry['detail']>().toEqualTypeOf<PersistedSpectatorEvent>();
  });
});
