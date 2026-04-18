import { z } from 'zod';

import { sanitize } from '../contracts/persisted-spectator-event.js';
import { encodeSpectatorSnapshot } from '../contracts/snapshot-serializer.js';
import { buildSpectatorSnapshot, type SpectatorRecentServerEvent, type SpectatorSnapshot } from '../contracts/spectator-snapshot.js';
import type { ConversationClosureReason, WorldEvent } from '../contracts/world-event.js';
import type { WorldSnapshot } from '../contracts/world-snapshot.js';
import { parseRelayEnv, type RelayConfig } from './env.js';
import { createConsoleRelayObservability, type RelayObservability } from './observability.js';

export const PRIMARY_BRIDGE_NAME = 'primary';

export interface BridgeConversationState {
  conversation_id: string;
  status: 'pending' | 'active' | 'closing';
  participant_agent_ids: string[];
  initiator_agent_id?: string;
  current_speaker_agent_id?: string;
  closing_reason?: ConversationClosureReason;
  updated_at: number;
}

export interface BridgeState {
  websocket?: RelayWebSocket;
  latest_snapshot?: SpectatorSnapshot;
  conversations: Record<string, BridgeConversationState>;
  recent_server_events: SpectatorRecentServerEvent[];
  active_server_event_ids: string[];
  last_event_at?: number;
  last_publish_at?: number;
  last_refresh_at?: number;
  reconnect_attempt: number;
  refresh_in_flight: boolean;
  refresh_queued: boolean;
  refresh_queued_reason?: SnapshotRefreshReason;
  refresh_alarm_at?: number;
  publish_alarm_at?: number;
  heartbeat_alarm_at?: number;
  websocket_reconnect_alarm_at?: number;
  publish_in_flight: boolean;
  publish_queued: boolean;
  publish_failure_streak: number;
  heartbeat_failure_streak: number;
  disconnect_started_at?: number;
}

export interface RelayWebSocket {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: RelayWebSocketCloseEvent) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  accept?(): void;
}

export interface RelayWebSocketCloseEvent {
  code?: number;
  reason?: string;
}

export interface RelayFetchResponse {
  status: number;
  webSocket?: RelayWebSocket | null;
  json?(): Promise<unknown>;
}

export type RelayFetch = (input: string | URL | Request, init?: RequestInit) => Promise<RelayFetchResponse>;

export interface BridgeDependencies {
  fetchImpl: RelayFetch;
  now: () => number;
  random: () => number;
  observability: RelayObservability;
  publishSnapshot?: (input: SnapshotPublishInput) => Promise<void>;
  /**
   * Optional history ingest boundary. When provided, persists world events to D1 to
   * support `/api/history`. This is the abstraction entry point for alternative ingest
   * sources such as relay `/ws` events, backfill pipelines, or import scripts — callers
   * supply a different implementation without changing the publish path.
   *
   * Absence of this dependency means no history is written but snapshot publishing is
   * entirely unaffected. Ingest failures (relay.d1.ingest_failure_total) are supplementary
   * signals only and are NOT a launch gate (see §9.1 of 13-ui-relay-backend.md).
   */
  persistWorldEvent?: (
    worldEvent: WorldEvent,
    stagedConversationUpdate?: StagedConversationMirrorUpdate,
  ) => Promise<void>;
}

type SnapshotRefreshReason = 'boot' | 'fixed-cadence' | 'world-event' | 'manual';
type ConversationWorldEvent = Extract<WorldEvent, { conversation_id: string }>;
type DisconnectReason = 'close' | 'error' | 'idle';
type HandshakeStatus = 'auth_rejected' | 'not_found' | 'server_error' | 'network' | 'timeout' | 'server_close';

export interface StagedConversationMirrorUpdate {
  conversation_id: string;
  next_conversations: Record<string, BridgeConversationState>;
  resolved_conversation?: BridgeConversationState;
  resolved_agent_ids: string[];
}

function mergeQueuedRefreshReason(
  currentReason: SnapshotRefreshReason | undefined,
  nextReason: SnapshotRefreshReason,
): SnapshotRefreshReason {
  if (currentReason === 'world-event' || nextReason === 'world-event') {
    return 'world-event';
  }

  if (currentReason === 'manual' || nextReason === 'manual') {
    return 'manual';
  }

  if (currentReason === 'fixed-cadence' || nextReason === 'fixed-cadence') {
    return 'fixed-cadence';
  }

  return 'boot';
}

export interface DurableObjectStorageLike {
  getAlarm?(): Promise<number | null> | number | null;
  setAlarm?(scheduledTime: number): Promise<void> | void;
  get?<T>(key: string): Promise<T | undefined> | T | undefined;
  put?<T>(key: string, value: T): Promise<void> | void;
  delete?(key: string): Promise<void> | void;
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface DurableObjectIdLike {}

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface D1QueryResult<TRow> {
  results?: TRow[];
}

export interface D1PreparedStatementLike {
  bind?(...values: unknown[]): D1PreparedStatementLike;
  run?(): Promise<unknown>;
  all(): Promise<D1QueryResult<unknown>>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch?(statements: D1PreparedStatementLike[]): Promise<unknown>;
}

export interface R2PutOptions {
  httpMetadata?: {
    contentType?: string;
    cacheControl?: string;
  };
  customMetadata?: Record<string, string>;
}

export interface R2BucketLike {
  put(key: string, value: string, options?: R2PutOptions): Promise<unknown>;
}

export interface RelayBindings extends Record<string, unknown> {
  KW_BASE_URL: string;
  KW_ADMIN_KEY: string;
  AUTH_MODE?: 'public' | 'access';
  HISTORY_CORS_ALLOWED_ORIGINS?: string;
  SNAPSHOT_BUCKET?: R2BucketLike;
  UI_BRIDGE?: DurableObjectNamespaceLike;
  HISTORY_DB?: D1DatabaseLike;
}

class WebSocketUpgradeError extends Error {
  constructor(
    message: string,
    readonly handshakeStatus: HandshakeStatus,
  ) {
    super(message);
    this.name = 'WebSocketUpgradeError';
  }
}

function classifyHandshakeStatus(status?: number): HandshakeStatus {
  if (status === 401 || status === 403) {
    return 'auth_rejected';
  }

  if (status === 404) {
    return 'not_found';
  }

  if (status === 408 || status === 504) {
    return 'timeout';
  }

  if (typeof status === 'number' && status >= 500) {
    return 'server_error';
  }

  return 'network';
}

function classifyTransportError(error: unknown): HandshakeStatus {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|abort/i.test(message) ? 'timeout' : 'network';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readCloseReason(event: RelayWebSocketCloseEvent | unknown): string | undefined {
  if (typeof event !== 'object' || event === null || !('reason' in event)) {
    return undefined;
  }

  return typeof event.reason === 'string' ? event.reason : undefined;
}

function classifySocketCloseReason(event: RelayWebSocketCloseEvent | unknown): DisconnectReason {
  const closeReason = readCloseReason(event);
  return closeReason && /idle|keepalive|ping timeout|heartbeat timeout/i.test(closeReason) ? 'idle' : 'close';
}

interface SocketSnapshotPayload {
  type: 'snapshot';
  data: WorldSnapshot;
}

interface SocketEventPayload {
  type: 'event';
  data: WorldEvent;
}

type SocketPayload = SocketSnapshotPayload | SocketEventPayload;
interface SnapshotPublishInput {
  key: string;
  body: string;
  options: R2PutOptions;
}

const PUBLISH_BACKOFF_MAX_MS = 60_000;
const WEBSOCKET_RECONNECT_BACKOFF_MAX_MS = 30_000;
const WEBSOCKET_RECONNECT_JITTER_RATIO = 0.2;
const SNAPSHOT_CONTENT_TYPE = 'application/json; charset=utf-8';
const PERSISTED_RECONNECT_STATE_KEY = 'relay:websocket-reconnect-state';
const PERSISTED_OUTAGE_RUNTIME_STATE_KEY = 'relay:outage-runtime-state';

const socketPayloadSchema = z.object({
  type: z.enum(['snapshot', 'event']),
  data: z.unknown(),
});

const worldCalendarSnapshotSchema = z.object({
  timezone: z.string(),
  local_date: z.string(),
  local_time: z.string(),
  season: z.enum(['spring', 'summer', 'autumn', 'winter']),
  season_label: z.enum(['春', '夏', '秋', '冬']),
  day_in_season: z.number().int().positive(),
  display_label: z.string(),
});

const mapRenderThemeSchema = z.object({
  cell_size: z.number(),
  label_font_size: z.number(),
  node_id_font_size: z.number(),
  background_fill: z.string(),
  grid_stroke: z.string(),
  default_node_fill: z.string(),
  normal_node_fill: z.string(),
  wall_node_fill: z.string(),
  door_node_fill: z.string(),
  npc_node_fill: z.string(),
  building_palette: z.array(z.string()),
  wall_text_color: z.string(),
  default_text_color: z.string(),
});

const worldSnapshotSchema = z.object({
  world: z.object({
    name: z.string(),
    description: z.string(),
  }),
  timezone: z.string().optional(),
  calendar: worldCalendarSnapshotSchema,
  map: z.object({
    rows: z.number().int().positive(),
    cols: z.number().int().positive(),
    nodes: z.record(
      z.object({
        type: z.enum(['normal', 'wall', 'door', 'building_interior', 'npc']),
        label: z.string().optional(),
        building_id: z.string().optional(),
        npc_id: z.string().optional(),
      }),
    ),
    buildings: z.array(
      z.object({
        building_id: z.string(),
        name: z.string(),
        description: z.string(),
        wall_nodes: z.array(z.string()),
        interior_nodes: z.array(z.string()),
        door_nodes: z.array(z.string()),
        actions: z.array(
          z.object({
            action_id: z.string(),
            name: z.string(),
            emoji: z.string().optional(),
          }),
        ),
      }),
    ),
    npcs: z.array(
      z.object({
        npc_id: z.string(),
        name: z.string(),
        description: z.string(),
        node_id: z.string(),
        actions: z.array(
          z.object({
            action_id: z.string(),
            name: z.string(),
            emoji: z.string().optional(),
          }),
        ),
      }),
    ),
  }),
  map_render_theme: mapRenderThemeSchema,
  weather: z
    .object({
      condition: z.string(),
      temperature_celsius: z.number(),
    })
    .optional(),
  agents: z.array(
    z.object({
      agent_id: z.string(),
      agent_name: z.string(),
      node_id: z.string(),
      state: z.enum(['idle', 'moving', 'in_action', 'in_conversation']),
      discord_channel_id: z.string(),
      money: z.number(),
      items: z.array(z.unknown()),
      status_emoji: z.string(),
      discord_bot_avatar_url: z.string().optional(),
      current_conversation_id: z.string().optional(),
      movement: z
        .object({
          from_node_id: z.string(),
          to_node_id: z.string(),
          path: z.array(z.string()),
          arrives_at: z.number().int().nonnegative(),
        })
        .optional(),
      current_activity: z
        .discriminatedUnion('type', [
          z.object({
            type: z.literal('action'),
            action_id: z.string(),
            action_name: z.string(),
            duration_ms: z.number().int().positive(),
            completes_at: z.number().int().nonnegative(),
          }),
          z.object({
            type: z.literal('wait'),
            duration_ms: z.number().int().positive(),
            completes_at: z.number().int().nonnegative(),
          }),
          z.object({
            type: z.literal('item_use'),
            item_id: z.string(),
            item_name: z.string(),
            completes_at: z.number().int().nonnegative(),
            duration_ms: z.number().int().positive().optional(),
          }),
        ])
        .optional(),
    }),
  ),
  conversations: z.array(
    z.object({
      conversation_id: z.string(),
      status: z.enum(['pending', 'active', 'closing']),
      participant_agent_ids: z.array(z.string()),
      current_speaker_agent_id: z.string(),
      current_turn: z.number().int().nonnegative(),
      initiator_agent_id: z.string().optional(),
      closing_reason: z.string().optional(),
    }),
  ),
  server_events: z.array(
    z.object({
      server_event_id: z.string(),
      description: z.string(),
      delivered_agent_ids: z.array(z.string()),
      pending_agent_ids: z.array(z.string()),
    }),
  ),
  generated_at: z.number().int().nonnegative(),
});

const eventBaseSchema = z.object({
  event_id: z.string(),
  occurred_at: z.number().int().nonnegative(),
});

const stringArraySchema = z.array(z.string());
const agentItemSchema = z
  .object({
    item_id: z.string(),
    quantity: z.number(),
  })
  .passthrough();

const worldEventSchema = z.discriminatedUnion('type', [
  eventBaseSchema.extend({
    type: z.literal('agent_logged_in'),
    agent_id: z.string(),
    agent_name: z.string(),
    node_id: z.string(),
    discord_channel_id: z.string(),
  }),
  eventBaseSchema.extend({
    type: z.literal('agent_logged_out'),
    agent_id: z.string(),
    agent_name: z.string(),
    node_id: z.string(),
    discord_channel_id: z.string(),
    cancelled_state: z.enum(['idle', 'moving', 'in_action', 'in_conversation']),
    cancelled_action_name: z.string().optional(),
  }),
  eventBaseSchema.extend({
    type: z.literal('movement_started'),
    agent_id: z.string(),
    agent_name: z.string(),
    from_node_id: z.string(),
    to_node_id: z.string(),
    path: stringArraySchema,
    arrives_at: z.number().int().nonnegative(),
  }),
  eventBaseSchema.extend({
    type: z.literal('movement_completed'),
    agent_id: z.string(),
    agent_name: z.string(),
    node_id: z.string(),
    delivered_server_event_ids: stringArraySchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('action_started'),
    agent_id: z.string(),
    agent_name: z.string(),
    action_id: z.string(),
    action_name: z.string(),
    duration_ms: z.number().int().positive(),
    completes_at: z.number().int().nonnegative(),
    cost_money: z.number().optional(),
    items_consumed: z.array(agentItemSchema).optional(),
  }),
  eventBaseSchema.extend({
    type: z.literal('action_completed'),
    agent_id: z.string(),
    agent_name: z.string(),
    action_id: z.string(),
    action_name: z.string(),
    cost_money: z.number().optional(),
    reward_money: z.number().optional(),
    money_balance: z.number().optional(),
    items_granted: z.array(agentItemSchema).optional(),
    items_dropped: z.array(agentItemSchema).optional(),
  }),
  eventBaseSchema.extend({
    type: z.literal('action_rejected'),
    agent_id: z.string(),
    agent_name: z.string(),
    action_id: z.string(),
    action_name: z.string(),
    rejection_reason: z.string(),
  }),
  eventBaseSchema.extend({
    type: z.literal('wait_started'),
    agent_id: z.string(),
    agent_name: z.string(),
    duration_ms: z.number().int().positive(),
    completes_at: z.number().int().nonnegative(),
  }),
  eventBaseSchema.extend({
    type: z.literal('wait_completed'),
    agent_id: z.string(),
    agent_name: z.string(),
    duration_ms: z.number().int().positive(),
  }),
  eventBaseSchema.extend({
    type: z.literal('item_use_started'),
    agent_id: z.string(),
    agent_name: z.string(),
    item_id: z.string(),
    item_name: z.string(),
    completes_at: z.number().int().nonnegative(),
  }),
  eventBaseSchema.extend({
    type: z.literal('item_use_completed'),
    agent_id: z.string(),
    agent_name: z.string(),
    item_id: z.string(),
    item_name: z.string(),
    item_type: z.enum(['general', 'food', 'drink', 'venue']),
  }),
  eventBaseSchema.extend({
    type: z.literal('item_use_venue_rejected'),
    agent_id: z.string(),
    agent_name: z.string(),
    item_id: z.string(),
    item_name: z.string(),
    venue_hints: stringArraySchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('conversation_requested'),
    conversation_id: z.string(),
    initiator_agent_id: z.string(),
    target_agent_id: z.string(),
    message: z.string(),
  }),
  eventBaseSchema.extend({
    type: z.literal('conversation_accepted'),
    conversation_id: z.string(),
    initiator_agent_id: z.string(),
    participant_agent_ids: stringArraySchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('conversation_rejected'),
    conversation_id: z.string(),
    initiator_agent_id: z.string(),
    target_agent_id: z.string(),
    reason: z.enum(['rejected', 'timeout', 'target_logged_out', 'server_event']),
  }),
  eventBaseSchema.extend({
    type: z.literal('conversation_message'),
    conversation_id: z.string(),
    speaker_agent_id: z.string(),
    listener_agent_ids: stringArraySchema,
    turn: z.number().int().nonnegative(),
    message: z.string(),
  }),
  eventBaseSchema.extend({
    type: z.literal('conversation_join'),
    conversation_id: z.string(),
    agent_id: z.string(),
    agent_name: z.string(),
    participant_agent_ids: stringArraySchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('conversation_leave'),
    conversation_id: z.string(),
    agent_id: z.string(),
    agent_name: z.string(),
    reason: z.enum(['voluntary', 'inactive', 'logged_out', 'server_event']),
    participant_agent_ids: stringArraySchema,
    message: z.string().optional(),
    next_speaker_agent_id: z.string().optional(),
  }),
  eventBaseSchema.extend({
    type: z.literal('conversation_inactive_check'),
    conversation_id: z.string(),
    target_agent_ids: stringArraySchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('conversation_interval_interrupted'),
    conversation_id: z.string(),
    speaker_agent_id: z.string(),
    listener_agent_ids: stringArraySchema,
    next_speaker_agent_id: z.string(),
    participant_agent_ids: stringArraySchema,
    message: z.string(),
    closing: z.boolean(),
  }),
  eventBaseSchema.extend({
    type: z.literal('conversation_turn_started'),
    conversation_id: z.string(),
    current_speaker_agent_id: z.string(),
  }),
  eventBaseSchema.extend({
    type: z.literal('conversation_closing'),
    conversation_id: z.string(),
    initiator_agent_id: z.string(),
    participant_agent_ids: stringArraySchema,
    current_speaker_agent_id: z.string(),
    reason: z.enum(['ended_by_agent', 'max_turns', 'server_event']),
  }),
  eventBaseSchema.extend({
    type: z.literal('conversation_ended'),
    conversation_id: z.string(),
    initiator_agent_id: z.string(),
    participant_agent_ids: stringArraySchema,
    reason: z.enum(['max_turns', 'turn_timeout', 'server_event', 'ended_by_agent', 'participant_logged_out']),
    final_message: z.string().optional(),
    final_speaker_agent_id: z.string().optional(),
  }),
  eventBaseSchema.extend({
    type: z.literal('conversation_pending_join_cancelled'),
    conversation_id: z.string(),
    agent_id: z.string(),
    reason: z.enum([
      'max_turns',
      'turn_timeout',
      'server_event',
      'ended_by_agent',
      'participant_logged_out',
      'agent_unavailable',
    ]),
  }),
  eventBaseSchema.extend({
    type: z.literal('server_event_fired'),
    server_event_id: z.string(),
    description: z.string(),
    delivered_agent_ids: stringArraySchema,
    pending_agent_ids: stringArraySchema,
    delayed: z.boolean(),
  }),
]);

const KNOWN_WORLD_EVENT_TYPES = new Set<string>([
  'agent_logged_in',
  'agent_logged_out',
  'movement_started',
  'movement_completed',
  'action_started',
  'action_completed',
  'action_rejected',
  'wait_started',
  'wait_completed',
  'item_use_started',
  'item_use_completed',
  'item_use_venue_rejected',
  'conversation_requested',
  'conversation_accepted',
  'conversation_rejected',
  'conversation_message',
  'conversation_join',
  'conversation_leave',
  'conversation_inactive_check',
  'conversation_interval_interrupted',
  'conversation_turn_started',
  'conversation_closing',
  'conversation_ended',
  'conversation_pending_join_cancelled',
  'server_event_fired',
]);

const recentServerEventRowSchema = z.object({
  server_event_id: z.string().min(1),
  description: z.string(),
  occurred_at: z.coerce.number().int().nonnegative(),
});

const RECENT_SERVER_EVENTS_QUERY = `
SELECT
  server_event_id,
  description,
  first_occurred_at AS occurred_at
FROM server_event_instances
ORDER BY first_occurred_at DESC, server_event_id DESC
LIMIT 3
`;

const INSERT_WORLD_EVENT_QUERY = `
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
`;

const INSERT_WORLD_EVENT_AGENT_QUERY = `
INSERT INTO world_event_agents (
  event_id,
  agent_id,
  occurred_at,
  event_type,
  role
) VALUES (?, ?, ?, ?, ?)
`;

const INSERT_WORLD_EVENT_CONVERSATION_QUERY = `
INSERT INTO world_event_conversations (
  event_id,
  conversation_id,
  occurred_at,
  event_type
) VALUES (?, ?, ?, ?)
`;

const UPSERT_SERVER_EVENT_INSTANCE_QUERY = `
INSERT INTO server_event_instances (
  server_event_id,
  description,
  first_occurred_at,
  last_occurred_at
) VALUES (?, ?, ?, ?)
ON CONFLICT(server_event_id) DO UPDATE SET
  first_occurred_at = MIN(server_event_instances.first_occurred_at, excluded.first_occurred_at),
  last_occurred_at = MAX(server_event_instances.last_occurred_at, excluded.last_occurred_at)
`;

type WorldEventAgentRole = 'subject' | 'target' | 'participant' | 'delivered' | 'pending';

interface PersistedEventSummary {
  emoji: string;
  title: string;
  text: string;
}

const textDecoder = new TextDecoder();

function isMissingServerEventInstancesTableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /no such table:\s*(?:main\.)?server_event_instances/i.test(error.message);
}

function defaultFetchImpl(input: string | URL | Request, init?: RequestInit): Promise<RelayFetchResponse> {
  return fetch(input, init) as Promise<RelayFetchResponse>;
}

function bindD1Statement(
  db: D1DatabaseLike,
  query: string,
  ...values: unknown[]
): D1PreparedStatementLike {
  const statement = db.prepare(query.trim());

  if (typeof statement.bind !== 'function') {
    throw new Error('D1 prepared statement does not support bind()');
  }

  return statement.bind(...values);
}

function buildActionEmojiIndex(worldSnapshot: WorldSnapshot): Map<string, string> {
  const actionEmojiIndex = new Map<string, string>();

  for (const building of worldSnapshot.map.buildings) {
    for (const action of building.actions) {
      if (action.emoji) {
        actionEmojiIndex.set(action.action_id, action.emoji);
      }
    }
  }

  for (const npc of worldSnapshot.map.npcs) {
    for (const action of npc.actions) {
      if (!actionEmojiIndex.has(action.action_id) && action.emoji) {
        actionEmojiIndex.set(action.action_id, action.emoji);
      }
    }
  }

  return actionEmojiIndex;
}

function resolvePersistedActionEmoji(
  worldEvent: Extract<WorldEvent, { type: 'action_started' | 'action_completed' | 'action_rejected' }>,
  getActionEmoji?: (actionId: string) => string | undefined,
): string {
  return (
    getActionEmoji?.(worldEvent.action_id) ??
    (worldEvent.type === 'action_started' ? '✨' : worldEvent.type === 'action_completed' ? '✅' : '⚠️')
  );
}

function buildPersistedEventSummary(
  worldEvent: WorldEvent,
  getActionEmoji?: (actionId: string) => string | undefined,
): PersistedEventSummary {
  switch (worldEvent.type) {
    case 'agent_logged_in':
      return {
        emoji: '👋',
        title: 'ログイン',
        text: `${worldEvent.agent_name} が ${worldEvent.node_id} にログイン`,
      };
    case 'agent_logged_out':
      return {
        emoji: '🚪',
        title: 'ログアウト',
        text: `${worldEvent.agent_name} がログアウト`,
      };
    case 'movement_started':
      return {
        emoji: '🚶',
        title: '移動開始',
        text: `${worldEvent.from_node_id} → ${worldEvent.to_node_id}`,
      };
    case 'movement_completed':
      return {
        emoji: '📍',
        title: '移動完了',
        text: `${worldEvent.node_id} に到着`,
      };
    case 'action_started':
      return {
        emoji: resolvePersistedActionEmoji(worldEvent, getActionEmoji),
        title: 'アクション開始',
        text: `${worldEvent.action_name} を開始`,
      };
    case 'action_completed':
      return {
        emoji: resolvePersistedActionEmoji(worldEvent, getActionEmoji),
        title: 'アクション完了',
        text: `${worldEvent.action_name} を完了`,
      };
    case 'action_rejected':
      return {
        emoji: '⚠️',
        title: 'アクション失敗',
        text: `${worldEvent.action_name}: ${worldEvent.rejection_reason}`,
      };
    case 'wait_started':
      return {
        emoji: '💤',
        title: '待機開始',
        text: `${worldEvent.duration_ms}ms の待機`,
      };
    case 'wait_completed':
      return {
        emoji: '⏰',
        title: '待機完了',
        text: '待機を終了',
      };
    case 'item_use_started':
      return {
        emoji: '🧰',
        title: 'アイテム使用開始',
        text: `${worldEvent.item_name} を使用開始`,
      };
    case 'item_use_completed':
      return {
        emoji: '🎒',
        title: 'アイテム使用完了',
        text: `${worldEvent.item_name} を使用`,
      };
    case 'item_use_venue_rejected':
      return {
        emoji: '📍',
        title: '場所が必要',
        text: `${worldEvent.item_name} は専用アクションで使用`,
      };
    case 'conversation_requested':
      return {
        emoji: '💬',
        title: '会話申請',
        text: '会話を開始',
      };
    case 'conversation_accepted':
      return {
        emoji: '🤝',
        title: '会話開始',
        text: '会話が成立',
      };
    case 'conversation_rejected':
      return {
        emoji: '🙅',
        title: '会話拒否',
        text: `理由: ${worldEvent.reason}`,
      };
    case 'conversation_message':
      return {
        emoji: '💬',
        title: '発言',
        text: worldEvent.message,
      };
    case 'conversation_join':
      return {
        emoji: '👥',
        title: '会話参加',
        text: `${worldEvent.agent_name} が参加`,
      };
    case 'conversation_leave':
      return {
        emoji: '↩️',
        title: '会話離脱',
        text: `${worldEvent.agent_name} が離脱`,
      };
    case 'conversation_inactive_check':
      return {
        emoji: '❓',
        title: '応答確認',
        text: 'inactive check を送信',
      };
    case 'conversation_interval_interrupted':
      return {
        emoji: '⏸️',
        title: '会話中断',
        text: '理由に応じて会話間隔が打ち切られた',
      };
    case 'conversation_turn_started':
      return {
        emoji: '🎙️',
        title: '発言ターン',
        text: `次の話者: ${worldEvent.current_speaker_agent_id}`,
      };
    case 'conversation_closing':
      return {
        emoji: '🔚',
        title: '会話終了処理',
        text: `理由: ${worldEvent.reason}`,
      };
    case 'conversation_ended':
      return {
        emoji: '🛑',
        title: '会話終了',
        text: `理由: ${worldEvent.reason}`,
      };
    case 'conversation_pending_join_cancelled':
      return {
        emoji: '🚫',
        title: '参加取消',
        text: `理由: ${worldEvent.reason}`,
      };
    case 'server_event_fired':
      return {
        emoji: '📢',
        title: 'サーバーイベント',
        text: worldEvent.description,
      };
    case 'idle_reminder_fired':
      return {
        emoji: '🔔',
        title: 'アイドル通知',
        text: `${worldEvent.agent_name} に idle reminder を送信`,
      };
    case 'map_info_requested':
      return {
        emoji: '🗺️',
        title: 'マップ通知要求',
        text: `${worldEvent.agent_id} がマップ通知を要求`,
      };
    case 'world_agents_info_requested':
      return {
        emoji: '👀',
        title: 'エージェント通知要求',
        text: `${worldEvent.agent_id} が world agents 通知を要求`,
      };
    case 'perception_requested':
      return {
        emoji: '👁️',
        title: '知覚通知要求',
        text: `${worldEvent.agent_id} が知覚通知を要求`,
      };
    case 'available_actions_requested':
      return {
        emoji: '📋',
        title: '行動通知要求',
        text: `${worldEvent.agent_id} が actions 通知を要求`,
      };
  }
}

function assignAgentRole(
  roles: Map<string, WorldEventAgentRole>,
  agentId: string,
  role: WorldEventAgentRole,
): void {
  const current = roles.get(agentId);

  if (
    current === undefined ||
    (current === 'pending' && role !== 'pending') ||
    (current === 'delivered' && (role === 'subject' || role === 'target' || role === 'participant')) ||
    (current === 'participant' && (role === 'subject' || role === 'target')) ||
    (current === 'target' && role === 'subject')
  ) {
    roles.set(agentId, role);
  }
}

function buildWorldEventAgentRoles(
  worldEvent: WorldEvent,
  stagedConversationUpdate?: StagedConversationMirrorUpdate,
): Map<string, WorldEventAgentRole> {
  const roles = new Map<string, WorldEventAgentRole>();

  switch (worldEvent.type) {
    case 'agent_logged_in':
    case 'agent_logged_out':
    case 'movement_started':
    case 'movement_completed':
    case 'action_started':
    case 'action_completed':
    case 'action_rejected':
    case 'wait_started':
    case 'wait_completed':
    case 'item_use_started':
    case 'item_use_completed':
    case 'item_use_venue_rejected':
    case 'idle_reminder_fired':
    case 'map_info_requested':
    case 'world_agents_info_requested':
    case 'perception_requested':
    case 'available_actions_requested':
      assignAgentRole(roles, worldEvent.agent_id, 'subject');
      break;
    case 'conversation_requested':
      assignAgentRole(roles, worldEvent.initiator_agent_id, 'subject');
      assignAgentRole(roles, worldEvent.target_agent_id, 'target');
      break;
    case 'conversation_accepted':
      assignAgentRole(roles, worldEvent.initiator_agent_id, 'subject');
      for (const agentId of worldEvent.participant_agent_ids) {
        if (agentId !== worldEvent.initiator_agent_id) {
          assignAgentRole(roles, agentId, 'participant');
        }
      }
      break;
    case 'conversation_rejected':
      assignAgentRole(roles, worldEvent.initiator_agent_id, 'subject');
      assignAgentRole(roles, worldEvent.target_agent_id, 'target');
      break;
    case 'conversation_message':
      assignAgentRole(roles, worldEvent.speaker_agent_id, 'subject');
      for (const agentId of worldEvent.listener_agent_ids) {
        assignAgentRole(roles, agentId, 'participant');
      }
      break;
    case 'conversation_join':
      assignAgentRole(roles, worldEvent.agent_id, 'subject');
      for (const agentId of worldEvent.participant_agent_ids) {
        if (agentId !== worldEvent.agent_id) {
          assignAgentRole(roles, agentId, 'participant');
        }
      }
      break;
    case 'conversation_leave':
      assignAgentRole(roles, worldEvent.agent_id, 'subject');
      for (const agentId of worldEvent.participant_agent_ids) {
        assignAgentRole(roles, agentId, 'participant');
      }
      break;
    case 'conversation_inactive_check': {
      const participantAgentIds = stagedConversationUpdate?.resolved_conversation?.participant_agent_ids ?? [];
      for (const agentId of worldEvent.target_agent_ids) {
        assignAgentRole(roles, agentId, 'target');
      }
      for (const agentId of participantAgentIds) {
        if (!worldEvent.target_agent_ids.includes(agentId)) {
          assignAgentRole(roles, agentId, 'participant');
        }
      }
      break;
    }
    case 'conversation_interval_interrupted':
      assignAgentRole(roles, worldEvent.speaker_agent_id, 'subject');
      for (const agentId of worldEvent.participant_agent_ids) {
        if (agentId !== worldEvent.speaker_agent_id) {
          assignAgentRole(roles, agentId, 'participant');
        }
      }
      break;
    case 'conversation_turn_started': {
      assignAgentRole(roles, worldEvent.current_speaker_agent_id, 'subject');
      const participantAgentIds = stagedConversationUpdate?.resolved_conversation?.participant_agent_ids ?? [];
      for (const agentId of participantAgentIds) {
        if (agentId !== worldEvent.current_speaker_agent_id) {
          assignAgentRole(roles, agentId, 'participant');
        }
      }
      break;
    }
    case 'conversation_closing':
      assignAgentRole(roles, worldEvent.current_speaker_agent_id, 'subject');
      for (const agentId of worldEvent.participant_agent_ids) {
        if (agentId !== worldEvent.current_speaker_agent_id) {
          assignAgentRole(roles, agentId, 'participant');
        }
      }
      break;
    case 'conversation_ended':
      if (worldEvent.final_speaker_agent_id) {
        assignAgentRole(roles, worldEvent.final_speaker_agent_id, 'subject');
      }
      for (const agentId of worldEvent.participant_agent_ids) {
        if (agentId !== worldEvent.final_speaker_agent_id) {
          assignAgentRole(roles, agentId, 'participant');
        }
      }
      break;
    case 'conversation_pending_join_cancelled':
      assignAgentRole(roles, worldEvent.agent_id, 'target');
      break;
    case 'server_event_fired':
      for (const agentId of worldEvent.delivered_agent_ids) {
        assignAgentRole(roles, agentId, 'delivered');
      }
      for (const agentId of worldEvent.pending_agent_ids) {
        assignAgentRole(roles, agentId, 'pending');
      }
      break;
  }

  return roles;
}

export function createRuntimePersistWorldEvent(
  db?: D1DatabaseLike,
  getActionEmoji?: (actionId: string) => string | undefined,
  observability?: RelayObservability,
): BridgeDependencies['persistWorldEvent'] | undefined {
  const batch = db?.batch;

  if (!db || typeof batch !== 'function') {
    return undefined;
  }

  return async (worldEvent, stagedConversationUpdate) => {
    const sanitizedWorldEvent = sanitize(worldEvent);

    if (!sanitizedWorldEvent) {
      observability?.counter('relay.event.unknown_total', { event_type: String(worldEvent.type) });
      observability?.log('warn', 'relay dropped unknown world event before ingest', {
        event_type: String(worldEvent.type),
      });
      return;
    }

    const summary = buildPersistedEventSummary(worldEvent, getActionEmoji);
    const agentRoles = buildWorldEventAgentRoles(worldEvent, stagedConversationUpdate);
    const statements: D1PreparedStatementLike[] = [
      bindD1Statement(
        db,
        INSERT_WORLD_EVENT_QUERY,
        worldEvent.event_id,
        worldEvent.type,
        worldEvent.occurred_at,
        'conversation_id' in worldEvent ? worldEvent.conversation_id : null,
        worldEvent.type === 'server_event_fired' ? worldEvent.server_event_id : null,
        summary.emoji,
        summary.title,
        summary.text,
        JSON.stringify(sanitizedWorldEvent),
      ),
    ];

    for (const [agentId, role] of agentRoles) {
      statements.push(
        bindD1Statement(
          db,
          INSERT_WORLD_EVENT_AGENT_QUERY,
          worldEvent.event_id,
          agentId,
          worldEvent.occurred_at,
          worldEvent.type,
          role,
        ),
      );
    }

    if ('conversation_id' in worldEvent) {
      statements.push(
        bindD1Statement(
          db,
          INSERT_WORLD_EVENT_CONVERSATION_QUERY,
          worldEvent.event_id,
          worldEvent.conversation_id,
          worldEvent.occurred_at,
          worldEvent.type,
        ),
      );
    }

    if (worldEvent.type === 'server_event_fired') {
      statements.push(
        bindD1Statement(
          db,
          UPSERT_SERVER_EVENT_INSTANCE_QUERY,
          worldEvent.server_event_id,
          worldEvent.description,
          worldEvent.occurred_at,
          worldEvent.occurred_at,
        ),
      );
    }

    try {
      await batch.call(db, statements);
    } catch (error) {
      observability?.counter('relay.d1.ingest_failure_total', { event_type: worldEvent.type });
      observability?.log('error', 'relay failed to persist world event batch', {
        event_type: worldEvent.type,
        event_id: worldEvent.event_id,
        error: describeError(error),
      });
      throw error;
    }
  };
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readOptionalConversationClosureReason(
  record: Record<string, unknown>,
  key: string,
): ConversationClosureReason | undefined {
  const value = readOptionalString(record, key);

  if (
    value === 'max_turns' ||
    value === 'turn_timeout' ||
    value === 'server_event' ||
    value === 'ended_by_agent' ||
    value === 'participant_logged_out'
  ) {
    return value;
  }

  return undefined;
}

function decodeMessageData(data: unknown): string | null {
  if (typeof data === 'string') {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return textDecoder.decode(new Uint8Array(data));
  }

  if (ArrayBuffer.isView(data)) {
    return textDecoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }

  return null;
}

interface SocketPayloadHooks {
  onUnknownEventType?: (eventType: string) => void;
}

export function parseSocketPayload(data: unknown, hooks?: SocketPayloadHooks): SocketPayload | null {
  const decoded = decodeMessageData(data);

  if (decoded === null) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }

  const result = socketPayloadSchema.safeParse(parsed);

  if (!result.success) {
    return null;
  }

  if (result.data.type === 'snapshot') {
    const snapshotResult = worldSnapshotSchema.safeParse(result.data.data);

    if (!snapshotResult.success) {
      return null;
    }

    return {
      type: 'snapshot',
      data: snapshotResult.data as WorldSnapshot,
    };
  }

  const eventCandidate = result.data.data as Record<string, unknown>;

  if (typeof eventCandidate?.type === 'string' && !KNOWN_WORLD_EVENT_TYPES.has(eventCandidate.type)) {
    hooks?.onUnknownEventType?.(eventCandidate.type);
    return null;
  }

  const eventResult = worldEventSchema.safeParse(result.data.data);

  if (!eventResult.success) {
    return null;
  }

  return {
    type: 'event',
    data: eventResult.data as WorldEvent,
  };
}

async function fetchWorldSnapshot(config: RelayConfig, fetchImpl: RelayFetch): Promise<WorldSnapshot> {
  const response = await fetchImpl(config.snapshotUrl.toString(), {
    headers: {
      'X-Admin-Key': config.kwAdminKey,
    },
  });

  if (response.status !== 200 || typeof response.json !== 'function') {
    throw new Error(`Snapshot refresh failed with status ${response.status}`);
  }

  const payload = await response.json();
  const snapshotResult = worldSnapshotSchema.safeParse(payload);

  if (!snapshotResult.success) {
    throw new Error('Snapshot refresh returned an invalid payload');
  }

  return snapshotResult.data as WorldSnapshot;
}

function calculateBackoff(baseIntervalMs: number, streak: number, maxIntervalMs: number): number {
  return Math.min(baseIntervalMs * 2 ** Math.max(streak - 1, 0), maxIntervalMs);
}

function calculateJitteredBackoff(backoffMs: number, random: () => number): number {
  const jitterOffset = (random() * 2 - 1) * WEBSOCKET_RECONNECT_JITTER_RATIO;
  return Math.max(0, Math.round(backoffMs * (1 + jitterOffset)));
}

interface PersistedReconnectState {
  reconnect_attempt: number;
  disconnect_started_at?: number;
  websocket_reconnect_alarm_at?: number;
}

interface PersistedOutageRuntimeState {
  latest_snapshot: SpectatorSnapshot;
  last_publish_at?: number;
  last_refresh_at?: number;
  refresh_alarm_at?: number;
  publish_alarm_at?: number;
  publish_failure_streak: number;
  heartbeat_failure_streak: number;
}

function createRuntimeSnapshotPublisher(snapshotBucket?: R2BucketLike): (input: SnapshotPublishInput) => Promise<void> {
  if (!snapshotBucket) {
    return async () => {};
  }

  return async ({ key, body, options }) => {
    await snapshotBucket.put(key, body, options);
  };
}

export function createBridgeState(): BridgeState {
  return {
    conversations: {},
    recent_server_events: [],
    active_server_event_ids: [],
    reconnect_attempt: 0,
    refresh_in_flight: false,
    refresh_queued: false,
    publish_in_flight: false,
    publish_queued: false,
    publish_failure_streak: 0,
    heartbeat_failure_streak: 0,
  };
}

export function rebuildConversationMirror(
  worldSnapshot: WorldSnapshot,
  updatedAt: number,
): Record<string, BridgeConversationState> {
  return Object.fromEntries(
    worldSnapshot.conversations.map((conversation) => {
      const conversationRecord = conversation as Record<string, unknown>;

      return [
        conversation.conversation_id,
        {
          conversation_id: conversation.conversation_id,
          status: conversation.status,
          participant_agent_ids: [...conversation.participant_agent_ids],
          ...(readOptionalString(conversationRecord, 'initiator_agent_id')
            ? { initiator_agent_id: readOptionalString(conversationRecord, 'initiator_agent_id') }
            : {}),
          ...(typeof conversation.current_speaker_agent_id === 'string'
            ? { current_speaker_agent_id: conversation.current_speaker_agent_id }
            : {}),
          ...(readOptionalConversationClosureReason(conversationRecord, 'closing_reason')
            ? { closing_reason: readOptionalConversationClosureReason(conversationRecord, 'closing_reason') }
            : {}),
          updated_at: updatedAt,
        } satisfies BridgeConversationState,
      ];
    }),
  );
}

function cloneConversationState(conversation: BridgeConversationState): BridgeConversationState {
  return {
    ...conversation,
    participant_agent_ids: [...conversation.participant_agent_ids],
  };
}

function cloneConversationMirror(
  conversations: Record<string, BridgeConversationState>,
): Record<string, BridgeConversationState> {
  return Object.fromEntries(
    Object.entries(conversations).map(([conversationId, conversation]) => [conversationId, cloneConversationState(conversation)]),
  );
}

function dedupeAgentIds(agentIds: string[]): string[] {
  return [...new Set(agentIds)];
}

export function isConversationWorldEvent(worldEvent: WorldEvent): worldEvent is ConversationWorldEvent {
  return 'conversation_id' in worldEvent;
}

export function resolveConversationEventAgentIds(
  worldEvent: ConversationWorldEvent,
  conversationState?: BridgeConversationState,
): string[] {
  switch (worldEvent.type) {
    case 'conversation_requested':
      return dedupeAgentIds([worldEvent.initiator_agent_id, worldEvent.target_agent_id]);
    case 'conversation_accepted':
      return dedupeAgentIds([worldEvent.initiator_agent_id, ...worldEvent.participant_agent_ids]);
    case 'conversation_rejected':
      return dedupeAgentIds(
        conversationState?.participant_agent_ids ?? [worldEvent.initiator_agent_id, worldEvent.target_agent_id],
      );
    case 'conversation_message':
      return dedupeAgentIds([worldEvent.speaker_agent_id, ...worldEvent.listener_agent_ids]);
    case 'conversation_join':
      return dedupeAgentIds([worldEvent.agent_id, ...worldEvent.participant_agent_ids]);
    case 'conversation_leave':
      return dedupeAgentIds([worldEvent.agent_id, ...worldEvent.participant_agent_ids]);
    case 'conversation_inactive_check':
      return dedupeAgentIds([
        ...worldEvent.target_agent_ids,
        ...(conversationState?.participant_agent_ids.filter((agentId) => !worldEvent.target_agent_ids.includes(agentId)) ?? []),
      ]);
    case 'conversation_interval_interrupted':
      return dedupeAgentIds([worldEvent.speaker_agent_id, ...worldEvent.participant_agent_ids]);
    case 'conversation_turn_started':
      return dedupeAgentIds([
        worldEvent.current_speaker_agent_id,
        ...(conversationState?.participant_agent_ids.filter(
          (agentId) => agentId !== worldEvent.current_speaker_agent_id,
        ) ?? []),
      ]);
    case 'conversation_closing':
      return dedupeAgentIds([worldEvent.current_speaker_agent_id, ...worldEvent.participant_agent_ids]);
    case 'conversation_ended':
      return dedupeAgentIds(
        worldEvent.final_speaker_agent_id
          ? [worldEvent.final_speaker_agent_id, ...worldEvent.participant_agent_ids]
          : [...worldEvent.participant_agent_ids],
      );
    case 'conversation_pending_join_cancelled':
      return [worldEvent.agent_id];
  }
}

function buildConversationMirrorState(
  conversationId: string,
  updatedAt: number,
  partial: Omit<BridgeConversationState, 'conversation_id' | 'updated_at'>,
): BridgeConversationState {
  return {
    conversation_id: conversationId,
    updated_at: updatedAt,
    ...partial,
    participant_agent_ids: [...partial.participant_agent_ids],
  };
}

export function stageConversationMirrorUpdate(
  conversations: Record<string, BridgeConversationState>,
  worldEvent: ConversationWorldEvent,
): StagedConversationMirrorUpdate {
  const nextConversations = cloneConversationMirror(conversations);
  const existingConversation = nextConversations[worldEvent.conversation_id];
  const updatedAt = worldEvent.occurred_at;
  let resolvedConversation = existingConversation ? cloneConversationState(existingConversation) : undefined;

  switch (worldEvent.type) {
    case 'conversation_requested':
      resolvedConversation = buildConversationMirrorState(worldEvent.conversation_id, updatedAt, {
        status: 'pending',
        participant_agent_ids: dedupeAgentIds([worldEvent.initiator_agent_id, worldEvent.target_agent_id]),
        initiator_agent_id: worldEvent.initiator_agent_id,
      });
      nextConversations[worldEvent.conversation_id] = resolvedConversation;
      break;
    case 'conversation_accepted':
      resolvedConversation = buildConversationMirrorState(worldEvent.conversation_id, updatedAt, {
        status: 'active',
        participant_agent_ids: dedupeAgentIds([worldEvent.initiator_agent_id, ...worldEvent.participant_agent_ids]),
        initiator_agent_id: worldEvent.initiator_agent_id,
        ...(existingConversation?.current_speaker_agent_id
          ? { current_speaker_agent_id: existingConversation.current_speaker_agent_id }
          : {}),
      });
      nextConversations[worldEvent.conversation_id] = resolvedConversation;
      break;
    case 'conversation_rejected':
      resolvedConversation =
        existingConversation ??
        buildConversationMirrorState(worldEvent.conversation_id, updatedAt, {
          status: 'pending',
          participant_agent_ids: dedupeAgentIds([worldEvent.initiator_agent_id, worldEvent.target_agent_id]),
          initiator_agent_id: worldEvent.initiator_agent_id,
        });
      resolvedConversation = {
        ...resolvedConversation,
        updated_at: updatedAt,
      };
      delete nextConversations[worldEvent.conversation_id];
      break;
    case 'conversation_message':
      if (existingConversation) {
        resolvedConversation = {
          ...cloneConversationState(existingConversation),
          updated_at: updatedAt,
        };
        nextConversations[worldEvent.conversation_id] = resolvedConversation;
      } else {
        resolvedConversation = undefined;
      }
      break;
    case 'conversation_join':
      resolvedConversation = buildConversationMirrorState(worldEvent.conversation_id, updatedAt, {
        status: 'active',
        participant_agent_ids: dedupeAgentIds(worldEvent.participant_agent_ids),
        ...(existingConversation?.initiator_agent_id ? { initiator_agent_id: existingConversation.initiator_agent_id } : {}),
        ...(existingConversation?.current_speaker_agent_id
          ? { current_speaker_agent_id: existingConversation.current_speaker_agent_id }
          : {}),
        ...(existingConversation?.closing_reason ? { closing_reason: existingConversation.closing_reason } : {}),
      });
      nextConversations[worldEvent.conversation_id] = resolvedConversation;
      break;
    case 'conversation_leave':
      resolvedConversation = buildConversationMirrorState(worldEvent.conversation_id, updatedAt, {
        status: existingConversation?.status ?? 'active',
        participant_agent_ids: dedupeAgentIds(worldEvent.participant_agent_ids),
        ...(existingConversation?.initiator_agent_id ? { initiator_agent_id: existingConversation.initiator_agent_id } : {}),
        ...(worldEvent.next_speaker_agent_id
          ? { current_speaker_agent_id: worldEvent.next_speaker_agent_id }
          : existingConversation?.current_speaker_agent_id
            ? { current_speaker_agent_id: existingConversation.current_speaker_agent_id }
            : {}),
        ...(existingConversation?.closing_reason ? { closing_reason: existingConversation.closing_reason } : {}),
      });
      nextConversations[worldEvent.conversation_id] = resolvedConversation;
      break;
    case 'conversation_inactive_check':
      if (existingConversation) {
        resolvedConversation = {
          ...cloneConversationState(existingConversation),
          updated_at: updatedAt,
        };
        nextConversations[worldEvent.conversation_id] = resolvedConversation;
      } else {
        resolvedConversation = undefined;
      }
      break;
    case 'conversation_interval_interrupted':
      resolvedConversation = buildConversationMirrorState(worldEvent.conversation_id, updatedAt, {
        status: existingConversation?.status ?? 'active',
        participant_agent_ids: dedupeAgentIds(worldEvent.participant_agent_ids),
        ...(existingConversation?.initiator_agent_id ? { initiator_agent_id: existingConversation.initiator_agent_id } : {}),
        current_speaker_agent_id: worldEvent.next_speaker_agent_id,
        ...(existingConversation?.closing_reason ? { closing_reason: existingConversation.closing_reason } : {}),
      });
      nextConversations[worldEvent.conversation_id] = resolvedConversation;
      break;
    case 'conversation_turn_started':
      resolvedConversation = buildConversationMirrorState(worldEvent.conversation_id, updatedAt, {
        status: existingConversation?.status ?? 'active',
        participant_agent_ids: existingConversation
          ? [...existingConversation.participant_agent_ids]
          : [worldEvent.current_speaker_agent_id],
        ...(existingConversation?.initiator_agent_id ? { initiator_agent_id: existingConversation.initiator_agent_id } : {}),
        current_speaker_agent_id: worldEvent.current_speaker_agent_id,
        ...(existingConversation?.closing_reason ? { closing_reason: existingConversation.closing_reason } : {}),
      });
      nextConversations[worldEvent.conversation_id] = resolvedConversation;
      break;
    case 'conversation_closing':
      resolvedConversation = buildConversationMirrorState(worldEvent.conversation_id, updatedAt, {
        status: 'closing',
        participant_agent_ids: dedupeAgentIds(worldEvent.participant_agent_ids),
        initiator_agent_id: worldEvent.initiator_agent_id,
        current_speaker_agent_id: worldEvent.current_speaker_agent_id,
        closing_reason: worldEvent.reason,
      });
      nextConversations[worldEvent.conversation_id] = resolvedConversation;
      break;
    case 'conversation_ended':
      resolvedConversation = buildConversationMirrorState(worldEvent.conversation_id, updatedAt, {
        status: 'closing',
        participant_agent_ids: dedupeAgentIds(worldEvent.participant_agent_ids),
        initiator_agent_id: worldEvent.initiator_agent_id,
        ...(worldEvent.final_speaker_agent_id
          ? { current_speaker_agent_id: worldEvent.final_speaker_agent_id }
          : existingConversation?.current_speaker_agent_id
            ? { current_speaker_agent_id: existingConversation.current_speaker_agent_id }
          : {}),
        closing_reason: worldEvent.reason,
      });
      delete nextConversations[worldEvent.conversation_id];
      break;
    case 'conversation_pending_join_cancelled':
      resolvedConversation = existingConversation ? cloneConversationState(existingConversation) : undefined;
      break;
  }

  return {
    conversation_id: worldEvent.conversation_id,
    next_conversations: nextConversations,
    ...(resolvedConversation ? { resolved_conversation: resolvedConversation } : {}),
    resolved_agent_ids: resolveConversationEventAgentIds(worldEvent, resolvedConversation),
  };
}

function mergeRecentServerEvent(
  recentServerEvents: SpectatorRecentServerEvent[],
  worldEvent: Extract<WorldEvent, { type: 'server_event_fired' }>,
): SpectatorRecentServerEvent[] {
  if (recentServerEvents.some((event) => event.server_event_id === worldEvent.server_event_id)) {
    return recentServerEvents.map((event) =>
      event.server_event_id === worldEvent.server_event_id ? { ...event, is_active: true } : event,
    );
  }

  return [
    {
      server_event_id: worldEvent.server_event_id,
      description: worldEvent.description,
      occurred_at: worldEvent.occurred_at,
      is_active: true,
    },
    ...recentServerEvents,
  ]
    .sort((left, right) => right.occurred_at - left.occurred_at || right.server_event_id.localeCompare(left.server_event_id))
    .slice(0, 3);
}

function mergeRecentServerEventsFromSnapshot(
  recentServerEvents: SpectatorRecentServerEvent[],
  previousActiveServerEventIds: readonly string[],
  serverEvents: WorldSnapshot['server_events'],
  generatedAt: number,
): SpectatorRecentServerEvent[] {
  const previousActiveSet = new Set(previousActiveServerEventIds);
  const byId = new Map(
    recentServerEvents.map((event) => [
      event.server_event_id,
      {
        ...event,
        is_active: false,
      },
    ]),
  );

  for (const serverEvent of serverEvents) {
    const existing = byId.get(serverEvent.server_event_id);

    if (existing) {
      existing.description = serverEvent.description;
      existing.is_active = true;
      continue;
    }

    if (!previousActiveSet.has(serverEvent.server_event_id)) {
      byId.set(serverEvent.server_event_id, {
        server_event_id: serverEvent.server_event_id,
        description: serverEvent.description,
        occurred_at: generatedAt,
        is_active: true,
      });
    }
  }

  return [...byId.values()]
    .sort((left, right) => right.occurred_at - left.occurred_at || right.server_event_id.localeCompare(left.server_event_id))
    .slice(0, 3);
}

export async function restoreRecentServerEvents(db?: D1DatabaseLike): Promise<SpectatorRecentServerEvent[]> {
  if (!db) {
    return [];
  }

  let result: D1QueryResult<unknown>;

  try {
    result = await db.prepare(RECENT_SERVER_EVENTS_QUERY.trim()).all();
  } catch (error) {
    if (isMissingServerEventInstancesTableError(error)) {
      return [];
    }

    throw error;
  }

  return (result.results ?? []).map((row) => ({
    ...recentServerEventRowSchema.parse(row),
    is_active: false,
  }));
}

export async function openBridgeWebSocket(config: RelayConfig, fetchImpl: RelayFetch): Promise<RelayWebSocket> {
  let response: RelayFetchResponse;

  try {
    response = await fetchImpl(config.wsUrl.toString(), {
      headers: {
        Upgrade: 'websocket',
        'X-Admin-Key': config.kwAdminKey,
      },
    });
  } catch (error) {
    throw new WebSocketUpgradeError(describeError(error), classifyTransportError(error));
  }

  if (response.status !== 101 || !response.webSocket) {
    throw new WebSocketUpgradeError(
      `WebSocket upgrade failed with status ${response.status}`,
      classifyHandshakeStatus(response.status),
    );
  }

  response.webSocket.accept?.();
  return response.webSocket;
}

export class UIBridgeDurableObject {
  private readonly config: RelayConfig;
  private readonly bridgeState = createBridgeState();
  private readonly dependencies: BridgeDependencies;
  private actionEmojiIndex = new Map<string, string>();
  private bootPromise?: Promise<void>;
  private readonly serializedOperations: Array<() => Promise<void>> = [];
  private drainingSerializedOperations = false;

  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly env: RelayBindings,
    dependencies: Partial<BridgeDependencies> = {},
  ) {
    this.config = parseRelayEnv(env);
    const now = dependencies.now ?? (() => Date.now());
    const random = dependencies.random ?? (() => Math.random());
    const observability = dependencies.observability ?? createConsoleRelayObservability(now);
    const runtimePersistWorldEvent =
      dependencies.persistWorldEvent ??
      createRuntimePersistWorldEvent(this.env.HISTORY_DB, (actionId) => this.actionEmojiIndex.get(actionId), observability);
    this.dependencies = {
      fetchImpl: dependencies.fetchImpl ?? defaultFetchImpl,
      now,
      random,
      observability,
      publishSnapshot: dependencies.publishSnapshot ?? createRuntimeSnapshotPublisher(this.env.SNAPSHOT_BUCKET),
      ...(runtimePersistWorldEvent ? { persistWorldEvent: runtimePersistWorldEvent } : {}),
    };
    this.bootPromise = this.createBootPromise();
  }

  async fetch(_request: Request): Promise<Response> {
    await this.ensureBooted();
    return new Response(null, { status: 204 });
  }

  async alarm(): Promise<void> {
    await this.ensureBooted();
    const now = this.dependencies.now();

    if (
      this.bridgeState.websocket === undefined &&
      this.bridgeState.websocket_reconnect_alarm_at !== undefined &&
      this.bridgeState.websocket_reconnect_alarm_at <= now
    ) {
      this.bridgeState.websocket_reconnect_alarm_at = undefined;

      try {
        await this.connectWebSocket(true);
      } catch {}
    }

    if (this.bridgeState.refresh_alarm_at !== undefined && this.bridgeState.refresh_alarm_at <= now) {
      this.bridgeState.refresh_alarm_at = undefined;
      await this.refreshSnapshot('fixed-cadence');
    }

    if (this.bridgeState.publish_alarm_at !== undefined && this.bridgeState.publish_alarm_at <= this.dependencies.now()) {
      this.bridgeState.publish_alarm_at = undefined;
      await this.publishLatestSnapshot();
    }

    await this.rescheduleAlarm();
  }

  async whenBooted(): Promise<void> {
    await this.ensureBooted();
  }

  getDebugState(): BridgeState {
    return {
      ...this.bridgeState,
      recent_server_events: this.bridgeState.recent_server_events.map((event) => ({ ...event })),
      conversations: Object.fromEntries(
        Object.entries(this.bridgeState.conversations).map(([conversationId, conversation]) => [
          conversationId,
          {
            ...conversation,
            participant_agent_ids: [...conversation.participant_agent_ids],
          },
        ]),
      ),
      ...(this.bridgeState.latest_snapshot
        ? {
            latest_snapshot: {
              ...this.bridgeState.latest_snapshot,
              recent_server_events: this.bridgeState.latest_snapshot.recent_server_events.map((event) => ({ ...event })),
            },
          }
        : {}),
    };
  }

  private async restorePersistedReconnectState(): Promise<void> {
    const persistedState = await this.state.storage.get?.<PersistedReconnectState>(PERSISTED_RECONNECT_STATE_KEY);

    if (!persistedState) {
      return;
    }

    this.bridgeState.reconnect_attempt = persistedState.reconnect_attempt;
    this.bridgeState.disconnect_started_at = persistedState.disconnect_started_at;
    this.bridgeState.websocket_reconnect_alarm_at = persistedState.websocket_reconnect_alarm_at;
  }

  private async restorePersistedOutageRuntimeState(): Promise<void> {
    const persistedState = await this.state.storage.get?.<PersistedOutageRuntimeState>(PERSISTED_OUTAGE_RUNTIME_STATE_KEY);

    if (!persistedState) {
      return;
    }

    this.bridgeState.latest_snapshot = {
      ...persistedState.latest_snapshot,
      recent_server_events: persistedState.latest_snapshot.recent_server_events.map((event) => ({ ...event })),
    };
    this.bridgeState.recent_server_events = this.bridgeState.latest_snapshot.recent_server_events.map((event) => ({ ...event }));
    this.bridgeState.active_server_event_ids = this.bridgeState.latest_snapshot.server_events.map(
      (event) => event.server_event_id,
    );
    this.bridgeState.last_publish_at = persistedState.last_publish_at;
    this.bridgeState.last_refresh_at = persistedState.last_refresh_at;
    this.bridgeState.refresh_alarm_at = persistedState.refresh_alarm_at;
    this.bridgeState.publish_alarm_at = persistedState.publish_alarm_at;
    this.bridgeState.publish_failure_streak = persistedState.publish_failure_streak;
    this.bridgeState.heartbeat_failure_streak = persistedState.heartbeat_failure_streak;
  }

  private async persistReconnectState(): Promise<void> {
    await this.state.storage.put?.(PERSISTED_RECONNECT_STATE_KEY, {
      reconnect_attempt: this.bridgeState.reconnect_attempt,
      ...(this.bridgeState.disconnect_started_at !== undefined
        ? { disconnect_started_at: this.bridgeState.disconnect_started_at }
        : {}),
      ...(this.bridgeState.websocket_reconnect_alarm_at !== undefined
        ? { websocket_reconnect_alarm_at: this.bridgeState.websocket_reconnect_alarm_at }
        : {}),
    } satisfies PersistedReconnectState);
  }

  private async clearPersistedReconnectState(): Promise<void> {
    await this.state.storage.delete?.(PERSISTED_RECONNECT_STATE_KEY);
  }

  private async persistOutageRuntimeState(): Promise<void> {
    if (this.bridgeState.disconnect_started_at === undefined || !this.bridgeState.latest_snapshot) {
      return;
    }

    await this.state.storage.put?.(PERSISTED_OUTAGE_RUNTIME_STATE_KEY, {
      latest_snapshot: {
        ...this.bridgeState.latest_snapshot,
        recent_server_events: this.bridgeState.latest_snapshot.recent_server_events.map((event) => ({ ...event })),
      },
      publish_failure_streak: this.bridgeState.publish_failure_streak,
      heartbeat_failure_streak: this.bridgeState.heartbeat_failure_streak,
      ...(this.bridgeState.last_publish_at !== undefined ? { last_publish_at: this.bridgeState.last_publish_at } : {}),
      ...(this.bridgeState.last_refresh_at !== undefined ? { last_refresh_at: this.bridgeState.last_refresh_at } : {}),
      ...(this.bridgeState.refresh_alarm_at !== undefined ? { refresh_alarm_at: this.bridgeState.refresh_alarm_at } : {}),
      ...(this.bridgeState.publish_alarm_at !== undefined ? { publish_alarm_at: this.bridgeState.publish_alarm_at } : {}),
    } satisfies PersistedOutageRuntimeState);
  }

  private async clearPersistedOutageRuntimeState(): Promise<void> {
    await this.state.storage.delete?.(PERSISTED_OUTAGE_RUNTIME_STATE_KEY);
  }

  private async boot(): Promise<void> {
    await this.restorePersistedReconnectState();
    await this.restorePersistedOutageRuntimeState();

    if (!this.bridgeState.latest_snapshot) {
      this.bridgeState.recent_server_events = await restoreRecentServerEvents(this.env.HISTORY_DB);
      await this.refreshSnapshot('boot');
    }

    if (this.bridgeState.websocket_reconnect_alarm_at === undefined) {
      try {
        await this.connectWebSocket();
      } catch (error) {
        await this.transitionToReconnectState();
      }
    } else if (this.bridgeState.websocket_reconnect_alarm_at <= this.dependencies.now()) {
      try {
        await this.connectWebSocket(true);
      } catch {}
    }

    await this.rescheduleAlarm();
  }

  private async transitionToReconnectState(): Promise<void> {
    this.bridgeState.reconnect_attempt = 0;
    this.bridgeState.disconnect_started_at ??= this.dependencies.now();
    await this.scheduleReconnectAttempt();
  }

  private createBootPromise(): Promise<void> {
    const wrappedBootPromise = this.state.blockConcurrencyWhile(async () => this.boot()).catch((error) => {
      if (this.bootPromise === wrappedBootPromise) {
        this.bootPromise = undefined;
      }

      throw error;
    });

    return wrappedBootPromise;
  }

  private ensureBooted(): Promise<void> {
    this.bootPromise ??= this.createBootPromise();
    return this.bootPromise;
  }

  private enqueueSerializedOperation<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.serializedOperations.push(async () => {
        try {
          resolve(await operation());
        } catch (error) {
          reject(error);
        }
      });

      void this.drainSerializedOperations();
    });
  }

  private async drainSerializedOperations(): Promise<void> {
    if (this.drainingSerializedOperations) {
      return;
    }

    this.drainingSerializedOperations = true;

    try {
      while (this.serializedOperations.length > 0) {
        const operation = this.serializedOperations.shift();

        if (operation) {
          await operation();
        }
      }
    } finally {
      this.drainingSerializedOperations = false;

      if (this.serializedOperations.length > 0) {
        void this.drainSerializedOperations();
      }
    }
  }

  private async connectWebSocket(retryOnFailure = false): Promise<void> {
    try {
      const websocket = await openBridgeWebSocket(this.config, this.dependencies.fetchImpl);
      this.bridgeState.websocket = websocket;
      this.bridgeState.reconnect_attempt = 0;
      this.bridgeState.websocket_reconnect_alarm_at = undefined;

      if (this.bridgeState.disconnect_started_at !== undefined) {
        const reconnectDuration = Math.max(0, this.dependencies.now() - this.bridgeState.disconnect_started_at);
        this.dependencies.observability.gauge('relay.ws.connect_duration_ms', reconnectDuration);
        this.dependencies.observability.gauge('relay.ws.event_gap_ms', reconnectDuration);
        this.dependencies.observability.log('warn', 'relay websocket reconnected after downtime', {
          reconnect_attempt: this.bridgeState.reconnect_attempt,
          connect_duration_ms: reconnectDuration,
          event_gap_ms: reconnectDuration,
        });
        this.bridgeState.disconnect_started_at = undefined;
      }

      await this.clearPersistedReconnectState();
      await this.clearPersistedOutageRuntimeState();

      websocket.addEventListener('message', (event) => {
        this.handleSocketMessage(event.data);
      });
      websocket.addEventListener('close', (event) => {
        this.handleSocketDisconnect(classifySocketCloseReason(event), 'server_close', websocket);
      });
      websocket.addEventListener('error', () => {
        this.handleSocketDisconnect('error', 'network', websocket);
      });
      await this.rescheduleAlarm();
    } catch (error) {
      const handshakeStatus = error instanceof WebSocketUpgradeError ? error.handshakeStatus : classifyTransportError(error);
      this.bridgeState.reconnect_attempt += 1;
      this.bridgeState.disconnect_started_at ??= this.dependencies.now();
      if (retryOnFailure) {
        await this.scheduleReconnectAttempt();
      }
      const disconnectDurationMs = Math.max(0, this.dependencies.now() - this.bridgeState.disconnect_started_at);
      this.dependencies.observability.counter('relay.ws.disconnect_total', {
        reason: 'error',
        handshake_status: handshakeStatus,
      });
      this.dependencies.observability.log(handshakeStatus === 'auth_rejected' ? 'error' : 'warn', 'relay websocket connect failed', {
        handshake_status: handshakeStatus,
        reconnect_attempt: this.bridgeState.reconnect_attempt,
        disconnect_duration_ms: disconnectDurationMs,
        error: describeError(error),
      });
      throw error;
    }
  }

  private async scheduleReconnectAttempt(): Promise<void> {
    const reconnectBackoffMs = Math.min(
      calculateJitteredBackoff(
        calculateBackoff(1_000, Math.max(this.bridgeState.reconnect_attempt + 1, 1), WEBSOCKET_RECONNECT_BACKOFF_MAX_MS),
        this.dependencies.random,
      ),
      WEBSOCKET_RECONNECT_BACKOFF_MAX_MS,
    );
    this.bridgeState.websocket_reconnect_alarm_at = this.dependencies.now() + reconnectBackoffMs;
    await this.persistReconnectState();
    await this.persistOutageRuntimeState();
    await this.rescheduleAlarm();
  }

  private handleSocketMessage(data: unknown): void {
    const payload = parseSocketPayload(data, {
      onUnknownEventType: (eventType) => {
        this.dependencies.observability.counter('relay.event.unknown_total', { event_type: eventType });
        this.dependencies.observability.log('warn', 'relay dropped unknown websocket event type', {
          event_type: eventType,
        });
      },
    });

    if (!payload) {
      return;
    }

    void this.enqueueSerializedOperation(async () => {
      if (payload.type === 'snapshot') {
        await this.applySnapshot(payload.data);
        return;
      }

      await this.handleWorldEvent(payload.data);
    }).catch(() => {});
  }

  private async handleWorldEvent(worldEvent: WorldEvent): Promise<void> {
    const stagedConversationUpdate = isConversationWorldEvent(worldEvent)
      ? stageConversationMirrorUpdate(this.bridgeState.conversations, worldEvent)
      : undefined;
    let shouldApplyEventMutation = true;

    if (this.dependencies.persistWorldEvent) {
      try {
        await this.dependencies.persistWorldEvent(worldEvent, stagedConversationUpdate);
      } catch {
        shouldApplyEventMutation = false;
      }
    }

    if (shouldApplyEventMutation && stagedConversationUpdate) {
      this.bridgeState.conversations = stagedConversationUpdate.next_conversations;
    }

    if (shouldApplyEventMutation) {
      this.bridgeState.last_event_at = worldEvent.occurred_at;
    }

    if (shouldApplyEventMutation && worldEvent.type === 'server_event_fired') {
      this.bridgeState.recent_server_events = mergeRecentServerEvent(this.bridgeState.recent_server_events, worldEvent);
    }

    void this.refreshSnapshot('world-event');
  }

  private async applySnapshot(worldSnapshot: WorldSnapshot): Promise<boolean> {
    const latestGeneratedAt = this.bridgeState.latest_snapshot?.generated_at;

    if (latestGeneratedAt !== undefined && worldSnapshot.generated_at < latestGeneratedAt) {
      return false;
    }

    const now = this.dependencies.now();
    const activeServerEventIds = worldSnapshot.server_events.map((event) => event.server_event_id);
    const activeServerEventIdSet = new Set(activeServerEventIds);

    this.actionEmojiIndex = buildActionEmojiIndex(worldSnapshot);
    this.bridgeState.conversations = rebuildConversationMirror(worldSnapshot, now);
    this.bridgeState.recent_server_events = mergeRecentServerEventsFromSnapshot(
      this.bridgeState.recent_server_events,
      this.bridgeState.active_server_event_ids,
      worldSnapshot.server_events,
      worldSnapshot.generated_at,
    ).map((event) => ({
      ...event,
      is_active: activeServerEventIdSet.has(event.server_event_id),
    }));
    this.bridgeState.active_server_event_ids = activeServerEventIds;
    this.bridgeState.latest_snapshot = buildSpectatorSnapshot({
      world_snapshot: worldSnapshot,
      recent_server_events: this.bridgeState.recent_server_events,
      published_at: this.bridgeState.last_publish_at ?? 0,
    });
    this.bridgeState.last_refresh_at = now;
    this.bridgeState.heartbeat_failure_streak = 0;
    await this.persistOutageRuntimeState();
    return true;
  }

  private async refreshSnapshot(reason: SnapshotRefreshReason): Promise<void> {
    if (this.bridgeState.refresh_in_flight) {
      this.bridgeState.refresh_queued = true;
      this.bridgeState.refresh_queued_reason = mergeQueuedRefreshReason(
        this.bridgeState.refresh_queued_reason,
        reason,
      );
      return;
    }

    this.bridgeState.refresh_in_flight = true;
    let refreshSucceeded = false;

    try {
      const worldSnapshot = await fetchWorldSnapshot(this.config, this.dependencies.fetchImpl);
      await this.enqueueSerializedOperation(async () => {
        await this.applySnapshot(worldSnapshot);
      });
      await this.scheduleFixedCadence();
      this.emitSnapshotFreshnessMetricsSafely();
      await this.publishLatestSnapshot();
      refreshSucceeded = true;
    } catch (error) {
      await this.scheduleFixedCadence();
      this.runObservabilitySafely(() => {
        this.dependencies.observability.counter('ui.snapshot.refresh_failure_total', { reason });
      });
      this.emitSnapshotFreshnessMetricsSafely();
      this.runObservabilitySafely(() => {
        this.dependencies.observability.log('error', 'relay snapshot refresh failed', {
          reason,
          error: describeError(error),
        });
      });
    } finally {
      this.bridgeState.refresh_in_flight = false;

      if (this.bridgeState.refresh_queued) {
        const queuedReason = this.bridgeState.refresh_queued_reason ?? 'world-event';
        this.bridgeState.refresh_queued = false;
        this.bridgeState.refresh_queued_reason = undefined;

        if (!(refreshSucceeded && queuedReason === 'fixed-cadence')) {
          await this.refreshSnapshot(queuedReason);
        }
      }
    }
  }

  private async scheduleFixedCadence(): Promise<void> {
    this.bridgeState.refresh_alarm_at = this.dependencies.now() + this.config.snapshotPublishIntervalMs;
    await this.rescheduleAlarm();
  }

  private isPublishBackoffActive(now = this.dependencies.now()): boolean {
    return this.bridgeState.publish_alarm_at !== undefined && this.bridgeState.publish_alarm_at > now;
  }

  private runObservabilitySafely(callback: () => void): void {
    try {
      callback();
    } catch {}
  }

  private emitSnapshotFreshnessMetricsSafely(snapshot = this.bridgeState.latest_snapshot): void {
    this.runObservabilitySafely(() => {
      this.emitSnapshotFreshnessMetrics(snapshot);
    });
  }

  private async publishLatestSnapshot(): Promise<void> {
    if (this.bridgeState.publish_in_flight) {
      this.bridgeState.publish_queued = true;
      return;
    }

    const latestSnapshot = this.bridgeState.latest_snapshot;

    if (!latestSnapshot) {
      this.bridgeState.publish_alarm_at = undefined;
      return;
    }

    if (this.isPublishBackoffActive()) {
      await this.persistOutageRuntimeState();
      await this.rescheduleAlarm();
      return;
    }

    this.bridgeState.publish_in_flight = true;

    const publishedAt = this.dependencies.now();
    const snapshotToPublish = {
      ...latestSnapshot,
      recent_server_events: latestSnapshot.recent_server_events.map((event) => ({ ...event })),
      published_at: publishedAt,
    } satisfies SpectatorSnapshot;

    try {
      await this.dependencies.publishSnapshot?.({
        key: this.config.snapshotObjectKey,
        body: encodeSpectatorSnapshot(snapshotToPublish),
        options: {
          httpMetadata: {
            contentType: SNAPSHOT_CONTENT_TYPE,
            cacheControl: `public, max-age=${this.config.snapshotCacheMaxAgeSec}`,
          },
          customMetadata: {
            'schema-version': '1',
          },
        },
      });
      this.bridgeState.latest_snapshot = snapshotToPublish;
      this.bridgeState.last_publish_at = publishedAt;
      this.bridgeState.publish_alarm_at = undefined;
      this.bridgeState.publish_failure_streak = 0;
      this.runObservabilitySafely(() => {
        this.dependencies.observability.gauge('ui.r2.publish_failure_streak', 0);
      });
      this.emitSnapshotFreshnessMetricsSafely(snapshotToPublish);
    } catch (error) {
      this.bridgeState.publish_failure_streak += 1;
      this.bridgeState.publish_alarm_at =
        publishedAt +
        calculateBackoff(
          this.config.snapshotPublishIntervalMs,
          this.bridgeState.publish_failure_streak,
          PUBLISH_BACKOFF_MAX_MS,
        );
      this.runObservabilitySafely(() => {
        this.dependencies.observability.counter('ui.r2.publish_failure_total');
      });
      this.runObservabilitySafely(() => {
        this.dependencies.observability.gauge('ui.r2.publish_failure_streak', this.bridgeState.publish_failure_streak);
      });
      this.emitSnapshotFreshnessMetricsSafely();
      this.runObservabilitySafely(() => {
        this.dependencies.observability.log('error', 'relay snapshot publish failed', {
          publish_failure_streak: this.bridgeState.publish_failure_streak,
          publish_alarm_at: this.bridgeState.publish_alarm_at,
          error: describeError(error),
        });
      });
    } finally {
      this.bridgeState.publish_in_flight = false;

      const shouldDrainQueuedPublish = this.bridgeState.publish_queued;
      this.bridgeState.publish_queued = false;

      if (shouldDrainQueuedPublish) {
        await this.publishLatestSnapshot();
        return;
      }

      await this.persistOutageRuntimeState();
      await this.rescheduleAlarm();
    }
  }

  private emitSnapshotFreshnessMetrics(snapshot = this.bridgeState.latest_snapshot): void {
    if (!snapshot) {
      return;
    }

    const now = this.dependencies.now();
    this.dependencies.observability.gauge('ui.snapshot.generated_age_ms', Math.max(0, now - snapshot.generated_at));
    this.dependencies.observability.gauge(
      'ui.snapshot.published_age_ms',
      snapshot.published_at > 0 ? Math.max(0, now - snapshot.published_at) : 0,
    );
  }

  private handleSocketDisconnect(reason: DisconnectReason, handshakeStatus: HandshakeStatus, websocket: RelayWebSocket): void {
    if (this.bridgeState.websocket !== websocket) {
      return;
    }

    this.bridgeState.websocket = undefined;
    this.bridgeState.disconnect_started_at ??= this.dependencies.now();
    const disconnectDurationMs = Math.max(0, this.dependencies.now() - this.bridgeState.disconnect_started_at);
    this.dependencies.observability.counter('relay.ws.disconnect_total', {
      reason,
      handshake_status: handshakeStatus,
    });
    this.dependencies.observability.log('warn', 'relay websocket disconnected', {
      reason,
      handshake_status: handshakeStatus,
      reconnect_attempt: this.bridgeState.reconnect_attempt,
      disconnect_duration_ms: disconnectDurationMs,
      disconnect_started_at: this.bridgeState.disconnect_started_at,
      last_event_at: this.bridgeState.last_event_at,
    });
    void this.enqueueSerializedOperation(async () => {
      await this.transitionToReconnectState();
    }).catch(() => {});
  }

  private async rescheduleAlarm(): Promise<void> {
    const nextAlarmAt = [
      this.bridgeState.refresh_alarm_at,
      this.bridgeState.publish_alarm_at,
      this.bridgeState.websocket_reconnect_alarm_at,
    ].reduce<number | undefined>((earliest, candidate) => {
      if (candidate === undefined) {
        return earliest;
      }

      return earliest === undefined ? candidate : Math.min(earliest, candidate);
    }, undefined);

    if (nextAlarmAt === undefined) {
      return;
    }

    const currentAlarmAt = (await this.state.storage.getAlarm?.()) ?? undefined;

    if (currentAlarmAt === nextAlarmAt) {
      return;
    }

    await this.state.storage.setAlarm?.(nextAlarmAt);
  }
}
