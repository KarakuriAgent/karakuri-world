import type { D1DatabaseLike, D1PreparedStatementLike } from './bridge.js';
import type { RelayObservability } from './observability.js';

const COUNT_WORLD_EVENTS_TO_DELETE_QUERY = `
SELECT COUNT(*) AS count
FROM world_events
WHERE occurred_at < ?
`;

const DELETE_WORLD_EVENTS_QUERY = `
DELETE FROM world_events
WHERE occurred_at < ?
`;

const COUNT_SERVER_EVENT_INSTANCES_TO_DELETE_QUERY = `
SELECT COUNT(*) AS count
FROM server_event_instances
WHERE first_occurred_at < ?
`;

const DELETE_SERVER_EVENT_INSTANCES_QUERY = `
DELETE FROM server_event_instances
WHERE first_occurred_at < ?
`;

function bindStatement(db: D1DatabaseLike, query: string, ...values: unknown[]): D1PreparedStatementLike {
  const statement = db.prepare(query.trim());
  return typeof statement.bind === 'function' ? statement.bind(...values) : statement;
}

async function readCount(db: D1DatabaseLike, query: string, cutoffMs: number): Promise<number> {
  const result = await bindStatement(db, query, cutoffMs).all();
  const row = result.results?.[0] as { count?: number | string } | undefined;
  return Number(row?.count ?? 0);
}

async function executeWrite(db: D1DatabaseLike, statement: D1PreparedStatementLike): Promise<void> {
  if (typeof statement.run === 'function') {
    await statement.run();
    return;
  }

  if (typeof db.batch === 'function') {
    await db.batch([statement]);
    return;
  }

  throw new Error('D1 write execution is not available');
}

export interface HistoryRetentionResult {
  deleted_rows: number;
  deleted_world_events: number;
  deleted_server_event_instances: number;
  cutoff_ms: number;
}

export async function runHistoryRetention(
  db: D1DatabaseLike | undefined,
  historyRetentionDays: number,
  now: () => number,
  observability: RelayObservability,
): Promise<HistoryRetentionResult> {
  const cutoffMs = now() - historyRetentionDays * 24 * 60 * 60 * 1000;

  if (!db) {
    const error = new Error('HISTORY_DB is required for relay history retention');
    observability.counter('ui.d1.retention_run_total', { result: 'failure' });
    observability.log('error', 'relay history retention failed', {
      cutoff_ms: cutoffMs,
      error: error.message,
    });
    throw error;
  }

  try {
    const deletedWorldEvents = await readCount(db, COUNT_WORLD_EVENTS_TO_DELETE_QUERY, cutoffMs);
    const deletedServerEventInstances = await readCount(db, COUNT_SERVER_EVENT_INSTANCES_TO_DELETE_QUERY, cutoffMs);

    await executeWrite(db, bindStatement(db, DELETE_WORLD_EVENTS_QUERY, cutoffMs));
    await executeWrite(db, bindStatement(db, DELETE_SERVER_EVENT_INSTANCES_QUERY, cutoffMs));

    const deletedRows = deletedWorldEvents + deletedServerEventInstances;
    observability.counter('ui.d1.retention_run_total', { result: 'success' });
    observability.gauge('ui.d1.retention_deleted_rows', deletedRows);
    observability.log('info', 'relay history retention completed', {
      cutoff_ms: cutoffMs,
      deleted_rows: deletedRows,
      deleted_world_events: deletedWorldEvents,
      deleted_server_event_instances: deletedServerEventInstances,
    });
    return {
      deleted_rows: deletedRows,
      deleted_world_events: deletedWorldEvents,
      deleted_server_event_instances: deletedServerEventInstances,
      cutoff_ms: cutoffMs,
    };
  } catch (error) {
    observability.counter('ui.d1.retention_run_total', { result: 'failure' });
    observability.log('error', 'relay history retention failed', {
      cutoff_ms: cutoffMs,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
