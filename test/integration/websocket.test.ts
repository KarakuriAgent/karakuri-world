import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { createApp } from '../../src/api/app.js';
import { createTestWorld } from '../helpers/test-world.js';

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 2000) {
      throw new Error('Timed out waiting for websocket condition.');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForMessage(messages: any[], predicate: (message: any) => boolean): Promise<any> {
  await waitForCondition(() => messages.some(predicate));
  return messages.find(predicate);
}

describe('websocket integration', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends snapshots, broadcasts movement events, and includes movement data after reconnect', async () => {
    const { engine } = createTestWorld({
      config: {
        movement: { duration_ms: 100 },
        spawn: { nodes: ['3-1'] },
      },
    });
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

    const snapshotMessage = await waitForMessage(messages, (message) => message.type === 'snapshot');
    expect(snapshotMessage.type).toBe('snapshot');
    expect(snapshotMessage.data.agents).toEqual([]);

    const registration = engine.registerAgent({ agent_name: 'alice', discord_bot_id: 'bot-alice' });
    await engine.joinAgent(registration.agent_id);

    const joinedMessage = await waitForMessage(
      messages,
      (message) => message.type === 'event' && message.data.type === 'agent_joined',
    );
    expect(joinedMessage.data).toMatchObject({
      type: 'agent_joined',
      agent_id: registration.agent_id,
      node_id: '3-1',
    });

    const move = engine.move(registration.agent_id, { target_node_id: '3-4' });

    const startedMessage = await waitForMessage(
      messages,
      (message) => message.type === 'event' && message.data.type === 'movement_started',
    );
    expect(startedMessage.data).toMatchObject({
      type: 'movement_started',
      agent_id: registration.agent_id,
      from_node_id: '3-1',
      to_node_id: '3-4',
      path: ['3-2', '3-3', '3-4'],
      arrives_at: move.arrives_at,
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    const reconnectingWs = new WebSocket(`ws://127.0.0.1:${serverInfo.port}/ws`);
    const reconnectMessages: any[] = [];
    reconnectingWs.on('message', (raw) => {
      reconnectMessages.push(JSON.parse(raw.toString()));
    });
    reconnectingWs.on('error', (error) => {
      throw error;
    });
    await once(reconnectingWs, 'open');

    const reconnectSnapshot = await waitForMessage(reconnectMessages, (message) => message.type === 'snapshot');
    expect(reconnectSnapshot.data.agents).toEqual([
      expect.objectContaining({
        agent_id: registration.agent_id,
        node_id: '3-2',
        state: 'moving',
        movement: {
          from_node_id: '3-1',
          to_node_id: '3-4',
          path: ['3-2', '3-3', '3-4'],
          arrives_at: move.arrives_at,
        },
      }),
    ]);

    const completedMessage = await waitForMessage(
      messages,
      (message) => message.type === 'event' && message.data.type === 'movement_completed',
    );
    expect(completedMessage.data).toMatchObject({
      type: 'movement_completed',
      agent_id: registration.agent_id,
      node_id: '3-4',
    });
    expect(completedMessage.data.to_node_id).toBeUndefined();

    ws.close();
    await once(ws, 'close');
    reconnectingWs.close();
    await once(reconnectingWs, 'close');
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
