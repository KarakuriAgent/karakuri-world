import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

import type { ServerEvent } from '../types/server-event.js';

export interface ServerEventsFileData {
  version: number;
  events: ServerEvent[];
}

export const CURRENT_SERVER_EVENTS_VERSION = 1;

const serverEventSchema = z
  .object({
    server_event_id: z.string().min(1),
    description: z.string().min(1),
    created_at: z.number().int().nonnegative(),
    cleared_at: z.number().int().nonnegative().nullable(),
  })
  .refine((event) => event.cleared_at === null || event.cleared_at >= event.created_at, {
    message: 'cleared_at must be greater than or equal to created_at',
    path: ['cleared_at'],
  });

const serverEventsFileSchema = z.object({
  version: z.number().int(),
  events: z.array(serverEventSchema),
});

export function loadServerEvents(filePath: string): ServerEvent[] {
  if (!existsSync(filePath)) {
    saveServerEvents(filePath, []);
    return [];
  }
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  return validateServerEventsFileData(parsed).events;
}

export function saveServerEvents(filePath: string, events: readonly ServerEvent[]): void {
  const fileData = validateServerEventsFileData({ version: CURRENT_SERVER_EVENTS_VERSION, events });
  const tmpPath = `${filePath}.tmp`;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(tmpPath, `${JSON.stringify(fileData, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

function validateServerEventsFileData(value: unknown): ServerEventsFileData {
  const parsed = serverEventsFileSchema.parse(value);
  if (parsed.version !== CURRENT_SERVER_EVENTS_VERSION) {
    throw new Error(`Unsupported server events file version: ${parsed.version}`);
  }
  const seen = new Set<string>();
  for (const event of parsed.events) {
    if (seen.has(event.server_event_id)) {
      throw new Error(`Duplicate server_event_id: ${event.server_event_id}`);
    }
    seen.add(event.server_event_id);
  }
  return {
    version: CURRENT_SERVER_EVENTS_VERSION,
    events: [...parsed.events].sort(
      (left, right) => left.created_at - right.created_at || left.server_event_id.localeCompare(right.server_event_id),
    ),
  };
}
