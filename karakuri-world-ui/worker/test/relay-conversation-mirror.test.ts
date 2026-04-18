import { describe, expect, it, vi } from 'vitest';

import {
  UIBridgeDurableObject,
  stageConversationMirrorUpdate,
  type BridgeConversationState,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type DurableObjectStateLike,
  type RelayBindings,
  type RelayWebSocketCloseEvent,
  type RelayWebSocket,
  type StagedConversationMirrorUpdate,
} from '../src/relay/bridge.js';

class FakeWebSocket implements RelayWebSocket {
  private readonly listeners: {
    message: Array<(event: { data: unknown }) => void>;
    close: Array<(event: RelayWebSocketCloseEvent) => void>;
    error: Array<(event: unknown) => void>;
  } = {
    message: [],
    close: [],
    error: [],
  };

  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: RelayWebSocketCloseEvent) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: ((event: { data: unknown }) => void) | ((event: RelayWebSocketCloseEvent) => void) | ((event: unknown) => void),
  ): void {
    this.listeners[type].push(listener as never);
  }

  emitMessage(payload: unknown): void {
    const event = { data: JSON.stringify(payload) };

    for (const listener of this.listeners.message) {
      listener(event);
    }
  }
}

class FakeDurableObjectState implements DurableObjectStateLike {
  readonly alarmCalls: number[] = [];
  private readonly values = new Map<string, unknown>();

  readonly storage = {
    setAlarm: async (scheduledTime: number) => {
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

function createWorldSnapshot(
  participants: string[] = ['alice', 'bob'],
  currentSpeakerAgentId = participants[0] ?? 'alice',
  generatedAt = 1_750_000_000_000,
) {
  return {
    world: {
      name: 'Karakuri World',
      description: 'Relay conversation mirror test fixture',
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
      {
        agent_id: 'bob',
        agent_name: 'Bob',
        node_id: '1-1' as const,
        state: 'idle' as const,
        discord_channel_id: 'discord-channel-2',
        money: 500,
        items: [],
        status_emoji: '🙂',
      },
      {
        agent_id: 'carol',
        agent_name: 'Carol',
        node_id: '1-1' as const,
        state: 'idle' as const,
        discord_channel_id: 'discord-channel-3',
        money: 500,
        items: [],
        status_emoji: '🙂',
      },
    ],
    conversations: [
      {
        conversation_id: 'conv-1',
        status: 'active' as const,
        participant_agent_ids: participants,
        current_speaker_agent_id: currentSpeakerAgentId,
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

class FakeHistoryDb implements D1DatabaseLike {
  readonly batches: Array<Array<{ query: string; values: unknown[] }>> = [];

  constructor(private readonly batchImpl: (statements: Array<{ query: string; values: unknown[] }>) => Promise<void> = async () => {}) {}

  prepare(query: string) {
    return {
      bind: (...values: unknown[]) => ({
        query,
        values,
        all: async () => ({ results: [] }),
      }),
      all: async () => ({ results: [] }),
    };
  }

  async batch(statements: D1PreparedStatementLike[]) {
    const boundStatements = statements as Array<D1PreparedStatementLike & { query: string; values: unknown[] }>;
    this.batches.push(boundStatements.map((statement) => ({ query: statement.query, values: [...statement.values] })));
    await this.batchImpl(boundStatements.map((statement) => ({ query: statement.query, values: [...statement.values] })));
  }
}

describe('relay conversation mirror', () => {
  it('stages conversation state transitions and resolves participants from the next mirror state', () => {
    let mirror: Record<string, BridgeConversationState> = {};

    const requested = stageConversationMirrorUpdate(mirror, {
      event_id: 'event-1',
      type: 'conversation_requested',
      occurred_at: 1_750_000_010_000,
      conversation_id: 'conv-1',
      initiator_agent_id: 'alice',
      target_agent_id: 'bob',
      message: 'hello',
    });
    expect(requested.next_conversations['conv-1']).toMatchObject({
      status: 'pending',
      participant_agent_ids: ['alice', 'bob'],
      initiator_agent_id: 'alice',
    });
    expect(requested.resolved_agent_ids).toEqual(['alice', 'bob']);
    mirror = requested.next_conversations;

    const accepted = stageConversationMirrorUpdate(mirror, {
      event_id: 'event-2',
      type: 'conversation_accepted',
      occurred_at: 1_750_000_020_000,
      conversation_id: 'conv-1',
      initiator_agent_id: 'alice',
      participant_agent_ids: ['alice', 'bob'],
    });
    expect(accepted.next_conversations['conv-1']).toMatchObject({
      status: 'active',
      participant_agent_ids: ['alice', 'bob'],
      initiator_agent_id: 'alice',
    });
    mirror = accepted.next_conversations;

    const turnStarted = stageConversationMirrorUpdate(mirror, {
      event_id: 'event-3',
      type: 'conversation_turn_started',
      occurred_at: 1_750_000_030_000,
      conversation_id: 'conv-1',
      current_speaker_agent_id: 'bob',
    });
    expect(turnStarted.next_conversations['conv-1']).toMatchObject({
      current_speaker_agent_id: 'bob',
      participant_agent_ids: ['alice', 'bob'],
    });
    expect(turnStarted.resolved_agent_ids).toEqual(['bob', 'alice']);
    mirror = turnStarted.next_conversations;

    const joined = stageConversationMirrorUpdate(mirror, {
      event_id: 'event-4',
      type: 'conversation_join',
      occurred_at: 1_750_000_040_000,
      conversation_id: 'conv-1',
      agent_id: 'carol',
      agent_name: 'Carol',
      participant_agent_ids: ['alice', 'bob', 'carol'],
    });
    expect(joined.next_conversations['conv-1']).toMatchObject({
      status: 'active',
      participant_agent_ids: ['alice', 'bob', 'carol'],
      current_speaker_agent_id: 'bob',
    });
    mirror = joined.next_conversations;

    const inactiveCheck = stageConversationMirrorUpdate(mirror, {
      event_id: 'event-5',
      type: 'conversation_inactive_check',
      occurred_at: 1_750_000_050_000,
      conversation_id: 'conv-1',
      target_agent_ids: ['carol'],
    });
    expect(inactiveCheck.resolved_agent_ids).toEqual(['carol', 'alice', 'bob']);
    expect(inactiveCheck.next_conversations['conv-1'].participant_agent_ids).toEqual(['alice', 'bob', 'carol']);
    mirror = inactiveCheck.next_conversations;

    const left = stageConversationMirrorUpdate(mirror, {
      event_id: 'event-6',
      type: 'conversation_leave',
      occurred_at: 1_750_000_060_000,
      conversation_id: 'conv-1',
      agent_id: 'bob',
      agent_name: 'Bob',
      reason: 'voluntary',
      participant_agent_ids: ['alice', 'carol'],
      next_speaker_agent_id: 'alice',
    });
    expect(left.next_conversations['conv-1']).toMatchObject({
      participant_agent_ids: ['alice', 'carol'],
      current_speaker_agent_id: 'alice',
    });
    mirror = left.next_conversations;

    const closing = stageConversationMirrorUpdate(mirror, {
      event_id: 'event-7',
      type: 'conversation_closing',
      occurred_at: 1_750_000_070_000,
      conversation_id: 'conv-1',
      initiator_agent_id: 'alice',
      participant_agent_ids: ['alice', 'carol'],
      current_speaker_agent_id: 'alice',
      reason: 'ended_by_agent',
    });
    expect(closing.next_conversations['conv-1']).toMatchObject({
      status: 'closing',
      participant_agent_ids: ['alice', 'carol'],
      current_speaker_agent_id: 'alice',
      closing_reason: 'ended_by_agent',
    });
    mirror = closing.next_conversations;

    const ended = stageConversationMirrorUpdate(mirror, {
      event_id: 'event-8',
      type: 'conversation_ended',
      occurred_at: 1_750_000_080_000,
      conversation_id: 'conv-1',
      initiator_agent_id: 'alice',
      participant_agent_ids: ['alice', 'carol'],
      reason: 'ended_by_agent',
      final_speaker_agent_id: 'alice',
    });
    expect(ended.next_conversations).toEqual({});
    expect(ended.resolved_conversation).toMatchObject({
      status: 'closing',
      participant_agent_ids: ['alice', 'carol'],
      current_speaker_agent_id: 'alice',
      closing_reason: 'ended_by_agent',
    });
    expect(ended.resolved_agent_ids).toEqual(['alice', 'carol']);
  });

  it('commits staged conversation updates only after event persistence succeeds', async () => {
    const now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const persistDeferred = createDeferred<void>();
    const persistWorldEvent = vi.fn(async () => persistDeferred.promise);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ invalid: true }),
      })
      .mockResolvedValueOnce({
        status: 101,
        webSocket: socket,
      })
      .mockResolvedValueOnce(createJsonResponse({ invalid: true }));
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      } satisfies RelayBindings,
      {
        fetchImpl,
        now: () => now,
        persistWorldEvent,
      },
    );

    await bridge.whenBooted();
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(['alice', 'bob'], 'alice'),
    });

    socket.emitMessage({
      type: 'event',
      data: {
        event_id: 'event-1',
        type: 'conversation_turn_started',
        occurred_at: 1_750_000_060_000,
        conversation_id: 'conv-1',
        current_speaker_agent_id: 'bob',
      },
    });

    await vi.waitFor(() => {
      expect(persistWorldEvent).toHaveBeenCalledTimes(1);
    });

    expect(bridge.getDebugState().conversations['conv-1']).toMatchObject({
      current_speaker_agent_id: 'alice',
      participant_agent_ids: ['alice', 'bob'],
    });
    const [, stagedTurnUpdate] = persistWorldEvent.mock.calls[0] as unknown as [
      unknown,
      StagedConversationMirrorUpdate | undefined,
    ];
    expect(stagedTurnUpdate?.resolved_agent_ids).toEqual(['bob', 'alice']);

    persistDeferred.resolve();

    await vi.waitFor(() => {
      expect(bridge.getDebugState().conversations['conv-1']).toMatchObject({
        current_speaker_agent_id: 'bob',
        participant_agent_ids: ['alice', 'bob'],
      });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
  });

  it('serializes back-to-back world events before staging the next mirror update', async () => {
    const now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const firstPersistDeferred = createDeferred<void>();
    const persistWorldEvent = vi
      .fn<(...args: unknown[]) => Promise<void>>()
      .mockImplementationOnce(async () => firstPersistDeferred.promise)
      .mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ invalid: true }),
      })
      .mockResolvedValueOnce({
        status: 101,
        webSocket: socket,
      })
      .mockResolvedValueOnce(createJsonResponse({ invalid: true }))
      .mockResolvedValueOnce(createJsonResponse({ invalid: true }));
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      } satisfies RelayBindings,
      {
        fetchImpl,
        now: () => now,
        persistWorldEvent,
      },
    );

    await bridge.whenBooted();
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(['alice', 'bob'], 'alice'),
    });
    socket.emitMessage({
      type: 'event',
      data: {
        event_id: 'event-1',
        type: 'conversation_join',
        occurred_at: 1_750_000_060_000,
        conversation_id: 'conv-1',
        agent_id: 'carol',
        agent_name: 'Carol',
        participant_agent_ids: ['alice', 'bob', 'carol'],
      },
    });
    socket.emitMessage({
      type: 'event',
      data: {
        event_id: 'event-2',
        type: 'conversation_turn_started',
        occurred_at: 1_750_000_070_000,
        conversation_id: 'conv-1',
        current_speaker_agent_id: 'carol',
      },
    });

    await vi.waitFor(() => {
      expect(persistWorldEvent).toHaveBeenCalledTimes(1);
    });

    expect(bridge.getDebugState().conversations['conv-1']).toMatchObject({
      participant_agent_ids: ['alice', 'bob'],
      current_speaker_agent_id: 'alice',
    });

    firstPersistDeferred.resolve();

    await vi.waitFor(() => {
      expect(persistWorldEvent).toHaveBeenCalledTimes(2);
      expect(bridge.getDebugState().conversations['conv-1']).toMatchObject({
        participant_agent_ids: ['alice', 'bob', 'carol'],
        current_speaker_agent_id: 'carol',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    });

    const [, stagedTurnUpdate] = persistWorldEvent.mock.calls[1] as unknown as [
      unknown,
      StagedConversationMirrorUpdate | undefined,
    ];
    expect(stagedTurnUpdate?.resolved_agent_ids).toEqual(['carol', 'alice', 'bob']);
    expect(stagedTurnUpdate?.resolved_conversation).toMatchObject({
      participant_agent_ids: ['alice', 'bob', 'carol'],
      current_speaker_agent_id: 'carol',
    });
  });

  it('serializes later snapshot messages behind an in-flight world event', async () => {
    const now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const persistDeferred = createDeferred<void>();
    const persistWorldEvent = vi.fn(async () => persistDeferred.promise);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ invalid: true }),
      })
      .mockResolvedValueOnce({
        status: 101,
        webSocket: socket,
      })
      .mockResolvedValueOnce(createJsonResponse({ invalid: true }));
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      } satisfies RelayBindings,
      {
        fetchImpl,
        now: () => now,
        persistWorldEvent,
      },
    );

    await bridge.whenBooted();
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(['alice', 'bob'], 'alice'),
    });
    socket.emitMessage({
      type: 'event',
      data: {
        event_id: 'event-1',
        type: 'conversation_join',
        occurred_at: 1_750_000_060_000,
        conversation_id: 'conv-1',
        agent_id: 'carol',
        agent_name: 'Carol',
        participant_agent_ids: ['alice', 'bob', 'carol'],
      },
    });
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(['alice', 'bob', 'dave'], 'dave', 1_750_000_090_000),
    });

    await vi.waitFor(() => {
      expect(persistWorldEvent).toHaveBeenCalledTimes(1);
    });

    expect(bridge.getDebugState().conversations['conv-1']).toMatchObject({
      participant_agent_ids: ['alice', 'bob'],
      current_speaker_agent_id: 'alice',
    });
    expect(bridge.getDebugState().latest_snapshot?.generated_at).toBe(1_750_000_000_000);

    persistDeferred.resolve();

    await vi.waitFor(() => {
      expect(bridge.getDebugState().conversations['conv-1']).toMatchObject({
        participant_agent_ids: ['alice', 'bob', 'dave'],
        current_speaker_agent_id: 'dave',
      });
      expect(bridge.getDebugState().latest_snapshot?.generated_at).toBe(1_750_000_090_000);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
  });

  it('rolls back staged mirror updates when event persistence fails', async () => {
    const now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const persistWorldEvent = vi.fn(async () => {
      throw new Error('D1 write failed');
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ invalid: true }),
      })
      .mockResolvedValueOnce({
        status: 101,
        webSocket: socket,
      })
      .mockResolvedValueOnce(createJsonResponse(createWorldSnapshot(['alice', 'bob'], 'alice', 1_750_000_090_000)));
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      } satisfies RelayBindings,
      {
        fetchImpl,
        now: () => now,
        persistWorldEvent,
      },
    );

    await bridge.whenBooted();
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(['alice', 'bob'], 'alice'),
    });

    socket.emitMessage({
      type: 'event',
      data: {
        event_id: 'event-1',
        type: 'conversation_join',
        occurred_at: 1_750_000_060_000,
        conversation_id: 'conv-1',
        agent_id: 'carol',
        agent_name: 'Carol',
        participant_agent_ids: ['alice', 'bob', 'carol'],
      },
    });

    await vi.waitFor(() => {
      expect(persistWorldEvent).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
    await vi.waitFor(() => {
      expect(bridge.getDebugState().latest_snapshot?.generated_at).toBe(1_750_000_090_000);
    });

    expect(bridge.getDebugState().conversations['conv-1']).toMatchObject({
      participant_agent_ids: ['alice', 'bob'],
      current_speaker_agent_id: 'alice',
    });
    expect(bridge.getDebugState().last_event_at).toBeUndefined();
    const [, stagedJoinUpdate] = persistWorldEvent.mock.calls[0] as unknown as [
      unknown,
      StagedConversationMirrorUpdate | undefined,
    ];
    expect(stagedJoinUpdate?.resolved_agent_ids).toEqual(['carol', 'alice', 'bob']);
  });

  it('uses runtime D1 persistence when HISTORY_DB is bound', async () => {
    const now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const batchDeferred = createDeferred<void>();
    const historyDb = new FakeHistoryDb(async () => batchDeferred.promise);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ invalid: true }),
      })
      .mockResolvedValueOnce({
        status: 101,
        webSocket: socket,
      })
      .mockResolvedValueOnce(createJsonResponse({ invalid: true }));
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
        HISTORY_DB: historyDb,
      } satisfies RelayBindings,
      {
        fetchImpl,
        now: () => now,
      },
    );

    await bridge.whenBooted();
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(['alice', 'bob'], 'alice'),
    });
    socket.emitMessage({
      type: 'event',
      data: {
        event_id: 'event-1',
        type: 'conversation_turn_started',
        occurred_at: 1_750_000_060_000,
        conversation_id: 'conv-1',
        current_speaker_agent_id: 'bob',
      },
    });

    await vi.waitFor(() => {
      expect(historyDb.batches).toHaveLength(1);
    });

    expect(bridge.getDebugState().conversations['conv-1']).toMatchObject({
      participant_agent_ids: ['alice', 'bob'],
      current_speaker_agent_id: 'alice',
    });

    batchDeferred.resolve();

    await vi.waitFor(() => {
      expect(bridge.getDebugState().conversations['conv-1']).toMatchObject({
        participant_agent_ids: ['alice', 'bob'],
        current_speaker_agent_id: 'bob',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    const persistedStatements = historyDb.batches[0];
    const worldEventInsert = persistedStatements.find((statement) => statement.query.includes('INSERT INTO world_events'));
    expect(worldEventInsert?.values).toEqual([
      'event-1',
      'conversation_turn_started',
      1_750_000_060_000,
      'conv-1',
      null,
      '🎙️',
      '発言ターン',
      '次の話者: bob',
      JSON.stringify({
        type: 'conversation_turn_started',
        conversation_id: 'conv-1',
        current_speaker_agent_id: 'bob',
      }),
    ]);

    const agentLinkInserts = persistedStatements
      .filter((statement) => statement.query.includes('INSERT INTO world_event_agents'))
      .map((statement) => statement.values);
    expect(agentLinkInserts).toEqual([
      ['event-1', 'bob', 1_750_000_060_000, 'conversation_turn_started', 'subject'],
      ['event-1', 'alice', 1_750_000_060_000, 'conversation_turn_started', 'participant'],
    ]);

    const conversationLinkInsert = persistedStatements.find((statement) =>
      statement.query.includes('INSERT INTO world_event_conversations'),
    );
    expect(conversationLinkInsert?.values).toEqual([
      'event-1',
      'conv-1',
      1_750_000_060_000,
      'conversation_turn_started',
    ]);
  });

  it('persists configured action emojis from the authoritative action config', async () => {
    const now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const historyDb = new FakeHistoryDb();
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
        HISTORY_DB: historyDb,
      } satisfies RelayBindings,
      {
        fetchImpl: vi
          .fn()
          .mockResolvedValueOnce({
            status: 200,
            json: async () => ({ invalid: true }),
          })
          .mockResolvedValueOnce({
            status: 101,
            webSocket: socket,
          })
          .mockResolvedValueOnce(createJsonResponse({ invalid: true })),
        now: () => now,
      },
    );

    await bridge.whenBooted();
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(['alice', 'bob'], 'alice'),
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
      expect(historyDb.batches).toHaveLength(1);
    });

    const persistedStatements = historyDb.batches[0];
    const worldEventInsert = persistedStatements.find((statement) => statement.query.includes('INSERT INTO world_events'));
    expect(worldEventInsert?.values).toEqual([
      'event-1',
      'action_completed',
      1_750_000_060_000,
      null,
      null,
      '🍳',
      'アクション完了',
      'Cook を完了',
      JSON.stringify({
        type: 'action_completed',
        agent_id: 'alice',
        agent_name: 'Alice',
        action_id: 'cook',
        action_name: 'Cook',
      }),
    ]);
  });

  it('rebuilds the authoritative conversation mirror from a later snapshot resync', async () => {
    const now = 1_750_000_050_000;
    const socket = new FakeWebSocket();
    const state = new FakeDurableObjectState();
    const persistWorldEvent = vi.fn(async () => {
      throw new Error('D1 write failed');
    });
    const bridge = new UIBridgeDurableObject(
      state,
      {
        KW_BASE_URL: 'http://127.0.0.1:3000',
        KW_ADMIN_KEY: 'test-admin-key',
      } satisfies RelayBindings,
      {
        fetchImpl: vi.fn(async () => ({
          status: 101,
          webSocket: socket,
        })),
        now: () => now,
        persistWorldEvent,
      },
    );

    await bridge.whenBooted();
    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(['alice', 'bob'], 'alice'),
    });
    socket.emitMessage({
      type: 'event',
      data: {
        event_id: 'event-1',
        type: 'conversation_join',
        occurred_at: 1_750_000_060_000,
        conversation_id: 'conv-1',
        agent_id: 'carol',
        agent_name: 'Carol',
        participant_agent_ids: ['alice', 'bob', 'carol'],
      },
    });

    await vi.waitFor(() => {
      expect(persistWorldEvent).toHaveBeenCalledTimes(1);
    });

    socket.emitMessage({
      type: 'snapshot',
      data: createWorldSnapshot(['alice', 'bob', 'carol'], 'carol', 1_750_000_090_000),
    });

    await vi.waitFor(() => {
      expect(bridge.getDebugState().conversations['conv-1']).toMatchObject({
        participant_agent_ids: ['alice', 'bob', 'carol'],
        current_speaker_agent_id: 'carol',
      });
      expect(bridge.getDebugState().latest_snapshot?.generated_at).toBe(1_750_000_090_000);
    });
  });
});
