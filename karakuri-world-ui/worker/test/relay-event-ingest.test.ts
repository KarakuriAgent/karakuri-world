import { describe, expect, it, vi } from 'vitest';

import {
  createRuntimePersistWorldEvent,
  stageConversationMirrorUpdate,
  type BridgeConversationState,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from '../src/relay/bridge.js';

class SqlitePreparedStatement implements D1PreparedStatementLike {
  constructor(
    private readonly database: InMemoryHistoryDb,
    readonly query: string,
    readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new SqlitePreparedStatement(this.database, this.query, values);
  }

  async all() {
    return {
      results: this.database.read(this.query, this.values),
    };
  }
}

interface WorldEventRow {
  event_id: string;
  event_type: string;
  occurred_at: number;
  conversation_id: string | null;
  server_event_id: string | null;
  summary_emoji: string;
  summary_title: string;
  summary_text: string;
  payload_json: string;
}

interface WorldEventAgentRow {
  event_id: string;
  agent_id: string;
  occurred_at: number;
  event_type: string;
  role: string;
}

interface WorldEventConversationRow {
  event_id: string;
  conversation_id: string;
  occurred_at: number;
  event_type: string;
}

interface ServerEventInstanceRow {
  server_event_id: string;
  description: string;
  first_occurred_at: number;
  last_occurred_at: number;
}

interface HistoryState {
  worldEvents: Map<string, WorldEventRow>;
  worldEventAgents: Map<string, WorldEventAgentRow>;
  worldEventConversations: Map<string, WorldEventConversationRow>;
  serverEventInstances: Map<string, ServerEventInstanceRow>;
}

function createObservabilitySpy() {
  const metrics: Array<{ name: string; kind: 'counter' | 'gauge'; value: number; tags?: Record<string, string> }> = [];
  const logs: Array<{ level: 'info' | 'warn' | 'error'; message: string; context?: Record<string, unknown> }> = [];

  return {
    metrics,
    logs,
    observer: {
      counter(name: string, tags?: Record<string, string>, value = 1) {
        metrics.push({ name, kind: 'counter', value, ...(tags ? { tags } : {}) });
      },
      gauge(name: string, value: number, tags?: Record<string, string>) {
        metrics.push({ name, kind: 'gauge', value, ...(tags ? { tags } : {}) });
      },
      log(level: 'info' | 'warn' | 'error', message: string, context?: Record<string, unknown>) {
        logs.push({ level, message, ...(context ? { context } : {}) });
      },
    },
  };
}

class InMemoryHistoryDb implements D1DatabaseLike {
  private state: HistoryState = {
    worldEvents: new Map(),
    worldEventAgents: new Map(),
    worldEventConversations: new Map(),
    serverEventInstances: new Map(),
  };

  constructor(private readonly failAtStatementIndex?: number) {}

  prepare(query: string) {
    return new SqlitePreparedStatement(this, query.trim());
  }

  async batch(statements: D1PreparedStatementLike[]) {
    const preparedStatements = statements as SqlitePreparedStatement[];
    const nextState = this.cloneState();

    try {
      preparedStatements.forEach((statement, index) => {
        if (this.failAtStatementIndex === index) {
          throw new Error('Injected batch failure');
        }

        this.applyStatement(nextState, statement.query, statement.values);
      });

      this.state = nextState;
    } catch (error) {
      throw error;
    }
  }

  read(query: string, values: unknown[] = []): Record<string, unknown>[] {
    const normalizedQuery = query.trim().replace(/\s+/g, ' ');

    if (normalizedQuery.includes('FROM server_event_instances')) {
      return [...this.state.serverEventInstances.values()]
        .sort((left, right) =>
          left.first_occurred_at === right.first_occurred_at
            ? left.server_event_id.localeCompare(right.server_event_id)
            : left.first_occurred_at - right.first_occurred_at,
        )
        .map((row) => ({ ...row }));
    }

    if (normalizedQuery.includes('FROM world_events') && normalizedQuery.includes('WHERE event_id = ?')) {
      const eventId = values[0];
      if (typeof eventId !== 'string') {
        return [];
      }

      const row = this.state.worldEvents.get(eventId);
      return row ? [{ ...row }] : [];
    }

    return [];
  }

  getEventAgentRoles(eventId: string): Array<{ agent_id: string; role: string }> {
    return [...this.state.worldEventAgents.values()]
      .filter((row) => row.event_id === eventId)
      .sort((left, right) => left.agent_id.localeCompare(right.agent_id))
      .map(({ agent_id, role }) => ({ agent_id, role }));
  }

  getServerEventInstances(): ServerEventInstanceRow[] {
    return [...this.state.serverEventInstances.values()]
      .sort((left, right) =>
        left.first_occurred_at === right.first_occurred_at
          ? left.server_event_id.localeCompare(right.server_event_id)
          : left.first_occurred_at - right.first_occurred_at,
      )
      .map((row) => ({ ...row }));
  }

  getWorldEventSummary(eventId: string): Array<{
    summary_emoji: string;
    summary_title: string;
    summary_text: string;
  }> {
    return this.read(
      `
        SELECT summary_emoji, summary_title, summary_text
        FROM world_events
        WHERE event_id = ?
      `,
      [eventId],
    ).map((row) => ({
      summary_emoji: String(row.summary_emoji),
      summary_title: String(row.summary_title),
      summary_text: String(row.summary_text),
    }));
  }

  count(table: 'world_events' | 'world_event_agents' | 'world_event_conversations'): number {
    switch (table) {
      case 'world_events':
        return this.state.worldEvents.size;
      case 'world_event_agents':
        return this.state.worldEventAgents.size;
      case 'world_event_conversations':
        return this.state.worldEventConversations.size;
    }
  }

  close(): void {
    this.state = {
      worldEvents: new Map(),
      worldEventAgents: new Map(),
      worldEventConversations: new Map(),
      serverEventInstances: new Map(),
    };
  }

  private cloneState(): HistoryState {
    return {
      worldEvents: new Map(
        [...this.state.worldEvents.entries()].map(([key, value]) => [key, { ...value }] as const),
      ),
      worldEventAgents: new Map(
        [...this.state.worldEventAgents.entries()].map(([key, value]) => [key, { ...value }] as const),
      ),
      worldEventConversations: new Map(
        [...this.state.worldEventConversations.entries()].map(([key, value]) => [key, { ...value }] as const),
      ),
      serverEventInstances: new Map(
        [...this.state.serverEventInstances.entries()].map(([key, value]) => [key, { ...value }] as const),
      ),
    };
  }

  private applyStatement(state: HistoryState, query: string, values: unknown[]): void {
    if (query.includes('INSERT INTO world_events')) {
      const [
        event_id,
        event_type,
        occurred_at,
        conversation_id,
        server_event_id,
        summary_emoji,
        summary_title,
        summary_text,
        payload_json,
      ] = values;
      state.worldEvents.set(String(event_id), {
        event_id: String(event_id),
        event_type: String(event_type),
        occurred_at: Number(occurred_at),
        conversation_id: conversation_id == null ? null : String(conversation_id),
        server_event_id: server_event_id == null ? null : String(server_event_id),
        summary_emoji: String(summary_emoji),
        summary_title: String(summary_title),
        summary_text: String(summary_text),
        payload_json: String(payload_json),
      });
      return;
    }

    if (query.includes('INSERT INTO world_event_agents')) {
      const [event_id, agent_id, occurred_at, event_type, role] = values;
      state.worldEventAgents.set(`${event_id}:${agent_id}`, {
        event_id: String(event_id),
        agent_id: String(agent_id),
        occurred_at: Number(occurred_at),
        event_type: String(event_type),
        role: String(role),
      });
      return;
    }

    if (query.includes('INSERT INTO world_event_conversations')) {
      const [event_id, conversation_id, occurred_at, event_type] = values;
      state.worldEventConversations.set(`${event_id}:${conversation_id}`, {
        event_id: String(event_id),
        conversation_id: String(conversation_id),
        occurred_at: Number(occurred_at),
        event_type: String(event_type),
      });
      return;
    }

    if (query.includes('INSERT INTO server_event_instances')) {
      const [server_event_id, description, first_occurred_at, last_occurred_at] = values;
      const key = String(server_event_id);
      const existing = state.serverEventInstances.get(key);

      state.serverEventInstances.set(key, {
        server_event_id: key,
        description: existing?.description ?? String(description),
        first_occurred_at: existing
          ? Math.min(existing.first_occurred_at, Number(first_occurred_at))
          : Number(first_occurred_at),
        last_occurred_at: existing
          ? Math.max(existing.last_occurred_at, Number(last_occurred_at))
          : Number(last_occurred_at),
      });
      return;
    }

    throw new Error(`Unsupported query in test history db: ${query}`);
  }
}
describe('relay event ingest', () => {
  it('normalizes overlapping server-event roles with delivered precedence over pending', async () => {
    const historyDb = new InMemoryHistoryDb();
    const persistWorldEvent = createRuntimePersistWorldEvent(historyDb);

    try {
      await persistWorldEvent?.({
        event_id: 'evt-server-role',
        type: 'server_event_fired',
        occurred_at: 1_750_000_070_000,
        server_event_id: 'server-1',
        description: 'Harvest Festival',
        delivered_agent_ids: ['alice'],
        pending_agent_ids: ['alice', 'bob'],
        delayed: false,
      });

      expect(
        historyDb.getEventAgentRoles('evt-server-role'),
      ).toEqual([
        { agent_id: 'alice', role: 'delivered' },
        { agent_id: 'bob', role: 'pending' },
      ]);
    } finally {
      historyDb.close();
    }
  });

  it('folds repeated server_event_fired deliveries into one server_event_instances row', async () => {
    const historyDb = new InMemoryHistoryDb();
    const persistWorldEvent = createRuntimePersistWorldEvent(historyDb);

    try {
      await persistWorldEvent?.({
        event_id: 'evt-server-1',
        type: 'server_event_fired',
        occurred_at: 1_750_000_080_000,
        server_event_id: 'server-1',
        description: 'Harvest Festival',
        delivered_agent_ids: ['alice'],
        pending_agent_ids: [],
        delayed: false,
      });
      await persistWorldEvent?.({
        event_id: 'evt-server-2',
        type: 'server_event_fired',
        occurred_at: 1_750_000_090_000,
        server_event_id: 'server-1',
        description: 'Harvest Festival (replay)',
        delivered_agent_ids: [],
        pending_agent_ids: ['bob'],
        delayed: true,
      });

      expect(
        historyDb.getServerEventInstances(),
      ).toEqual([
        {
          server_event_id: 'server-1',
          description: 'Harvest Festival',
          first_occurred_at: 1_750_000_080_000,
          last_occurred_at: 1_750_000_090_000,
        },
      ]);
    } finally {
      historyDb.close();
    }
  });

  it('keeps action_rejected summaries on the warning emoji instead of the action config emoji', async () => {
    const historyDb = new InMemoryHistoryDb();
    const persistWorldEvent = createRuntimePersistWorldEvent(historyDb, () => '🍳');

    try {
      await persistWorldEvent?.({
        event_id: 'evt-action-rejected',
        type: 'action_rejected',
        occurred_at: 1_750_000_100_000,
        agent_id: 'alice',
        agent_name: 'Alice',
        action_id: 'cook',
        action_name: 'Cook',
        rejection_reason: 'not_enough_money',
      });

      expect(
        historyDb.getWorldEventSummary('evt-action-rejected'),
      ).toEqual([
        {
          summary_emoji: '⚠️',
          summary_title: 'アクション失敗',
          summary_text: 'Cook: not_enough_money',
        },
      ]);
    } finally {
      historyDb.close();
    }
  });

  it('rolls back the whole event when a later D1 statement fails', async () => {
    const historyDb = new InMemoryHistoryDb(1);
    const observability = createObservabilitySpy();
    const persistWorldEvent = createRuntimePersistWorldEvent(historyDb, undefined, observability.observer);
    const currentMirror: Record<string, BridgeConversationState> = {
      'conv-1': {
        conversation_id: 'conv-1',
        status: 'active',
        participant_agent_ids: ['alice', 'bob'],
        initiator_agent_id: 'alice',
        current_speaker_agent_id: 'alice',
        updated_at: 1_750_000_050_000,
      },
    };
    const worldEvent = {
      event_id: 'evt-atomic',
      type: 'conversation_turn_started' as const,
      occurred_at: 1_750_000_110_000,
      conversation_id: 'conv-1',
      current_speaker_agent_id: 'bob',
    };

    try {
      await expect(
        persistWorldEvent?.(worldEvent, stageConversationMirrorUpdate(currentMirror, worldEvent)),
      ).rejects.toThrow('Injected batch failure');

      expect(historyDb.count('world_events')).toBe(0);
      expect(historyDb.count('world_event_agents')).toBe(0);
      expect(historyDb.count('world_event_conversations')).toBe(0);
      expect(observability.metrics).toContainEqual({
        name: 'relay.d1.ingest_failure_total',
        kind: 'counter',
        value: 1,
        tags: {
          event_type: 'conversation_turn_started',
        },
      });
      expect(observability.logs).toContainEqual({
        level: 'error',
        message: 'relay failed to persist world event batch',
        context: {
          event_type: 'conversation_turn_started',
          event_id: 'evt-atomic',
          error: 'Injected batch failure',
        },
      });
    } finally {
      historyDb.close();
    }
  });
});
