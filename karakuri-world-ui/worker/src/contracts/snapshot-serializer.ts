import { z } from 'zod';

import { getSpectatorMapDimensionIssue, isNodeIdWithinGrid } from './map-grid-limits.js';
import type { SpectatorSnapshot } from './spectator-snapshot.js';

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

const spectatorNodeConfigSchema = z.object({
  type: z.enum(['normal', 'wall', 'door', 'building_interior', 'npc']),
  label: z.string().optional(),
  building_id: z.string().optional(),
  npc_id: z.string().optional(),
});

const spectatorMapSnapshotSchema = z.object({
  rows: z.number().int().positive(),
  cols: z.number().int().positive(),
  nodes: z.record(spectatorNodeConfigSchema),
  buildings: z.array(
    z.object({
      building_id: z.string(),
      name: z.string(),
      description: z.string(),
      wall_nodes: z.array(z.string()),
      interior_nodes: z.array(z.string()),
      door_nodes: z.array(z.string()),
    }),
  ),
  npcs: z.array(
    z.object({
      npc_id: z.string(),
      name: z.string(),
      description: z.string(),
      node_id: z.string(),
    }),
  ),
}).superRefine((map, ctx) => {
  const dimensionIssue = getSpectatorMapDimensionIssue(map.rows, map.cols);

  if (dimensionIssue) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: dimensionIssue.message,
      path: dimensionIssue.path,
    });
    return;
  }

  for (const nodeId of Object.keys(map.nodes)) {
    if (!isNodeIdWithinGrid(nodeId, map.rows, map.cols)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `map.nodes contains out-of-grid node ${nodeId}`,
        path: ['nodes', nodeId],
      });
    }
  }

  for (let row = 1; row <= map.rows; row += 1) {
    for (let col = 1; col <= map.cols; col += 1) {
      const nodeId = `${row}-${col}`;

      if (!(nodeId in map.nodes)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `map.nodes must include grid node ${nodeId}`,
          path: ['nodes', nodeId],
        });
      }
    }
  }
});

const spectatorRecentServerEventSchema = z.object({
  server_event_id: z.string(),
  description: z.string(),
  occurred_at: z.number().int().nonnegative(),
  is_active: z.boolean(),
});

const snapshotWeatherSchema = z.object({
  condition: z.string(),
  temperature_celsius: z.number(),
});

const spectatorAgentActivitySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('action'),
    label: z.string(),
    emoji: z.string(),
    duration_ms: z.number().int().positive(),
    completes_at: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('wait'),
    label: z.literal('待機'),
    emoji: z.literal('💤'),
    duration_ms: z.number().int().positive(),
    completes_at: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('item_use'),
    label: z.string(),
    emoji: z.literal('🧰'),
    completes_at: z.number().int().nonnegative(),
    duration_ms: z.number().int().positive().optional(),
  }),
]);

const spectatorAgentSnapshotSchema = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
  node_id: z.string(),
  state: z.enum(['idle', 'moving', 'in_action', 'in_conversation']),
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
  current_activity: spectatorAgentActivitySchema.optional(),
});

const spectatorConversationSnapshotSchema = z.object({
  conversation_id: z.string(),
  status: z.enum(['pending', 'active', 'closing']),
  participant_agent_ids: z.array(z.string()),
  current_speaker_agent_id: z.string(),
  current_turn: z.number().int().nonnegative(),
});

const spectatorServerEventSnapshotSchema = z.object({
  server_event_id: z.string(),
  description: z.string(),
  delivered_agent_ids: z.array(z.string()),
  pending_agent_ids: z.array(z.string()),
});

export const spectatorSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    world: z.object({
      name: z.string(),
      description: z.string(),
    }),
    timezone: z.string(),
    calendar: worldCalendarSnapshotSchema,
    map: spectatorMapSnapshotSchema,
    map_render_theme: mapRenderThemeSchema,
    weather: snapshotWeatherSchema.optional(),
    agents: z.array(spectatorAgentSnapshotSchema),
    conversations: z.array(spectatorConversationSnapshotSchema),
    server_events: z.array(spectatorServerEventSnapshotSchema),
    recent_server_events: z.array(spectatorRecentServerEventSchema),
    generated_at: z.number().int().nonnegative(),
    published_at: z.number().int().nonnegative(),
    last_publish_error_at: z.number().int().nonnegative().optional(),
  })
  .superRefine((snapshot, ctx) => {
    if (snapshot.timezone !== snapshot.calendar.timezone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'timezone must match calendar.timezone',
        path: ['timezone'],
      });
    }
  });

export function encodeSpectatorSnapshot(snapshot: SpectatorSnapshot): string {
  return JSON.stringify(snapshot);
}

export function decodeSpectatorSnapshot(input: string | unknown): SpectatorSnapshot {
  let parsed: unknown;

  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`decodeSpectatorSnapshot: invalid JSON (${reason})`);
    }
  } else {
    parsed = input;
  }

  return spectatorSnapshotSchema.parse(parsed) as SpectatorSnapshot;
}
