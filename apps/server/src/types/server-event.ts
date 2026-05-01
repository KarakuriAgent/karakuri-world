export interface ServerEvent {
  readonly server_event_id: string;
  readonly description: string;
  readonly created_at: number;
  readonly cleared_at: number | null;
}

export type ActiveServerEvent = ServerEvent & { readonly cleared_at: null };
export type ClearedServerEvent = ServerEvent & { readonly cleared_at: number };

export function isServerEventActive(event: ServerEvent): event is ActiveServerEvent {
  return event.cleared_at === null;
}

export function isServerEventCleared(event: ServerEvent): event is ClearedServerEvent {
  return event.cleared_at !== null;
}
