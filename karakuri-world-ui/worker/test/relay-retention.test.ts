import { describe, expect, it, vi } from 'vitest';

import relayWorker from '../src/index.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../src/relay/bridge.js';
import { runHistoryRetention } from '../src/relay/retention.js';

class RetentionStatement implements D1PreparedStatementLike {
  constructor(
    private readonly db: RetentionDb,
    readonly query: string,
    readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new RetentionStatement(this.db, this.query, values);
  }

  async all() {
    return {
      results: this.db.read(this.query, this.values),
    };
  }

  async run() {
    this.db.write(this.query, this.values);
    return {};
  }
}

class RetentionDb implements D1DatabaseLike {
  readonly worldEvents = [
    { event_id: 'old-event', occurred_at: 1_700_000_000_000 },
    { event_id: 'new-event', occurred_at: 2_209_000_000_000 },
  ];
  readonly serverEventInstances = [
    {
      server_event_id: 'old-server',
      first_occurred_at: 1_700_000_000_000,
      last_occurred_at: 2_209_000_000_000,
    },
    {
      server_event_id: 'new-server',
      first_occurred_at: 2_209_000_000_000,
      last_occurred_at: 2_209_000_000_000,
    },
  ];

  constructor(private readonly failWrites = false) {}

  prepare(query: string) {
    return new RetentionStatement(this, query.trim());
  }

  read(query: string, values: unknown[]) {
    const cutoff = Number(values[0]);

    if (query.includes('COUNT(*)') && query.includes('FROM world_events')) {
      return [{ count: this.worldEvents.filter((row) => row.occurred_at < cutoff).length }];
    }

    if (query.includes('COUNT(*)') && query.includes('FROM server_event_instances')) {
      return [{ count: this.serverEventInstances.filter((row) => row.first_occurred_at < cutoff).length }];
    }

    return [];
  }

  write(query: string, values: unknown[]) {
    if (this.failWrites) {
      throw new Error('Injected retention failure');
    }

    const cutoff = Number(values[0]);

    if (query.includes('DELETE FROM world_events')) {
      const retained = this.worldEvents.filter((row) => row.occurred_at >= cutoff);
      this.worldEvents.splice(0, this.worldEvents.length, ...retained);
      return;
    }

    if (query.includes('DELETE FROM server_event_instances')) {
      const retained = this.serverEventInstances.filter((row) => row.first_occurred_at >= cutoff);
      this.serverEventInstances.splice(0, this.serverEventInstances.length, ...retained);
    }
  }
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

describe('relay retention observability', () => {
  it('emits success metrics and deleted row counts for retention runs', async () => {
    const db = new RetentionDb();
    const observability = createObservabilitySpy();

    const result = await runHistoryRetention(db, 30, () => 2_210_000_000_000, observability.observer);

    expect(result).toEqual({
      deleted_rows: 2,
      deleted_world_events: 1,
      deleted_server_event_instances: 1,
      cutoff_ms: 2_207_408_000_000,
    });
    expect(observability.metrics).toContainEqual({
      name: 'relay.d1.retention_run_total',
      kind: 'counter',
      value: 1,
      tags: { result: 'success' },
    });
    expect(observability.metrics).toContainEqual({
      name: 'relay.d1.retention_deleted_rows',
      kind: 'gauge',
      value: 2,
    });
    expect(db.worldEvents).toEqual([{ event_id: 'new-event', occurred_at: 2_209_000_000_000 }]);
    expect(db.serverEventInstances).toEqual([
      {
        server_event_id: 'new-server',
        first_occurred_at: 2_209_000_000_000,
        last_occurred_at: 2_209_000_000_000,
      },
    ]);
  });

  it('emits failure metrics when retention writes fail', async () => {
    const observability = createObservabilitySpy();

    await expect(
      runHistoryRetention(new RetentionDb(true), 30, () => 2_210_000_000_000, observability.observer),
    ).rejects.toThrow('Injected retention failure');

    expect(observability.metrics).toContainEqual({
      name: 'relay.d1.retention_run_total',
      kind: 'counter',
      value: 1,
      tags: { result: 'failure' },
    });
    expect(observability.logs).toContainEqual({
      level: 'error',
      message: 'relay history retention failed',
      context: {
        cutoff_ms: 2_207_408_000_000,
        error: 'Injected retention failure',
      },
    });
  });

  it('treats missing HISTORY_DB as a retention failure', async () => {
    const observability = createObservabilitySpy();

    await expect(runHistoryRetention(undefined, 30, () => 2_210_000_000_000, observability.observer)).rejects.toThrow(
      'HISTORY_DB is required for relay history retention',
    );

    expect(observability.metrics).toContainEqual({
      name: 'relay.d1.retention_run_total',
      kind: 'counter',
      value: 1,
      tags: { result: 'failure' },
    });
    expect(observability.logs).toContainEqual({
      level: 'error',
      message: 'relay history retention failed',
      context: {
        cutoff_ms: 2_207_408_000_000,
        error: 'HISTORY_DB is required for relay history retention',
      },
    });
  });

  it('wires retention into the worker scheduled handler', async () => {
    const db = new RetentionDb();

    await relayWorker.scheduled?.(
      {},
      {
        UI_BRIDGE: {
          idFromName: () => ({}) as never,
          get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) as never,
        },
        HISTORY_DB: db,
      } as never,
    );

    expect(db.worldEvents).toEqual([{ event_id: 'new-event', occurred_at: 2_209_000_000_000 }]);
    expect(db.serverEventInstances).toEqual([
      {
        server_event_id: 'new-server',
        first_occurred_at: 2_209_000_000_000,
        last_occurred_at: 2_209_000_000_000,
      },
    ]);
  });

  it('emits retention failure observability before throwing on invalid retention config', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        relayWorker.scheduled?.(
          {},
          {
            UI_BRIDGE: {
              idFromName: () => ({}) as never,
              get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) as never,
            },
            HISTORY_DB: new RetentionDb(),
            HISTORY_RETENTION_DAYS: '0',
          } as never,
        ),
      ).rejects.toThrow('HISTORY_RETENTION_DAYS must be a positive integer');

      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"name":"relay.d1.retention_run_total","kind":"counter","value":1,"tags":{"result":"failure"}'),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"message":"relay history retention failed"'),
      );
    } finally {
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
