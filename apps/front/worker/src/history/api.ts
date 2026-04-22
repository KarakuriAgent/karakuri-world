import { z } from 'zod';

import {
  isPersistedSpectatorEventType,
  type PersistedSpectatorEvent,
  type PersistedSpectatorEventType,
} from '../contracts/persisted-spectator-event.js';
import type { R2BucketLike } from '../relay/bridge.js';
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
  hydration?: 'never-recorded';
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

const persistedHistoryEntrySchema = z.object({
  event_id: z.string().min(1),
  type: z.string().min(1),
  occurred_at: z.number().int().nonnegative(),
  agent_ids: z.array(z.string().min(1)),
  conversation_id: z.string().min(1).optional(),
  summary: z.object({
    emoji: z.string(),
    title: z.string(),
    text: z.string(),
  }),
  detail: z.record(z.string(), z.unknown()),
});

const historyDocumentSchema = z.object({
  items: z.array(persistedHistoryEntrySchema).optional(),
  hydration: z.literal('never-recorded').optional(),
  recent_actions: z.array(persistedHistoryEntrySchema).optional(),
  recent_conversations: z.array(persistedHistoryEntrySchema).optional(),
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

function normalizePersistedHistoryEntry(rawEntry: z.infer<typeof persistedHistoryEntrySchema>): PersistedHistoryEntry {
  if (!isPersistedSpectatorEventType(rawEntry.type)) {
    throw new Error(`unknown persisted event type: ${rawEntry.type}`);
  }

  const detailType = rawEntry.detail.type;
  if (detailType !== rawEntry.type) {
    throw new Error(`detail.type mismatch for ${rawEntry.event_id}`);
  }

  return {
    ...rawEntry,
    type: rawEntry.type,
    detail: rawEntry.detail as PersistedSpectatorEvent,
  };
}

function toHistoryObjectKey(query: NormalizedHistoryQuery): string {
  return query.scope === 'agent'
    ? `history/agents/${encodeURIComponent(query.agent_id)}.json`
    : `history/conversations/${encodeURIComponent(query.conversation_id)}.json`;
}

function dedupeHistoryEntriesByEventId(items: PersistedHistoryEntry[]): PersistedHistoryEntry[] {
  const seenEventIds = new Set<string>();
  const dedupedItems: PersistedHistoryEntry[] = [];

  for (const item of items) {
    if (seenEventIds.has(item.event_id)) {
      continue;
    }

    seenEventIds.add(item.event_id);
    dedupedItems.push(item);
  }

  return dedupedItems;
}

async function readHistoryDocument(bucket: R2BucketLike, query: NormalizedHistoryQuery): Promise<HistoryResponse | PersistedHistoryResponse> {
  const object = await bucket.get(toHistoryObjectKey(query));

  if (!object) {
    return {
      items: [],
      hydration: 'never-recorded',
    };
  }

  const parsedDocument = historyDocumentSchema.parse(JSON.parse(await object.text()));
  const mergedItems = [
    ...(parsedDocument.items ?? []),
    ...(parsedDocument.recent_actions ?? []),
    ...(parsedDocument.recent_conversations ?? []),
  ].map(normalizePersistedHistoryEntry);
  const normalizedItems = query.scope === 'agent'
    ? dedupeHistoryEntriesByEventId(mergedItems)
    : mergedItems;

  const filteredItems = normalizedItems
    .filter((item) => (query.types ? query.types.includes(item.type) : true))
    .filter((item) =>
      query.scope === 'conversation' ? item.conversation_id === query.conversation_id : true,
    )
    .sort((left, right) => right.occurred_at - left.occurred_at || right.event_id.localeCompare(left.event_id))
    .filter((item) => {
      if (!query.cursor) {
        return true;
      }

      return item.occurred_at < query.cursor.occurred_at || (
        item.occurred_at === query.cursor.occurred_at && item.event_id < query.cursor.event_id
      );
    });

  const pageItems = filteredItems.slice(0, query.limit);
  const nextItem = filteredItems.at(query.limit);

  return {
    items: pageItems,
    ...(nextItem
      ? {
          next_cursor: encodeHistoryCursor({
            occurred_at: pageItems.at(-1)?.occurred_at ?? nextItem.occurred_at,
            event_id: pageItems.at(-1)?.event_id ?? nextItem.event_id,
          }),
        }
      : {}),
    ...(parsedDocument.hydration ? { hydration: parsedDocument.hydration } : {}),
  };
}

export async function queryHistory(bucket: R2BucketLike, query: NormalizedHistoryQuery): Promise<PersistedHistoryResponse> {
  const response = await readHistoryDocument(bucket, query);
  return {
    items: response.items.map((item) => item as PersistedHistoryEntry),
    ...(response.next_cursor ? { next_cursor: response.next_cursor } : {}),
    ...(response.hydration ? { hydration: response.hydration } : {}),
  };
}

export async function handleHistoryRequest(
  request: Request,
  bucket?: R2BucketLike,
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

  if (!bucket) {
    return jsonResponse(
      {
        error: {
          code: 'internal_error',
          message: 'SNAPSHOT_BUCKET is required for GET /api/history',
        },
      },
      500,
      corsHeaders,
    );
  }

  try {
    const query = normalizeHistoryQuery(request);
    const response = await queryHistory(bucket, query);
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
