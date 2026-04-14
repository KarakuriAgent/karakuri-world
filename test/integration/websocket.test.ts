import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { createApp } from '../../src/api/app.js';
import { createTestWorld } from '../helpers/test-world.js';

const ADMIN_KEY = 'admin';

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

  it('rejects websocket handshakes without the admin key', async () => {
    const { engine } = createTestWorld();
    const { app, injectWebSocket, websocketManager } = createApp(engine, {
      adminKey: ADMIN_KEY,
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
    const port = serverInfo.port;

    const statusCode = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0);
      });
      ws.once('open', () => {
        reject(new Error('Expected websocket handshake to be rejected.'));
      });
      ws.once('error', () => {});
    });

    expect(statusCode).toBe(401);

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

  it('sends snapshots, broadcasts movement events, and includes movement data after reconnect', async () => {
    const { engine } = createTestWorld({
      config: {
        movement: { duration_ms: 100 },
        spawn: { nodes: ['3-1'] },
      },
    });
    const { app, injectWebSocket, websocketManager } = createApp(engine, {
      adminKey: ADMIN_KEY,
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
    const port = serverInfo.port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
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
    expect(snapshotMessage.data.calendar).toMatchObject({
      timezone: 'Asia/Tokyo',
      local_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      local_time: expect.stringMatching(/^\d{2}:\d{2}:\d{2}$/),
      season: expect.stringMatching(/^(spring|summer|autumn|winter)$/),
      season_label: expect.stringMatching(/^(春|夏|秋|冬)$/),
      day_in_season: expect.any(Number),
      display_label: expect.stringMatching(/.+・\d+日目$/),
    });
    expect(snapshotMessage.data.map_render_theme).toMatchObject({
      cell_size: 96,
      node_id_font_size: 12,
      background_fill: '#e2e8f0',
    });
    expect(snapshotMessage.data.agents).toEqual([]);

    const registration = await engine.registerAgent({ discord_bot_id: 'bot-alice', });
    await engine.loginAgent(registration.agent_id);

    const joinedMessage = await waitForMessage(
      messages,
      (message) => message.type === 'event' && message.data.type === 'agent_logged_in',
    );
    expect(joinedMessage.data).toMatchObject({
      type: 'agent_logged_in',
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

    const reconnectingWs = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
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

  it('does not broadcast internal info-request events', async () => {
    const { engine } = createTestWorld();
    const { app, injectWebSocket, websocketManager } = createApp(engine, {
      adminKey: ADMIN_KEY,
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

    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);

    const ws = new WebSocket(`ws://127.0.0.1:${serverInfo.port}/ws`, {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    const messages: any[] = [];
    ws.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString()));
    });
    await once(ws, 'open');
    await waitForMessage(messages, (message) => message.type === 'snapshot');

    const initialEventCount = messages.filter((message) => message.type === 'event').length;
    engine.emitEvent({ type: 'perception_requested', agent_id: alice.agent_id });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages.filter((message) => message.type === 'event')).toHaveLength(initialEventCount);

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
