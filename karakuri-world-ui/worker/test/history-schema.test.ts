import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const schemaPath = fileURLToPath(new URL('../../schema/history.sql', import.meta.url));
const migrationPath = fileURLToPath(new URL('../../migrations/0001_plan05_history_schema.sql', import.meta.url));

const schemaSources = [
  { label: 'checked-in schema', path: schemaPath },
  { label: 'first migration', path: migrationPath },
];

function openHistoryDb(sqlPath: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(sqlPath, 'utf8'));
  return db;
}

function listIndexNames(db: DatabaseSync, tableName: string): string[] {
  return db
    .prepare(`PRAGMA index_list(${JSON.stringify(tableName)})`)
    .all()
    .map((row) => String(row.name));
}

function seedHistoryRows(db: DatabaseSync): void {
  const insertWorldEvent = db.prepare(`
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
  const insertWorldEventAgent = db.prepare(`
    INSERT INTO world_event_agents (
      event_id,
      agent_id,
      occurred_at,
      event_type,
      role
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const insertWorldEventConversation = db.prepare(`
    INSERT INTO world_event_conversations (
      event_id,
      conversation_id,
      occurred_at,
      event_type
    ) VALUES (?, ?, ?, ?)
  `);
  const insertServerEventInstance = db.prepare(`
    INSERT INTO server_event_instances (
      server_event_id,
      description,
      first_occurred_at,
      last_occurred_at
    ) VALUES (?, ?, ?, ?)
  `);

  for (let index = 0; index < 8; index += 1) {
    const eventId = `event-${index}`;
    const occurredAt = 1_750_000_000_000 + index;
    const eventType =
      index % 2 === 0
        ? index % 4 === 0
          ? 'conversation_message'
          : 'conversation_join'
        : 'action_started';
    const conversationId = index % 2 === 0 ? 'conv-1' : null;

    insertWorldEvent.run(
      eventId,
      eventType,
      occurredAt,
      conversationId,
      null,
      '🧪',
      'test',
      'test payload',
      '{}',
    );
    insertWorldEventAgent.run(eventId, 'alice', occurredAt, eventType, 'subject');

    if (conversationId) {
      insertWorldEventConversation.run(eventId, conversationId, occurredAt, eventType);
    }
  }

  insertServerEventInstance.run('server-1', 'Harvest Festival', 1_750_000_000_000, 1_750_000_030_000);
  insertServerEventInstance.run('server-2', 'Evening Bell', 1_750_000_010_000, 1_750_000_010_000);
}

function explainDetails(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): string {
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => String(row.detail))
    .join('\n');
}

type TimelineRow = {
  event_id: string;
  occurred_at: number;
};

function selectTimelineRows(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): TimelineRow[] {
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => ({
      event_id: String(row.event_id),
      occurred_at: Number(row.occurred_at),
    }));
}

function normalizeTypes(types: readonly string[]): string[] {
  return [...new Set(types)];
}

function buildTypesFilterClause(column: string, types: readonly string[]): {
  sql: string;
  params: SQLInputValue[];
} {
  const normalizedTypes = normalizeTypes(types);

  if (normalizedTypes.length === 1) {
    return {
      sql: ` AND ${column} = ?`,
      params: [normalizedTypes[0]],
    };
  }

  return {
    sql: ` AND ${column} IN (${normalizedTypes.map(() => '?').join(', ')})`,
    params: normalizedTypes,
  };
}

function expectPlanToUseIndexWithoutTempSort(plan: string, expectedIndexName: string): void {
  expect(plan).toContain(expectedIndexName);
  expect(plan).not.toMatch(/TEMP B-TREE/);
}

function compareTimelineRowsDescending(left: TimelineRow, right: TimelineRow): number {
  if (left.occurred_at !== right.occurred_at) {
    return right.occurred_at - left.occurred_at;
  }

  if (left.event_id === right.event_id) {
    return 0;
  }

  return left.event_id < right.event_id ? 1 : -1;
}

function mergeMultiTypeTimelineRows(branches: readonly TimelineRow[][], limit: number): TimelineRow[] {
  return branches
    .flat()
    .sort(compareTimelineRowsDescending)
    .slice(0, limit);
}

describe('history D1 schema', () => {
  it.each(schemaSources)('creates the required tables and indexes from the $label', ({ path }) => {
    const db = openHistoryDb(path);

    try {
      const tableNames = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
            'world_events',
            'server_event_instances',
            'world_event_agents',
            'world_event_conversations'
          ) ORDER BY name`,
        )
        .all()
        .map((row) => String(row.name));

      expect(tableNames).toEqual([
        'server_event_instances',
        'world_event_agents',
        'world_event_conversations',
        'world_events',
      ]);
      expect(listIndexNames(db, 'world_events')).toEqual(
        expect.arrayContaining(['world_events_occurred_idx']),
      );
      expect(listIndexNames(db, 'world_event_agents')).toEqual(
        expect.arrayContaining([
          'world_event_agents_agent_timeline_idx',
          'world_event_agents_agent_type_timeline_idx',
        ]),
      );
      expect(listIndexNames(db, 'world_event_conversations')).toEqual(
        expect.arrayContaining([
          'world_event_conversations_timeline_idx',
          'world_event_conversations_type_timeline_idx',
        ]),
      );
      expect(listIndexNames(db, 'server_event_instances')).toEqual(
        expect.arrayContaining(['server_event_instances_recent_idx']),
      );
    } finally {
      db.close();
    }
  });

  it.each(schemaSources)(
    'uses the intended timeline indexes in EXPLAIN QUERY PLAN for the $label',
    ({ path }) => {
      const db = openHistoryDb(path);

      try {
        seedHistoryRows(db);

        const agentTimelinePlan = explainDetails(
          db,
          `
            EXPLAIN QUERY PLAN
            SELECT we.*
            FROM world_event_agents wea
            JOIN world_events we ON we.event_id = wea.event_id
            WHERE wea.agent_id = ?
              AND (
                ? IS NULL
                OR wea.occurred_at < ?
                OR (wea.occurred_at = ? AND wea.event_id < ?)
              )
            ORDER BY wea.occurred_at DESC, wea.event_id DESC
            LIMIT ?
          `,
          'alice',
          1_750_000_000_004,
          1_750_000_000_004,
          1_750_000_000_004,
          'event-4',
          21,
        );
        const agentSingleTypeFilter = buildTypesFilterClause('wea.event_type', ['conversation_message']);
        const agentSingleTypeTimelinePlan = explainDetails(
          db,
          `
            EXPLAIN QUERY PLAN
            SELECT we.*
            FROM world_event_agents wea
            JOIN world_events we ON we.event_id = wea.event_id
            WHERE wea.agent_id = ?
              ${agentSingleTypeFilter.sql}
              AND (
                ? IS NULL
                OR wea.occurred_at < ?
                OR (wea.occurred_at = ? AND wea.event_id < ?)
              )
            ORDER BY wea.occurred_at DESC, wea.event_id DESC
            LIMIT ?
          `,
          'alice',
          ...agentSingleTypeFilter.params,
          1_750_000_000_004,
          1_750_000_000_004,
          1_750_000_000_004,
          'event-4',
          21,
        );
        const agentMultiTypeFilter = buildTypesFilterClause('wea.event_type', [
          'conversation_message',
          'action_started',
          'conversation_message',
        ]);
        expect(agentMultiTypeFilter.params).toEqual(['conversation_message', 'action_started']);
        const agentMultiTypeTimelinePlans = agentMultiTypeFilter.params.map((eventType) =>
          explainDetails(
            db,
            `
              EXPLAIN QUERY PLAN
              SELECT we.*
              FROM world_event_agents wea
              JOIN world_events we ON we.event_id = wea.event_id
              WHERE wea.agent_id = ?
                AND wea.event_type = ?
                AND (
                  ? IS NULL
                  OR wea.occurred_at < ?
                  OR (wea.occurred_at = ? AND wea.event_id < ?)
                )
              ORDER BY wea.occurred_at DESC, wea.event_id DESC
              LIMIT ?
            `,
            'alice',
            eventType,
            1_750_000_000_004,
            1_750_000_000_004,
            1_750_000_000_004,
            'event-4',
            21,
          ),
        );
        const agentMultiTypeTimelineIds = mergeMultiTypeTimelineRows(
          agentMultiTypeFilter.params.map((eventType) =>
            selectTimelineRows(
              db,
              `
                SELECT we.event_id, wea.occurred_at
                FROM world_event_agents wea
                JOIN world_events we ON we.event_id = wea.event_id
                WHERE wea.agent_id = ?
                  AND wea.event_type = ?
                  AND (
                    ? IS NULL
                    OR wea.occurred_at < ?
                    OR (wea.occurred_at = ? AND wea.event_id < ?)
                  )
                ORDER BY wea.occurred_at DESC, wea.event_id DESC
                LIMIT ?
              `,
              'alice',
              eventType,
              1_750_000_000_004,
              1_750_000_000_004,
              1_750_000_000_004,
              'event-4',
              21,
            ),
          ),
          21,
        ).map((row) => row.event_id);
        const agentMultiTypeFallbackTimelineIds = selectTimelineRows(
          db,
          `
            SELECT we.event_id, wea.occurred_at
            FROM world_event_agents wea
            JOIN world_events we ON we.event_id = wea.event_id
            WHERE wea.agent_id = ?
              ${agentMultiTypeFilter.sql}
              AND (
                ? IS NULL
                OR wea.occurred_at < ?
                OR (wea.occurred_at = ? AND wea.event_id < ?)
              )
            ORDER BY wea.occurred_at DESC, wea.event_id DESC
            LIMIT ?
          `,
          'alice',
          ...agentMultiTypeFilter.params,
          1_750_000_000_004,
          1_750_000_000_004,
          1_750_000_000_004,
          'event-4',
          21,
        ).map((row) => row.event_id);
        const conversationTimelinePlan = explainDetails(
          db,
          `
            EXPLAIN QUERY PLAN
            SELECT we.*
            FROM world_event_conversations wec
            JOIN world_events we ON we.event_id = wec.event_id
            WHERE wec.conversation_id = ?
              AND (
                ? IS NULL
                OR wec.occurred_at < ?
                OR (wec.occurred_at = ? AND wec.event_id < ?)
              )
            ORDER BY wec.occurred_at DESC, wec.event_id DESC
            LIMIT ?
          `,
          'conv-1',
          1_750_000_000_004,
          1_750_000_000_004,
          1_750_000_000_004,
          'event-4',
          21,
        );
        const conversationSingleTypeFilter = buildTypesFilterClause('wec.event_type', ['conversation_message']);
        const conversationSingleTypeTimelinePlan = explainDetails(
          db,
          `
            EXPLAIN QUERY PLAN
            SELECT we.*
            FROM world_event_conversations wec
            JOIN world_events we ON we.event_id = wec.event_id
            WHERE wec.conversation_id = ?
              ${conversationSingleTypeFilter.sql}
              AND (
                ? IS NULL
                OR wec.occurred_at < ?
                OR (wec.occurred_at = ? AND wec.event_id < ?)
              )
            ORDER BY wec.occurred_at DESC, wec.event_id DESC
            LIMIT ?
          `,
          'conv-1',
          ...conversationSingleTypeFilter.params,
          1_750_000_000_004,
          1_750_000_000_004,
          1_750_000_000_004,
          'event-4',
          21,
        );
        const conversationMultiTypeFilter = buildTypesFilterClause('wec.event_type', [
          'conversation_message',
          'conversation_join',
          'conversation_message',
        ]);
        expect(conversationMultiTypeFilter.params).toEqual([
          'conversation_message',
          'conversation_join',
        ]);
        const conversationMultiTypeTimelinePlans = conversationMultiTypeFilter.params.map((eventType) =>
          explainDetails(
            db,
            `
              EXPLAIN QUERY PLAN
              SELECT we.*
              FROM world_event_conversations wec
              JOIN world_events we ON we.event_id = wec.event_id
              WHERE wec.conversation_id = ?
                AND wec.event_type = ?
                AND (
                  ? IS NULL
                  OR wec.occurred_at < ?
                  OR (wec.occurred_at = ? AND wec.event_id < ?)
                )
              ORDER BY wec.occurred_at DESC, wec.event_id DESC
              LIMIT ?
            `,
            'conv-1',
            eventType,
            1_750_000_000_004,
            1_750_000_000_004,
            1_750_000_000_004,
            'event-4',
            21,
          ),
        );
        const conversationMultiTypeTimelineIds = mergeMultiTypeTimelineRows(
          conversationMultiTypeFilter.params.map((eventType) =>
            selectTimelineRows(
              db,
              `
                SELECT we.event_id, wec.occurred_at
                FROM world_event_conversations wec
                JOIN world_events we ON we.event_id = wec.event_id
                WHERE wec.conversation_id = ?
                  AND wec.event_type = ?
                  AND (
                    ? IS NULL
                    OR wec.occurred_at < ?
                    OR (wec.occurred_at = ? AND wec.event_id < ?)
                  )
                ORDER BY wec.occurred_at DESC, wec.event_id DESC
                LIMIT ?
              `,
              'conv-1',
              eventType,
              1_750_000_000_004,
              1_750_000_000_004,
              1_750_000_000_004,
              'event-4',
              21,
            ),
          ),
          21,
        ).map((row) => row.event_id);
        const conversationMultiTypeFallbackTimelineIds = selectTimelineRows(
          db,
          `
            SELECT we.event_id, wec.occurred_at
            FROM world_event_conversations wec
            JOIN world_events we ON we.event_id = wec.event_id
            WHERE wec.conversation_id = ?
              ${conversationMultiTypeFilter.sql}
              AND (
                ? IS NULL
                OR wec.occurred_at < ?
                OR (wec.occurred_at = ? AND wec.event_id < ?)
              )
            ORDER BY wec.occurred_at DESC, wec.event_id DESC
            LIMIT ?
          `,
          'conv-1',
          ...conversationMultiTypeFilter.params,
          1_750_000_000_004,
          1_750_000_000_004,
          1_750_000_000_004,
          'event-4',
          21,
        ).map((row) => row.event_id);
        const recentServerEventsPlan = explainDetails(
          db,
          `
            EXPLAIN QUERY PLAN
            SELECT
              server_event_id,
              description,
              first_occurred_at AS occurred_at
            FROM server_event_instances
            ORDER BY first_occurred_at DESC, server_event_id DESC
            LIMIT 3
          `,
        );

        expectPlanToUseIndexWithoutTempSort(
          agentTimelinePlan,
          'world_event_agents_agent_timeline_idx',
        );
        expectPlanToUseIndexWithoutTempSort(
          agentSingleTypeTimelinePlan,
          'world_event_agents_agent_type_timeline_idx',
        );
        agentMultiTypeTimelinePlans.forEach((plan) => {
          expectPlanToUseIndexWithoutTempSort(plan, 'world_event_agents_agent_type_timeline_idx');
        });
        expect(agentMultiTypeTimelineIds).toEqual(agentMultiTypeFallbackTimelineIds);
        expectPlanToUseIndexWithoutTempSort(
          conversationTimelinePlan,
          'world_event_conversations_timeline_idx',
        );
        expectPlanToUseIndexWithoutTempSort(
          conversationSingleTypeTimelinePlan,
          'world_event_conversations_type_timeline_idx',
        );
        conversationMultiTypeTimelinePlans.forEach((plan) => {
          expectPlanToUseIndexWithoutTempSort(plan, 'world_event_conversations_type_timeline_idx');
        });
        expect(conversationMultiTypeTimelineIds).toEqual(conversationMultiTypeFallbackTimelineIds);
        expectPlanToUseIndexWithoutTempSort(
          recentServerEventsPlan,
          'server_event_instances_recent_idx',
        );
      } finally {
        db.close();
      }
    },
  );
});
