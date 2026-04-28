import { z } from 'zod';

export const safeNonNegativeIntSchema = z.number().int().min(0).safe();
export const safePositiveIntSchema = z.number().int().min(1).safe();

export const transferItemSchema = z.object({
  item_id: z.string().min(1),
  quantity: safePositiveIntSchema,
}).strict();

const transferAttachmentItemOnlySchema = z.object({
  item: transferItemSchema,
}).strict();

const transferAttachmentMoneyOnlySchema = z.object({
  money: safePositiveIntSchema,
}).strict();

export const transferAttachmentSchema = z.union([
  transferAttachmentItemOnlySchema,
  transferAttachmentMoneyOnlySchema,
]);

const transferRequestItemOnlySchema = z.object({
  target_agent_id: z.string().min(1),
  item: transferItemSchema,
}).strict();

const transferRequestMoneyOnlySchema = z.object({
  target_agent_id: z.string().min(1),
  money: safePositiveIntSchema,
}).strict();

export const transferRequestSchema = z.union([
  transferRequestItemOnlySchema,
  transferRequestMoneyOnlySchema,
]);

export const transferIdSchema = z.object({
  transfer_id: z.string().min(1),
}).strict();
