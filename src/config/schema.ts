import { z } from 'zod';

const nodeIdSchema = z.string().regex(/^\d+-\d+$/);
const hoursTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const nonNegativeIntSchema = z.number().int().min(0);
const positiveIntSchema = z.number().int().min(1);

export const hoursSchema = z
  .object({
    open: hoursTimeSchema,
    close: hoursTimeSchema,
  })
  .strict();

export const itemRequirementSchema = z
  .object({
    item_id: z.string().min(1),
    quantity: positiveIntSchema,
  })
  .strict();

export const actionConfigSchema = z
  .object({
    action_id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    hours: hoursSchema.optional(),
    cost_money: nonNegativeIntSchema.optional(),
    reward_money: nonNegativeIntSchema.optional(),
    required_items: z.array(itemRequirementSchema).optional(),
    reward_items: z.array(itemRequirementSchema).optional(),
    duration_ms: positiveIntSchema.optional(),
    min_duration_minutes: positiveIntSchema.optional(),
    max_duration_minutes: positiveIntSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasFixed = data.duration_ms !== undefined;
    const hasRange = data.min_duration_minutes !== undefined || data.max_duration_minutes !== undefined;
    if (hasFixed && hasRange) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Cannot specify both duration_ms and min/max_duration_minutes.' });
    } else if (!hasFixed && !hasRange) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Either duration_ms or both min_duration_minutes and max_duration_minutes must be specified.' });
    } else if (hasRange) {
      if (data.min_duration_minutes === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['min_duration_minutes'], message: 'min_duration_minutes is required when using range duration.' });
      }
      if (data.max_duration_minutes === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['max_duration_minutes'], message: 'max_duration_minutes is required when using range duration.' });
      }
      if (data.min_duration_minutes !== undefined && data.max_duration_minutes !== undefined && data.min_duration_minutes > data.max_duration_minutes) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'min_duration_minutes must be <= max_duration_minutes.' });
      }
    }
  });

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
    hours: hoursSchema.optional(),
  })
  .strict();

export const npcConfigSchema = z
  .object({
    npc_id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    node_id: nodeIdSchema,
    actions: z.array(actionConfigSchema),
    hours: hoursSchema.optional(),
  })
  .strict();

export const mapConfigSchema = z
  .object({
    rows: positiveIntSchema,
    cols: positiveIntSchema,
    nodes: z.record(nodeIdSchema, nodeConfigSchema),
    buildings: z.array(buildingConfigSchema),
    npcs: z.array(npcConfigSchema),
  })
  .strict();

export const idleReminderConfigSchema = z
  .object({
    interval_ms: positiveIntSchema,
  })
  .strict();

export const weatherConfigSchema = z
  .object({
    location: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      })
      .strict(),
    interval_ms: positiveIntSchema.default(1_800_000),
  })
  .strict();

export const economyConfigSchema = z
  .object({
    initial_money: nonNegativeIntSchema.optional(),
    max_inventory_slots: positiveIntSchema.optional(),
    item_use_duration_ms: positiveIntSchema.optional(),
  })
  .strict();

export const itemTypeSchema = z.enum(['general', 'food', 'drink', 'venue']);

export const itemConfigSchema = z
  .object({
    item_id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    type: itemTypeSchema,
    stackable: z.boolean().default(true),
    max_stack: positiveIntSchema.optional(),
  })
  .strict();

const timezoneSchema = z.string().default('Asia/Tokyo').refine(
  (timezone) => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Invalid IANA timezone' },
);

export const serverConfigSchema = z
  .object({
    world: z
      .object({
        name: z.string().min(1),
        description: z.string().min(1),
        skill_name: z.string().min(1),
      })
      .strict(),
    timezone: timezoneSchema,
    movement: z
      .object({
        duration_ms: positiveIntSchema,
      })
      .strict(),
    conversation: z
      .object({
        max_turns: positiveIntSchema,
        interval_ms: positiveIntSchema,
        accept_timeout_ms: positiveIntSchema,
        turn_timeout_ms: positiveIntSchema,
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
    weather: weatherConfigSchema.optional(),
    economy: economyConfigSchema.optional(),
    items: z.array(itemConfigSchema).optional(),
  })
  .strict();
