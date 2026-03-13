import type { WSContext } from 'hono/ws';
import { WebSocket } from 'ws';

import type { WorldEngine } from '../engine/world-engine.js';
import type { WorldEvent } from '../types/event.js';
import type { WorldSnapshot } from '../types/snapshot.js';

export type WebSocketPayload =
  | {
      type: 'snapshot';
      data: WorldSnapshot;
    }
  | {
      type: 'event';
      data: WorldEvent;
    };

export class WebSocketManager {
  private readonly clients = new Set<WSContext<WebSocket>>();
  private readonly unsubscribe: () => void;

  constructor(private readonly engine: WorldEngine) {
    this.unsubscribe = this.engine.eventBus.onAny((event) => {
      if (event.type === 'idle_reminder_fired') {
        return;
      }
      this.broadcast({ type: 'event', data: event });
    });
  }

  handleOpen(ws: WSContext<WebSocket>): void {
    this.clients.add(ws);
    this.send(ws, { type: 'snapshot', data: this.engine.getSnapshot() });
  }

  handleClose(ws: WSContext<WebSocket>): void {
    this.clients.delete(ws);
  }

  dispose(): void {
    this.unsubscribe();
    this.clients.clear();
  }

  private broadcast(payload: WebSocketPayload): void {
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        this.send(client, payload);
      }
    }
  }

  private send(client: WSContext<WebSocket>, payload: WebSocketPayload): void {
    client.send(JSON.stringify(payload));
  }
}
