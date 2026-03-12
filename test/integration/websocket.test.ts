import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { createApp } from '../../src/api/app.js';
import { createTestWorld } from '../helpers/test-world.js';

async function waitForMessages(messages: any[], count: number): Promise<void> {
  const startedAt = Date.now();
  while (messages.length < count) {
    if (Date.now() - startedAt > 2000) {
      throw new Error(`Timed out waiting for ${count} websocket messages.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('websocket integration', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends an initial snapshot and broadcasts events', async () => {
    const { engine } = createTestWorld({ withDiscord: false });
    const { app, injectWebSocket, websocketManager } = createApp(engine, {
      adminKey: 'admin',
      publicBaseUrl: 'http://localhost:3000',
    });

    let serverInfo: AddressInfo | undefined;
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      serverInfo = info;
    });
    injectWebSocket(server);

    if (!serverInfo) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!serverInfo) {
      throw new Error('Server failed to start.');
    }

    const ws = new WebSocket(`ws://127.0.0.1:${serverInfo.port}/ws`);
    const messages: any[] = [];
    ws.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString()));
    });
    ws.on('error', (error) => {
      throw error;
    });
    await once(ws, 'open');

    await waitForMessages(messages, 1);
    const snapshotMessage = messages[0];
    expect(snapshotMessage.type).toBe('snapshot');
    expect(snapshotMessage.data.agents).toEqual([]);

    const registration = engine.registerAgent({ agent_name: 'alice' });
    await engine.joinAgent(registration.agent_id);

    await waitForMessages(messages, 2);
    const eventMessage = messages[1];
    expect(eventMessage.type).toBe('event');
    expect(eventMessage.data.type).toBe('agent_joined');

    ws.close();
    await once(ws, 'close');
    websocketManager.dispose();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
});
