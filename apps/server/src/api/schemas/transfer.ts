import { z } from 'zod';

export const safeNonNegativeIntSchema = z.number().int().min(0).safe();
export const safePositiveIntSchema = z.number().int().min(1).safe();

export const itemsSchema = z.array(
  z.object({
    item_id: z.string().min(1),
    quantity: safePositiveIntSchema,
  }).strict(),
);

function validateNonEmptyTransfer(data: { items?: Array<{ quantity: number }>; money?: number }, ctx: z.RefinementCtx): void {
  const itemTotal = data.items?.reduce((sum, item) => sum + item.quantity, 0) ?? 0;
  if (itemTotal === 0 && (data.money ?? 0) === 0) {
    ctx.addIssue({ code: 'custom', message: 'items または money の合計が 0 より大きい必要があります。' });
  }
}

export const transferAttachmentSchema = z.object({
  items: itemsSchema.optional(),
  money: safeNonNegativeIntSchema.optional(),
}).strict().superRefine(validateNonEmptyTransfer);

export const transferRequestSchema = z.object({
  target_agent_id: z.string().min(1),
  items: itemsSchema.optional(),
  money: safeNonNegativeIntSchema.optional(),
}).strict().superRefine(validateNonEmptyTransfer);

export const transferIdSchema = z.object({
  transfer_id: z.string().min(1),
}).strict();
