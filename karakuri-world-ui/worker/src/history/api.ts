import { z } from 'zod';

import {
  PERSISTED_SPECTATOR_EVENT_TYPES,
  isPersistedSpectatorEventType,
  type PersistedSpectatorEvent,
  type PersistedSpectatorEventType,
} from '../contracts/persisted-spectator-event.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../relay/bridge.js';
import type { HistoryCorsConfig } from '../relay/env.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const DEFAULT_HISTORY_LIMIT = 20;
export const MAX_HISTORY_LIMIT = 100;

export interface HistoryCursor {
  occurred_at: number;
  event_id: string;
}

export interface HistoryEntry {
  event_id: string;
  type: PersistedSpectatorEventType;
  occurred_at: number;
  agent_ids: string[];
  conversation_id?: string;
  summary: {
    emoji: string;
    title: string;
    text: string;
  };
  detail: Record<string, unknown>;
}

export interface PersistedHistoryEntry extends Omit<HistoryEntry, 'detail'> {
  detail: PersistedSpectatorEvent;
}

export interface HistoryResponse {
  items: HistoryEntry[];
  next_cursor?: string;
}

export interface PersistedHistoryResponse extends Omit<HistoryResponse, 'items'> {
  items: PersistedHistoryEntry[];
}

interface HistoryQueryBase {
  types?: PersistedSpectatorEventType[];
  cursor?: HistoryCursor;
  limit: number;
}

export type NormalizedHistoryQuery =
  | (HistoryQueryBase & { scope: 'agent'; agent_id: string })
  | (HistoryQueryBase & { scope: 'conversation'; conversation_id: string });

type HistoryErrorCode = 'invalid_request' | 'invalid_cursor';

class HistoryRequestError extends Error {
  constructor(
    readonly code: HistoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HistoryRequestError';
  }
}

const historyRowSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: z.coerce.number().int().nonnegative(),
  conversation_id: z.string().min(1).nullable().optional(),
  summary_emoji: z.string(),
  summary_title: z.string(),
  summary_text: z.string(),
  payload_json: z.string(),
});

const agentIdRowSchema = z.object({
  event_id: z.string().min(1),
  agent_id: z.string().min(1),
});

function appendHeader(headers: Headers, name: string, value: string): void {
  const current = headers.get(name);
  headers.set(name, current ? `${current}, ${value}` : value);
}

function buildCorsHeaders(request: Request, cors: HistoryCorsConfig): Headers {
  const headers = new Headers();
  const requestOrigin = request.headers.get('origin');

  if (!requestOrigin) {
    return headers;
  }

  appendHeader(headers, 'vary', 'Origin');

  if (!cors.allowedOrigins.includes(requestOrigin)) {
    return headers;
  }

  headers.set('access-control-allow-origin', requestOrigin);

  if (cors.authMode === 'access') {
    headers.set('access-control-allow-credentials', 'true');
  }

  return headers;
}

function jsonResponse(payload: unknown, status = 200, headers = new Headers()): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('content-type', 'application/json; charset=utf-8');

  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders,
  });
}

function messageFromUnknownError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function bindStatement(db: D1DatabaseLike, query: string, values: readonly unknown[] = []): D1PreparedStatementLike {
  const statement = db.prepare(query.trim());

  if (values.length === 0) {
    return statement;
  }

  if (typeof statement.bind !== 'function') {
    throw new Error('D1 prepared statement does not support bind()');
  }

  return statement.bind(...values);
}

async function queryAll(db: D1DatabaseLike, query: string, values: readonly unknown[] = []): Promise<unknown[]> {
  const result = await bindStatement(db, query, values).all();
  return result.results ?? [];
}

function encodeBase64UrlUtf8(value: string): string {
  const binary = Array.from(textEncoder.encode(value), (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function decodeBase64UrlUtf8(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return textDecoder.decode(bytes);
}

export function encodeHistoryCursor(cursor: HistoryCursor): string {
  return encodeBase64UrlUtf8(`${cursor.occurred_at}:${cursor.event_id}`);
}

export function decodeHistoryCursor(cursor: string): HistoryCursor {
  let decoded: string;

  try {
    decoded = decodeBase64UrlUtf8(cursor);
  } catch {
    throw new HistoryRequestError('invalid_cursor', 'cursor must be base64url(`${occurred_at}:${event_id}`)');
  }

  const separatorIndex = decoded.indexOf(':');

  if (separatorIndex <= 0 || separatorIndex === decoded.length - 1) {
    throw new HistoryRequestError('invalid_cursor', 'cursor must be base64url(`${occurred_at}:${event_id}`)');
  }

  const occurredAt = Number(decoded.slice(0, separatorIndex));
  const eventId = decoded.slice(separatorIndex + 1);

  if (!Number.isInteger(occurredAt) || occurredAt < 0 || eventId.length === 0) {
    throw new HistoryRequestError('invalid_cursor', 'cursor must be base64url(`${occurred_at}:${event_id}`)');
  }

  return {
    occurred_at: occurredAt,
    event_id: eventId,
  };
}

function normalizeHistoryTypes(searchParams: URLSearchParams): PersistedSpectatorEventType[] | undefined {
  const requestedTypes = searchParams
    .getAll('types')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (requestedTypes.length === 0) {
    return undefined;
  }

  const normalizedTypes = [...new Set(requestedTypes)];
  const invalidTypes = normalizedTypes.filter((value) => !isPersistedSpectatorEventType(value));

  if (invalidTypes.length > 0) {
    throw new HistoryRequestError('invalid_request', `unsupported types: ${invalidTypes.join(', ')}`);
  }

  return normalizedTypes as PersistedSpectatorEventType[];
}

export function normalizeHistoryQuery(request: Request): NormalizedHistoryQuery {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agent_id')?.trim();
  const conversationId = searchParams.get('conversation_id')?.trim();
  const types = normalizeHistoryTypes(searchParams);

  if ((agentId ? 1 : 0) + (conversationId ? 1 : 0) !== 1) {
    throw new HistoryRequestError(
      'invalid_request',
      'exactly one of agent_id or conversation_id is required',
    );
  }

  const rawLimit = searchParams.get('limit');
  const limit = rawLimit === null ? DEFAULT_HISTORY_LIMIT : Number(rawLimit);

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
    throw new HistoryRequestError('invalid_request', `limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}`);
  }

  const hasCursorParam = searchParams.has('cursor');
  const cursorParam = searchParams.get('cursor');
  const queryBase: HistoryQueryBase = {
    limit,
    ...(hasCursorParam ? { cursor: decodeHistoryCursor(cursorParam ?? '') } : {}),
    ...(types ? { types } : {}),
  };

  if (agentId) {
    return {
      scope: 'agent',
      agent_id: agentId,
      ...queryBase,
    };
  }

  return {
    scope: 'conversation',
    conversation_id: conversationId as string,
    ...queryBase,
  };
}

function parsePersistedHistoryDetail(payloadJson: string, eventType: PersistedSpectatorEventType): PersistedSpectatorEvent {
  const parsed = JSON.parse(payloadJson) as unknown;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`payload_json for ${eventType} must decode to an object`);
  }

  if (!('type' in parsed) || parsed.type !== eventType) {
    throw new Error(`payload_json type mismatch for ${eventType}`);
  }

  return parsed as PersistedSpectatorEvent;
}

async function readEventAgentIds(db: D1DatabaseLike, eventIds: readonly string[]): Promise<Map<string, string[]>> {
  if (eventIds.length === 0) {
    return new Map();
  }

  const rows = await queryAll(
    db,
    `
      SELECT event_id, agent_id
      FROM world_event_agents
      WHERE event_id IN (${eventIds.map(() => '?').join(', ')})
      ORDER BY event_id ASC, agent_id ASC
    `,
    eventIds,
  );

  const agentIdsByEventId = new Map<string, string[]>();

  for (const row of rows) {
    const parsedRow = agentIdRowSchema.parse(row);
    const agentIds = agentIdsByEventId.get(parsedRow.event_id) ?? [];
    agentIds.push(parsedRow.agent_id);
    agentIdsByEventId.set(parsedRow.event_id, agentIds);
  }

  return agentIdsByEventId;
}

function buildHistoryQuerySql(query: NormalizedHistoryQuery): {
  sql: string;
  values: unknown[];
} {
  const scopeTable = query.scope === 'agent' ? 'world_event_agents' : 'world_event_conversations';
  const scopeAlias = query.scope === 'agent' ? 'wea' : 'wec';
  const scopeColumn = query.scope === 'agent' ? 'agent_id' : 'conversation_id';
  const scopeValue = query.scope === 'agent' ? query.agent_id : query.conversation_id;

  const values: unknown[] = [scopeValue];
  const whereClauses = [`${scopeAlias}.${scopeColumn} = ?`];

  if (query.types && query.types.length > 0) {
    whereClauses.push(`${scopeAlias}.event_type IN (${query.types.map(() => '?').join(', ')})`);
    values.push(...query.types);
  }

  if (query.cursor) {
    whereClauses.push(
      `(${scopeAlias}.occurred_at < ? OR (${scopeAlias}.occurred_at = ? AND ${scopeAlias}.event_id < ?))`,
    );
    values.push(query.cursor.occurred_at, query.cursor.occurred_at, query.cursor.event_id);
  }

  values.push(query.limit + 1);

  return {
    sql: `
      SELECT
        we.event_id,
        we.event_type,
        ${scopeAlias}.occurred_at AS occurred_at,
        we.conversation_id,
        we.summary_emoji,
        we.summary_title,
        we.summary_text,
        we.payload_json
      FROM ${scopeTable} ${scopeAlias}
      JOIN world_events we ON we.event_id = ${scopeAlias}.event_id
      WHERE ${whereClauses.join('\n        AND ')}
      ORDER BY ${scopeAlias}.occurred_at DESC, ${scopeAlias}.event_id DESC
      LIMIT ?
    `,
    values,
  };
}

export async function queryHistory(db: D1DatabaseLike, query: NormalizedHistoryQuery): Promise<PersistedHistoryResponse> {
  const { sql, values } = buildHistoryQuerySql(query);
  const rows = (await queryAll(db, sql, values)).map((row) => historyRowSchema.parse(row));
  const hasMore = rows.length > query.limit;
  const pageRows = rows.slice(0, query.limit);
  const agentIdsByEventId = await readEventAgentIds(
    db,
    pageRows.map((row) => row.event_id),
  );

  return {
    items: pageRows.map((row) => {
      if (!isPersistedSpectatorEventType(row.event_type)) {
        throw new Error(`unknown persisted event type: ${row.event_type}`);
      }

      return {
        event_id: row.event_id,
        type: row.event_type,
        occurred_at: row.occurred_at,
        agent_ids: agentIdsByEventId.get(row.event_id) ?? [],
        ...(row.conversation_id ? { conversation_id: row.conversation_id } : {}),
        summary: {
          emoji: row.summary_emoji,
          title: row.summary_title,
          text: row.summary_text,
        },
        detail: parsePersistedHistoryDetail(row.payload_json, row.event_type),
      };
    }),
    ...(hasMore
      ? {
          next_cursor: encodeHistoryCursor({
            occurred_at: pageRows.at(-1)?.occurred_at ?? rows[query.limit].occurred_at,
            event_id: pageRows.at(-1)?.event_id ?? rows[query.limit].event_id,
          }),
        }
      : {}),
  };
}

export async function handleHistoryRequest(
  request: Request,
  db?: D1DatabaseLike,
  cors: HistoryCorsConfig = { authMode: 'public', allowedOrigins: [] },
  configError?: unknown,
): Promise<Response> {
  const corsHeaders = buildCorsHeaders(request, cors);

  if (configError) {
    return jsonResponse(
      {
        error: {
          code: 'internal_error',
          message: messageFromUnknownError(configError, 'Failed to parse history CORS configuration.'),
        },
      },
      500,
      corsHeaders,
    );
  }

  if (request.method === 'OPTIONS') {
    const requestedMethod = request.headers.get('access-control-request-method');
    const requestedHeaders = request.headers.get('access-control-request-headers');

    appendHeader(corsHeaders, 'vary', 'Access-Control-Request-Headers');

    if (!corsHeaders.get('access-control-allow-origin')) {
      return new Response(null, { status: 403, headers: corsHeaders });
    }

    if (requestedMethod !== 'GET') {
      corsHeaders.set('allow', 'GET, OPTIONS');
      return new Response(null, { status: 405, headers: corsHeaders });
    }

    corsHeaders.set('access-control-allow-methods', 'GET, OPTIONS');
    corsHeaders.set('access-control-max-age', '86400');

    if (requestedHeaders) {
      corsHeaders.set('access-control-allow-headers', requestedHeaders);
    }

    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  if (request.method !== 'GET') {
    const headers = new Headers(corsHeaders);
    headers.set('allow', 'GET, OPTIONS');

    return new Response(null, {
      status: 405,
      headers,
    });
  }

  if (!db) {
    return jsonResponse(
      {
        error: {
          code: 'internal_error',
          message: 'HISTORY_DB is required for GET /api/history',
        },
      },
      500,
      corsHeaders,
    );
  }

  try {
    const query = normalizeHistoryQuery(request);
    const response = await queryHistory(db, query);
    return jsonResponse(response, 200, corsHeaders);
  } catch (error) {
    if (error instanceof HistoryRequestError) {
      return jsonResponse(
        {
          error: {
            code: error.code,
            message: error.message,
          },
        },
        400,
        corsHeaders,
      );
    }

    return jsonResponse(
      {
        error: {
          code: 'internal_error',
          message: 'An unexpected error occurred.',
        },
      },
      500,
      corsHeaders,
    );
  }
}
