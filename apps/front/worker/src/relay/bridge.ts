import { z } from 'zod';

import type { EventType as BackendEventType } from '../../../../server/src/types/event.js';
import {
  agentHistoryDocumentSchema,
  coerceAgentHistoryDocument,
  coerceConversationHistoryDocument,
  conversationHistoryDocumentSchema,
  historyAgentObjectKey,
  historyConversationObjectKey,
  historyEntrySchema,
  type AgentHistoryDocument,
  type ConversationHistoryDocument,
  type HistoryEntry,
} from '../contracts/history-document.js';
import type { PersistedSpectatorEventType } from '../contracts/persisted-spectator-event.js';
import { encodeSpectatorSnapshot } from '../contracts/snapshot-serializer.js';
import { buildSpectatorSnapshot, type SpectatorRecentServerEvent, type SpectatorSnapshot } from '../contracts/spectator-snapshot.js';
import type { ConversationClosureReason, EventType, WorldEvent } from '../contracts/world-event.js';
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
  latest_snapshot?: SpectatorSnapshot;
  conversations: Record<string, BridgeConversationState>;
  last_publish_at?: number;
  publish_alarm_at?: number;
  publish_attempt?: number;
  last_publish_error_at?: number;
  last_publish_error_code?: string;
  publish_in_flight: boolean;
  publish_queued: boolean;
  publish_failure_streak: number;
}

export interface RelayFetchResponse {
  status: number;
  json?(): Promise<unknown>;
}

export type RelayFetch = (input: string | URL | Request, init?: RequestInit) => Promise<RelayFetchResponse>;

export interface BridgeDependencies {
  fetchImpl: RelayFetch;
  now: () => number;
  random: () => number;
  observability: RelayObservability;
  publishSnapshot: (input: SnapshotPublishInput) => Promise<void>;
}

export const SNAPSHOT_REFRESH_REASONS = [
  'boot',
  'fallback-refresh',
  'world-event',
  'manual',
  'external-request',
] as const;

type ConversationWorldEvent = Extract<WorldEvent, { conversation_id: string }>;

export interface StagedConversationMirrorUpdate {
  conversation_id: string;
  next_conversations: Record<string, BridgeConversationState>;
  resolved_conversation?: BridgeConversationState;
  resolved_agent_ids: string[];
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

export interface R2ObjectBodyLike {
  text(): Promise<string>;
}

export interface R2PutOptions {
  httpMetadata?: {
    contentType?: string;
    cacheControl?: string;
  };
  customMetadata?: Record<string, string>;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: string, options?: R2PutOptions): Promise<unknown>;
}

export interface RelayBindings extends Record<string, unknown> {
  SNAPSHOT_PUBLISH_AUTH_KEY?: string;
  AUTH_MODE?: 'public' | 'access';
  SNAPSHOT_BUCKET?: R2BucketLike;
  UI_BRIDGE?: DurableObjectNamespaceLike;
}
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SnapshotPublishInput {
  key: string;
  body: string;
  options: R2PutOptions;
}

const publishAgentHistoryRequestSchema = z.object({
  agent_id: z.string().min(1),
  events: z.array(historyEntrySchema),
});

const PUBLISH_BACKOFF_MAX_MS = 60_000;
const PUBLISH_RETRY_BASE_MS = 5_000;
const SNAPSHOT_CONTENT_TYPE = 'application/json; charset=utf-8';
const PERSISTED_RUNTIME_STATE_KEY = 'relay:runtime-state';

const worldCalendarSnapshotSchema = z.object({
  timezone: z.string(),
  local_date: z.string(),
  local_time: z.string(),
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

const agentStateSchema = z.enum(['idle', 'moving', 'in_action', 'in_conversation', 'in_transfer']);

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
      state: agentStateSchema,
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
  known_agents: z.array(
    z.object({
      agent_id: z.string(),
      agent_name: z.string(),
      discord_bot_avatar_url: z.string().optional(),
    }),
  ),
  conversations: z.array(
    z.object({
      conversation_id: z.string(),
      status: z.enum(['pending', 'active', 'closing']),
      participant_agent_ids: z.array(z.string()),
      current_speaker_agent_id: z.string(),
      initiator_agent_id: z.string().optional(),
      closing_reason: z.string().optional(),
    }),
  ),
  recent_server_events: z.array(
    z.object({
      server_event_id: z.string(),
      description: z.string(),
      occurred_at: z.number().int().nonnegative(),
      is_active: z.boolean(),
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
const transferEventFields = {
  transfer_id: z.string(),
  from_agent_id: z.string(),
  from_agent_name: z.string(),
  to_agent_id: z.string(),
  to_agent_name: z.string(),
  item: agentItemSchema.nullable(),
  money: z.number(),
  mode: z.enum(['standalone', 'in_conversation']),
  conversation_id: z.string().optional(),
};
const transferRejectReasonSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rejected_by_receiver') }),
  z.object({ kind: z.literal('unanswered_speak') }),
  z.object({ kind: z.literal('inventory_full'), dropped_item: agentItemSchema.nullable() }),
]);

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
    cancelled_state: agentStateSchema,
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
    type: z.literal('transfer_requested'),
    ...transferEventFields,
    expires_at: z.number().int().nonnegative(),
  }),
  eventBaseSchema.extend({
    type: z.literal('transfer_accepted'),
    ...transferEventFields,
    item_granted: agentItemSchema.nullable(),
    item_dropped: agentItemSchema.nullable(),
    money_received: z.number(),
    from_money_balance: z.number().optional(),
    to_money_balance: z.number(),
  }),
  eventBaseSchema.extend({
    type: z.literal('transfer_rejected'),
    ...transferEventFields,
    reason: transferRejectReasonSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('transfer_timeout'),
    ...transferEventFields,
    refund_failed: z.boolean().optional(),
  }),
  eventBaseSchema.extend({
    type: z.literal('transfer_cancelled'),
    ...transferEventFields,
    reason: z.enum([
      'server_event',
      'sender_logged_out',
      'receiver_logged_out',
      'conversation_closing',
      'participant_inactive',
      'error',
    ]),
  }),
  eventBaseSchema.extend({
    type: z.literal('transfer_escrow_lost'),
    ...transferEventFields,
    reason: z.enum(['registration_writeback_failed', 'inventory_overflow_on_refund']),
    dropped_item: agentItemSchema.nullable().optional(),
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

export const KNOWN_WORLD_EVENT_TYPES = [
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
  'transfer_requested',
  'transfer_accepted',
  'transfer_rejected',
  'transfer_timeout',
  'transfer_cancelled',
  'transfer_escrow_lost',
  'server_event_fired',
] as const satisfies readonly PersistedSpectatorEventType[];

export const NON_PERSISTED_WORLD_EVENT_TYPES = [
  'idle_reminder_fired',
  'map_info_requested',
  'world_agents_info_requested',
  'status_info_requested',
  'nearby_agents_info_requested',
  'active_conversations_info_requested',
  'perception_requested',
  'available_actions_requested',
] as const satisfies readonly Exclude<EventType, PersistedSpectatorEventType>[];

type KnownWorldEventType = (typeof KNOWN_WORLD_EVENT_TYPES)[number];
type NonPersistedWorldEventType = (typeof NON_PERSISTED_WORLD_EVENT_TYPES)[number];

type _KnownWorldEventTypeParity = [
  Exclude<KnownWorldEventType, PersistedSpectatorEventType>,
  Exclude<PersistedSpectatorEventType, KnownWorldEventType>,
] extends [never, never]
  ? true
  : never;
type _WorkerBackendEventTypeParity = [Exclude<EventType, BackendEventType>, Exclude<BackendEventType, EventType>] extends [
  never,
  never,
]
  ? true
  : never;
type _WorldEventCoverage = Exclude<BackendEventType, KnownWorldEventType | NonPersistedWorldEventType> extends never
  ? true
  : never;
type _WorldEventNoUnexpectedKnown = Exclude<KnownWorldEventType, BackendEventType> extends never ? true : never;
type _WorldEventNoUnexpectedNonPersisted = Exclude<NonPersistedWorldEventType, BackendEventType> extends never
  ? true
  : never;

const _knownWorldEventTypeParity: _KnownWorldEventTypeParity = true;
const _workerBackendEventTypeParity: _WorkerBackendEventTypeParity = true;
const _worldEventCoverage: _WorldEventCoverage = true;
const _worldEventNoUnexpectedKnown: _WorldEventNoUnexpectedKnown = true;
const _worldEventNoUnexpectedNonPersisted: _WorldEventNoUnexpectedNonPersisted = true;

function defaultFetchImpl(input: string | URL | Request, init?: RequestInit): Promise<RelayFetchResponse> {
  return fetch(input, init) as Promise<RelayFetchResponse>;
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

function calculateBackoff(baseIntervalMs: number, streak: number, maxIntervalMs: number): number {
  return Math.min(baseIntervalMs * 2 ** Math.max(streak - 1, 0), maxIntervalMs);
}

interface PersistedRuntimeState {
  latest_snapshot: SpectatorSnapshot;
  last_publish_at?: number;
  publish_alarm_at?: number;
  publish_attempt?: number;
  last_publish_error_at?: number;
  last_publish_error_code?: string;
  publish_failure_streak: number;
}

function createRuntimeSnapshotPublisher(snapshotBucket?: R2BucketLike): (input: SnapshotPublishInput) => Promise<void> {
  return async ({ key, body, options }) => {
    if (!snapshotBucket) {
      throw new Error('SNAPSHOT_BUCKET is required for snapshot publishing');
    }

    await snapshotBucket.put(key, body, options);
  };
}

export function createBridgeState(): BridgeState {
  return {
    conversations: {},
    publish_in_flight: false,
    publish_queued: false,
    publish_failure_streak: 0,
  };
}

function mergeHistoryEntryList(
  existingEntries: HistoryEntry[],
  nextEntries: HistoryEntry[],
  limit: number,
): HistoryEntry[] {
  const byId = new Map(existingEntries.map((entry) => [entry.event_id, entry]));

  for (const entry of nextEntries) {
    byId.set(entry.event_id, entry);
  }

  return [...byId.values()]
    .sort((left, right) => right.occurred_at - left.occurred_at || right.event_id.localeCompare(left.event_id))
    .slice(0, limit);
}

function isActionEventType(type: string): boolean {
  return type === 'action_started' || type === 'action_completed' || type === 'action_rejected';
}

function isConversationEventType(type: string): boolean {
  return type.startsWith('conversation_');
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

export class UIBridgeDurableObject {
  private readonly config: RelayConfig;
  private readonly bridgeState = createBridgeState();
  private readonly dependencies: BridgeDependencies;
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
    this.dependencies = {
      fetchImpl: dependencies.fetchImpl ?? defaultFetchImpl,
      now,
      random,
      observability,
      publishSnapshot: dependencies.publishSnapshot ?? createRuntimeSnapshotPublisher(this.env.SNAPSHOT_BUCKET),
    };
    this.bootPromise = this.createBootPromise();
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureBooted();
    const url = new URL(request.url);

    if (url.pathname === '/api/publish-snapshot' && request.method === 'POST') {
      let payload: unknown;
      try {
        payload = await request.json();
      } catch (error) {
        this.runObservabilitySafely(() => {
          this.dependencies.observability.log('warn', 'relay publish-snapshot body parse failed', {
            error: describeError(error),
          });
        });
        return new Response(JSON.stringify({ error: 'invalid_json' }), {
          status: 400,
          headers: { 'content-type': SNAPSHOT_CONTENT_TYPE },
        });
      }

      const parseResult = worldSnapshotSchema.safeParse(payload);
      if (!parseResult.success) {
        this.runObservabilitySafely(() => {
          this.dependencies.observability.log('warn', 'relay publish-snapshot schema mismatch', {
            issues: parseResult.error.issues,
          });
        });
        return new Response(JSON.stringify({ error: 'invalid_snapshot' }), {
          status: 400,
          headers: { 'content-type': SNAPSHOT_CONTENT_TYPE },
        });
      }

      const worldSnapshot = parseResult.data as WorldSnapshot;

      try {
        await this.enqueueSerializedOperation(async () => {
          await this.applySnapshot(worldSnapshot);
        });
        this.emitSnapshotFreshnessMetricsSafely();
        await this.publishLatestSnapshot({ failClosed: true });
        return new Response(null, { status: 204 });
      } catch (error) {
        this.runObservabilitySafely(() => {
          this.dependencies.observability.log('error', 'relay publish-snapshot failed', {
            error: describeError(error),
          });
        });
        return new Response(JSON.stringify({ error: 'publish_failed' }), {
          status: 502,
          headers: { 'content-type': SNAPSHOT_CONTENT_TYPE },
        });
      }
    }

    if (url.pathname === '/api/publish-agent-history' && request.method === 'POST') {
      let payload: unknown;
      try {
        payload = await request.json();
      } catch (error) {
        this.runObservabilitySafely(() => {
          this.dependencies.observability.log('warn', 'relay publish-agent-history body parse failed', {
            error: describeError(error),
          });
        });
        return new Response(JSON.stringify({ error: 'invalid_json' }), {
          status: 400,
          headers: { 'content-type': SNAPSHOT_CONTENT_TYPE },
        });
      }

      const parseResult = publishAgentHistoryRequestSchema.safeParse(payload);
      if (!parseResult.success) {
        this.runObservabilitySafely(() => {
          this.dependencies.observability.log('warn', 'relay publish-agent-history schema mismatch', {
            issues: parseResult.error.issues,
          });
        });
        return new Response(JSON.stringify({ error: 'invalid_agent_history' }), {
          status: 400,
          headers: { 'content-type': SNAPSHOT_CONTENT_TYPE },
        });
      }

      try {
        await this.appendAgentHistory(parseResult.data.agent_id, parseResult.data.events);
        return new Response(null, { status: 204 });
      } catch (error) {
        this.runObservabilitySafely(() => {
          this.dependencies.observability.log('error', 'relay publish-agent-history failed', {
            error: describeError(error),
          });
        });
        return new Response(JSON.stringify({ error: 'publish_failed' }), {
          status: 502,
          headers: { 'content-type': SNAPSHOT_CONTENT_TYPE },
        });
      }
    }

    return new Response(null, { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.ensureBooted();

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

  private async restorePersistedRuntimeState(): Promise<void> {
    const persistedState = await this.state.storage.get?.<Partial<PersistedRuntimeState>>(PERSISTED_RUNTIME_STATE_KEY);

    if (!persistedState?.latest_snapshot) {
      return;
    }

    this.bridgeState.latest_snapshot = {
      ...persistedState.latest_snapshot,
      recent_server_events: (persistedState.latest_snapshot.recent_server_events ?? []).map((event) => ({ ...event })),
    };
    this.bridgeState.last_publish_at = persistedState.last_publish_at;
    this.bridgeState.publish_alarm_at = persistedState.publish_alarm_at;
    this.bridgeState.publish_attempt = persistedState.publish_attempt;
    this.bridgeState.last_publish_error_at = persistedState.last_publish_error_at;
    this.bridgeState.last_publish_error_code = persistedState.last_publish_error_code;
    this.bridgeState.publish_failure_streak = persistedState.publish_failure_streak ?? 0;
  }

  private async persistRuntimeState(): Promise<void> {
    if (!this.bridgeState.latest_snapshot) {
      return;
    }

    await this.state.storage.put?.(PERSISTED_RUNTIME_STATE_KEY, {
      latest_snapshot: {
        ...this.bridgeState.latest_snapshot,
        recent_server_events: this.bridgeState.latest_snapshot.recent_server_events.map((event) => ({ ...event })),
      },
      publish_failure_streak: this.bridgeState.publish_failure_streak,
      ...(this.bridgeState.last_publish_at !== undefined ? { last_publish_at: this.bridgeState.last_publish_at } : {}),
      ...(this.bridgeState.publish_alarm_at !== undefined ? { publish_alarm_at: this.bridgeState.publish_alarm_at } : {}),
      ...(this.bridgeState.publish_attempt !== undefined ? { publish_attempt: this.bridgeState.publish_attempt } : {}),
      ...(this.bridgeState.last_publish_error_at !== undefined
        ? { last_publish_error_at: this.bridgeState.last_publish_error_at }
        : {}),
      ...(this.bridgeState.last_publish_error_code !== undefined
        ? { last_publish_error_code: this.bridgeState.last_publish_error_code }
        : {}),
    } satisfies PersistedRuntimeState);
  }

  private async boot(): Promise<void> {
    await this.restorePersistedRuntimeState();
    await this.rescheduleAlarm();
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

  private async applySnapshot(worldSnapshot: WorldSnapshot): Promise<boolean> {
    const latestGeneratedAt = this.bridgeState.latest_snapshot?.generated_at;

    if (latestGeneratedAt !== undefined && worldSnapshot.generated_at < latestGeneratedAt) {
      return false;
    }

    const now = this.dependencies.now();

    this.bridgeState.conversations = rebuildConversationMirror(worldSnapshot, now);
    const recentServerEvents: SpectatorRecentServerEvent[] = worldSnapshot.recent_server_events.map((event) => ({
      server_event_id: event.server_event_id,
      description: event.description,
      occurred_at: event.occurred_at,
      is_active: event.is_active,
    }));
    this.bridgeState.latest_snapshot = buildSpectatorSnapshot({
      world_snapshot: worldSnapshot,
      recent_server_events: recentServerEvents,
      published_at: this.bridgeState.last_publish_at ?? 0,
      last_publish_error_at: this.bridgeState.last_publish_error_at,
    });
    await this.persistRuntimeState();
    return true;
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

  private async publishLatestSnapshot({ failClosed = false }: { failClosed?: boolean } = {}): Promise<void> {
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
      await this.persistRuntimeState();
      await this.rescheduleAlarm();
      if (failClosed) {
        throw new Error('snapshot publish backoff is active');
      }
      return;
    }

    this.bridgeState.publish_in_flight = true;

    const publishedAt = this.dependencies.now();
    const snapshotToPublish = {
      ...latestSnapshot,
      recent_server_events: latestSnapshot.recent_server_events.map((event) => ({ ...event })),
      published_at: publishedAt,
    } satisfies SpectatorSnapshot;

    let publishError: unknown;

    try {
      await this.dependencies.publishSnapshot({
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
      this.bridgeState.last_publish_error_at = undefined;
      this.bridgeState.last_publish_error_code = undefined;
      this.bridgeState.publish_alarm_at = undefined;
      this.bridgeState.publish_attempt = undefined;
      this.bridgeState.publish_failure_streak = 0;
      this.runObservabilitySafely(() => {
        this.dependencies.observability.gauge('ui.r2.publish_failure_streak', 0);
      });
      this.emitSnapshotFreshnessMetricsSafely(snapshotToPublish);
    } catch (error) {
      publishError = error;
      this.bridgeState.publish_failure_streak += 1;
      this.bridgeState.publish_attempt = this.bridgeState.publish_failure_streak;
      this.bridgeState.last_publish_error_at = publishedAt;
      this.bridgeState.last_publish_error_code = 'R2_PUBLISH_FAILED';
      this.bridgeState.publish_alarm_at =
        publishedAt +
        calculateBackoff(
          PUBLISH_RETRY_BASE_MS,
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
        await this.publishLatestSnapshot({ failClosed });
        return;
      }

      await this.persistRuntimeState();
      await this.rescheduleAlarm();
    }

    if (publishError !== undefined && failClosed) {
      throw publishError instanceof Error ? publishError : new Error(describeError(publishError));
    }
  }

  private async readAgentHistoryDocument(agentId: string): Promise<AgentHistoryDocument> {
    const object = await this.env.SNAPSHOT_BUCKET?.get(historyAgentObjectKey(agentId));
    if (!object) {
      return {
        agent_id: agentId,
        updated_at: 0,
        items: [],
        recent_actions: [],
        recent_conversations: [],
      };
    }

    const parsed = agentHistoryDocumentSchema.parse(JSON.parse(await object.text()));
    return coerceAgentHistoryDocument(parsed, agentId);
  }

  private async writeAgentHistoryDocument(document: AgentHistoryDocument): Promise<void> {
    if (!this.env.SNAPSHOT_BUCKET) {
      throw new Error('SNAPSHOT_BUCKET is required for agent history publishing');
    }

    await this.env.SNAPSHOT_BUCKET.put(
      historyAgentObjectKey(document.agent_id),
      JSON.stringify(document),
      {
        httpMetadata: {
          contentType: SNAPSHOT_CONTENT_TYPE,
          cacheControl: `public, max-age=${this.config.snapshotCacheMaxAgeSec}`,
        },
      },
    );
  }

  private async readConversationHistoryDocument(conversationId: string): Promise<ConversationHistoryDocument> {
    const object = await this.env.SNAPSHOT_BUCKET?.get(historyConversationObjectKey(conversationId));
    if (!object) {
      return {
        conversation_id: conversationId,
        updated_at: 0,
        items: [],
      };
    }

    const parsed = conversationHistoryDocumentSchema.parse(JSON.parse(await object.text()));
    return coerceConversationHistoryDocument(parsed, conversationId);
  }

  private async writeConversationHistoryDocument(document: ConversationHistoryDocument): Promise<void> {
    if (!this.env.SNAPSHOT_BUCKET) {
      throw new Error('SNAPSHOT_BUCKET is required for conversation history publishing');
    }

    await this.env.SNAPSHOT_BUCKET.put(
      historyConversationObjectKey(document.conversation_id),
      JSON.stringify(document),
      {
        httpMetadata: {
          contentType: SNAPSHOT_CONTENT_TYPE,
          cacheControl: `public, max-age=${this.config.snapshotCacheMaxAgeSec}`,
        },
      },
    );
  }

  private async appendAgentHistory(agentId: string, events: HistoryEntry[]): Promise<void> {
    await this.enqueueSerializedOperation(async () => {
      const current = await this.readAgentHistoryDocument(agentId);
      const generalEntries = events.filter((event) => !isActionEventType(event.type) && !isConversationEventType(event.type));
      const actionEntries = events.filter((event) => isActionEventType(event.type));
      const conversationEntries = events.filter((event) => isConversationEventType(event.type));
      const maxOccurredAt = events.length > 0 ? Math.max(...events.map((event) => event.occurred_at)) : current.updated_at;

      const updatedDocument: AgentHistoryDocument = {
        agent_id: agentId,
        updated_at: Math.max(current.updated_at, maxOccurredAt),
        items: mergeHistoryEntryList(current.items, generalEntries, 100),
        recent_actions: mergeHistoryEntryList(current.recent_actions, actionEntries, 100),
        recent_conversations: mergeHistoryEntryList(current.recent_conversations, conversationEntries, 100),
      };

      await this.writeAgentHistoryDocument(updatedDocument);

      const byConversationId = new Map<string, HistoryEntry[]>();
      for (const event of conversationEntries) {
        if (!event.conversation_id) {
          continue;
        }
        const entries = byConversationId.get(event.conversation_id) ?? [];
        entries.push(event);
        byConversationId.set(event.conversation_id, entries);
      }

      for (const [conversationId, conversationEvents] of byConversationId) {
        const conversationDocument = await this.readConversationHistoryDocument(conversationId);
        const maxConversationOccurredAt = Math.max(...conversationEvents.map((event) => event.occurred_at));
        await this.writeConversationHistoryDocument({
          conversation_id: conversationId,
          updated_at: Math.max(conversationDocument.updated_at, maxConversationOccurredAt),
          items: mergeHistoryEntryList(conversationDocument.items, conversationEvents, 100),
        });
      }
    });
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

  private async rescheduleAlarm(): Promise<void> {
    const nextAlarmAt = this.bridgeState.publish_alarm_at;

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
