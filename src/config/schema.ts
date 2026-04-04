import { z } from 'zod';

const nodeIdSchema = z.string().regex(/^\d+-\d+$/);

export const actionConfigSchema = z
  .object({
    action_id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    duration_ms: z.number().int().min(1),
    result_description: z.string().min(1),
  })
  .strict();

export const nodeConfigSchema = z
  .object({
    type: z.enum(['normal', 'wall', 'door', 'building_interior', 'npc']),
    label: z.string().min(1).optional(),
    building_id: z.string().min(1).optional(),
    npc_id: z.string().min(1).optional(),
  })
  .strict();

export const buildingConfigSchema = z
  .object({
    building_id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    wall_nodes: z.array(nodeIdSchema).min(1),
    interior_nodes: z.array(nodeIdSchema).min(1),
    door_nodes: z.array(nodeIdSchema).min(1),
    actions: z.array(actionConfigSchema),
  })
  .strict();

export const npcConfigSchema = z
  .object({
    npc_id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    node_id: nodeIdSchema,
    actions: z.array(actionConfigSchema),
  })
  .strict();

export const mapConfigSchema = z
  .object({
    rows: z.number().int().min(1),
    cols: z.number().int().min(1),
    nodes: z.record(nodeIdSchema, nodeConfigSchema),
    buildings: z.array(buildingConfigSchema),
    npcs: z.array(npcConfigSchema),
  })
  .strict();

export const idleReminderConfigSchema = z
  .object({
    interval_ms: z.number().int().min(1),
  })
  .strict();

export const serverConfigSchema = z
  .object({
    world: z
      .object({
        name: z.string().min(1),
        description: z.string().min(1),
        skill_name: z.string().min(1),
      })
      .strict(),
    movement: z
      .object({
        duration_ms: z.number().int().min(1),
      })
      .strict(),
    conversation: z
      .object({
        max_turns: z.number().int().min(1),
        interval_ms: z.number().int().min(1),
        accept_timeout_ms: z.number().int().min(1),
        turn_timeout_ms: z.number().int().min(1),
      })
      .strict(),
    perception: z
      .object({
        range: z.number().int().min(0),
      })
      .strict(),
    spawn: z
      .object({
        nodes: z.array(nodeIdSchema).min(1),
      })
      .strict(),
    map: mapConfigSchema,
    idle_reminder: idleReminderConfigSchema.optional(),
  })
  .strict();
