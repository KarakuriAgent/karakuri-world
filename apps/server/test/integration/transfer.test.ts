import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createTestWorld } from '../helpers/test-world.js';

const ADMIN_KEY = 'test-admin-key';
const PUBLIC_BASE_URL = 'http://localhost:3000';

type FetchableApp = {
  fetch: (request: Request) => Response | Promise<Response>;
};

async function requestJson(app: FetchableApp, path: string, init?: RequestInit): Promise<{ response: Response; data: any }> {
  const headers = new Headers(init?.headers ?? {});
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
  return {
    response,
    data: await response.json(),
  };
}

async function registerAgent(app: FetchableApp, discordBotId: string) {
  return requestJson(app, '/api/admin/agents', {
    method: 'POST',
    headers: { 'X-Admin-Key': ADMIN_KEY },
    body: JSON.stringify({ discord_bot_id: discordBotId }),
  });
}

describe('transfer API', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts and accepts a standalone transfer over REST', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food', stackable: true }],
      },
    });
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });
    const alice = await registerAgent(app, 'bot-alice');
    const bob = await registerAgent(app, 'bot-bob');

    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${alice.data.api_key}` } });
    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${bob.data.api_key}` } });
    engine.state.setNode(alice.data.agent_id, '1-1');
    engine.state.setNode(bob.data.agent_id, '1-2');
    engine.state.setItems(alice.data.agent_id, [{ item_id: 'apple', quantity: 2 }]);
    engine.state.setMoney(alice.data.agent_id, 300);

    const started = await requestJson(app, '/api/agents/transfer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ target_agent_id: bob.data.agent_id, items: [{ item_id: 'apple', quantity: 1 }], money: 120 }),
    });
    expect(started.response.status).toBe(200);
    expect(started.data.transfer_status).toBe('pending');

    const accepted = await requestJson(app, '/api/agents/transfer/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ transfer_id: started.data.transfer_id }),
    });
    expect(accepted.response.status).toBe(200);
    expect(accepted.data.transfer_status).toBe('completed');
    expect(engine.state.getLoggedIn(alice.data.agent_id)?.money).toBe(180);
    expect(engine.state.getLoggedIn(bob.data.agent_id)?.money).toBe(120);
    expect(engine.state.getLoggedIn(bob.data.agent_id)?.items).toEqual([{ item_id: 'apple', quantity: 1 }]);
  });

  it('restores persisted sender inventory if transfer timer creation fails', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food', stackable: true }],
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 1 }]);
    engine.state.setMoney(alice.agent_id, 50);
    engine.persistLoggedInAgentState(alice.agent_id);

    vi.spyOn(engine.timerManager, 'create').mockImplementationOnce(() => {
      throw new Error('timer failed');
    });

    expect(() => engine.startTransfer(alice.agent_id, {
      target_agent_id: bob.agent_id,
      items: [{ item_id: 'apple', quantity: 1 }],
      money: 10,
    })).toThrow('timer failed');

    expect(engine.state.getLoggedIn(alice.agent_id)?.money).toBe(50);
    expect(engine.state.getLoggedIn(alice.agent_id)?.items).toEqual([{ item_id: 'apple', quantity: 1 }]);
    expect(engine.state.getById(alice.agent_id)?.money).toBe(50);
    expect(engine.state.getById(alice.agent_id)?.items).toEqual([{ item_id: 'apple', quantity: 1 }]);
    expect(engine.state.transfers.list()).toEqual([]);
  });

  it('clears consumed info-command exclusions after standalone transfer commands', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food', stackable: true }],
      },
    });
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });
    const alice = await registerAgent(app, 'bot-alice');
    const bob = await registerAgent(app, 'bot-bob');

    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${alice.data.api_key}` } });
    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${bob.data.api_key}` } });
    engine.state.setNode(alice.data.agent_id, '1-1');
    engine.state.setNode(bob.data.agent_id, '1-2');
    engine.state.setItems(alice.data.agent_id, [{ item_id: 'apple', quantity: 1 }]);
    engine.state.addExcludedInfoCommand(alice.data.agent_id, 'get_perception');
    engine.state.addExcludedInfoCommand(bob.data.agent_id, 'get_map');

    const started = await requestJson(app, '/api/agents/transfer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ target_agent_id: bob.data.agent_id, items: [{ item_id: 'apple', quantity: 1 }] }),
    });

    expect(started.response.status).toBe(200);
    expect(engine.state.getExcludedInfoCommands(alice.data.agent_id).size).toBe(0);

    const accepted = await requestJson(app, '/api/agents/transfer/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ transfer_id: started.data.transfer_id }),
    });

    expect(accepted.response.status).toBe(200);
    expect(engine.state.getExcludedInfoCommands(bob.data.agent_id).size).toBe(0);
  });

  it('cancels a standalone transfer instead of settling it during a server-event window', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food', stackable: true }],
      },
    });
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });
    const alice = await registerAgent(app, 'bot-alice');
    const bob = await registerAgent(app, 'bot-bob');

    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${alice.data.api_key}` } });
    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${bob.data.api_key}` } });
    engine.state.setNode(alice.data.agent_id, '1-1');
    engine.state.setNode(bob.data.agent_id, '1-2');
    engine.state.setItems(alice.data.agent_id, [{ item_id: 'apple', quantity: 1 }]);

    const started = await requestJson(app, '/api/agents/transfer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ target_agent_id: bob.data.agent_id, items: [{ item_id: 'apple', quantity: 1 }] }),
    });
    engine.fireServerEvent('Storm warning.');

    const accepted = await requestJson(app, '/api/agents/transfer/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ transfer_id: started.data.transfer_id }),
    });

    expect(accepted.response.status).toBe(409);
    expect(engine.state.getLoggedIn(alice.data.agent_id)?.items).toEqual([{ item_id: 'apple', quantity: 1 }]);
    expect(engine.state.getLoggedIn(bob.data.agent_id)?.items).toEqual([]);
  });

  it('supports in-conversation transfer request and response via speak', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food', stackable: true }],
      },
    });
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });
    const alice = await registerAgent(app, 'bot-alice');
    const bob = await registerAgent(app, 'bot-bob');

    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${alice.data.api_key}` } });
    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${bob.data.api_key}` } });
    engine.state.setNode(alice.data.agent_id, '1-1');
    engine.state.setNode(bob.data.agent_id, '1-2');
    engine.state.setItems(alice.data.agent_id, [{ item_id: 'apple', quantity: 1 }]);

    const started = await requestJson(app, '/api/agents/conversation/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ target_agent_id: bob.data.agent_id, message: 'hello' }),
    });
    expect(started.response.status).toBe(200);
    await requestJson(app, '/api/agents/conversation/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ message: 'hi' }),
    });

    vi.advanceTimersByTime(500);
    const spoke = await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({
        message: 'take this',
        next_speaker_agent_id: bob.data.agent_id,
        transfer: { items: [{ item_id: 'apple', quantity: 1 }] },
      }),
    });
    expect(spoke.response.status).toBe(200);
    expect(spoke.data.transfer_status).toBe('pending');

    vi.advanceTimersByTime(500);
    const reply = await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({
        message: 'thanks',
        next_speaker_agent_id: alice.data.agent_id,
        transfer_response: 'accept',
      }),
    });
    expect(reply.response.status).toBe(200);
    expect(reply.data.transfer_status).toBe('completed');
    expect(engine.state.getLoggedIn(bob.data.agent_id)?.items).toEqual([{ item_id: 'apple', quantity: 1 }]);
  });

  it('auto-rejects a pending in-conversation transfer before starting a new one on speak', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [
          { item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food', stackable: true },
          { item_id: 'berry', name: 'ベリー', description: 'ベリー', type: 'food', stackable: true },
        ],
      },
    });
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });
    const alice = await registerAgent(app, 'bot-alice');
    const bob = await registerAgent(app, 'bot-bob');

    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${alice.data.api_key}` } });
    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${bob.data.api_key}` } });
    engine.state.setNode(alice.data.agent_id, '1-1');
    engine.state.setNode(bob.data.agent_id, '1-2');
    engine.state.setItems(alice.data.agent_id, [{ item_id: 'apple', quantity: 1 }]);
    engine.state.setItems(bob.data.agent_id, [{ item_id: 'berry', quantity: 1 }]);

    await requestJson(app, '/api/agents/conversation/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ target_agent_id: bob.data.agent_id, message: 'hello' }),
    });
    await requestJson(app, '/api/agents/conversation/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ message: 'hi' }),
    });

    vi.advanceTimersByTime(500);
    await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({
        message: 'take this',
        next_speaker_agent_id: bob.data.agent_id,
        transfer: { items: [{ item_id: 'apple', quantity: 1 }] },
      }),
    });

    vi.advanceTimersByTime(500);
    const reply = await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({
        message: 'and take this back',
        next_speaker_agent_id: alice.data.agent_id,
        transfer: { items: [{ item_id: 'berry', quantity: 1 }] },
      }),
    });

    expect(reply.response.status).toBe(200);
    expect(reply.data.transfer_status).toBe('pending');
    expect(engine.state.getLoggedIn(alice.data.agent_id)?.items).toEqual([{ item_id: 'apple', quantity: 1 }]);
    expect(engine.state.getLoggedIn(bob.data.agent_id)?.pending_transfer_id).toBeNull();
    expect(engine.state.getLoggedIn(alice.data.agent_id)?.pending_transfer_id).toBe(reply.data.transfer_id);
  });

  it('clears in-conversation transfer state when the receiver turn times out', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food', stackable: true }],
      },
    });
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });
    const alice = await registerAgent(app, 'bot-alice');
    const bob = await registerAgent(app, 'bot-bob');

    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${alice.data.api_key}` } });
    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${bob.data.api_key}` } });
    engine.state.setNode(alice.data.agent_id, '1-1');
    engine.state.setNode(bob.data.agent_id, '1-2');
    engine.state.setItems(alice.data.agent_id, [{ item_id: 'apple', quantity: 1 }]);

    const started = await requestJson(app, '/api/agents/conversation/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ target_agent_id: bob.data.agent_id, message: 'hello' }),
    });
    await requestJson(app, '/api/agents/conversation/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ message: 'hi' }),
    });

    vi.advanceTimersByTime(500);
    await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({
        message: 'take this',
        next_speaker_agent_id: bob.data.agent_id,
        transfer: { items: [{ item_id: 'apple', quantity: 1 }] },
      }),
    });

    vi.advanceTimersByTime(500 + 4000);

    expect(engine.state.conversations.get(started.data.conversation_id)).toBeNull();
    expect(engine.state.getLoggedIn(alice.data.agent_id)?.active_transfer_id).toBeNull();
    expect(engine.state.getLoggedIn(bob.data.agent_id)?.pending_transfer_id).toBeNull();
  });

  it('rejects an in-conversation transfer on accept when the receiver inventory is full', async () => {
    const { engine } = createTestWorld({
      config: {
        economy: { max_inventory_slots: 1 },
        items: [
          { item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food', stackable: false },
          { item_id: 'berry', name: 'ベリー', description: 'ベリー', type: 'food', stackable: false },
        ],
      },
    });
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });
    const alice = await registerAgent(app, 'bot-alice');
    const bob = await registerAgent(app, 'bot-bob');

    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${alice.data.api_key}` } });
    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${bob.data.api_key}` } });
    engine.state.setNode(alice.data.agent_id, '1-1');
    engine.state.setNode(bob.data.agent_id, '1-2');
    engine.state.setItems(alice.data.agent_id, [{ item_id: 'apple', quantity: 1 }]);
    engine.state.setItems(bob.data.agent_id, [{ item_id: 'berry', quantity: 1 }]);

    await requestJson(app, '/api/agents/conversation/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ target_agent_id: bob.data.agent_id, message: 'hello' }),
    });
    await requestJson(app, '/api/agents/conversation/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ message: 'hi' }),
    });

    vi.advanceTimersByTime(500);
    await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({
        message: 'take this',
        next_speaker_agent_id: bob.data.agent_id,
        transfer: { items: [{ item_id: 'apple', quantity: 1 }] },
      }),
    });

    vi.advanceTimersByTime(500);
    const reply = await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({
        message: 'cannot carry it',
        next_speaker_agent_id: alice.data.agent_id,
        transfer_response: 'accept',
      }),
    });

    expect(reply.response.status).toBe(200);
    expect(reply.data.transfer_status).toBe('failed');
    expect(reply.data.failure_reason).toBe('overflow_inventory_full');
    expect(engine.state.getLoggedIn(alice.data.agent_id)?.items).toEqual([{ item_id: 'apple', quantity: 1 }]);
    expect(engine.state.getLoggedIn(bob.data.agent_id)?.items).toEqual([{ item_id: 'berry', quantity: 1 }]);
  });

  it('honors transfer_response on the multi-party end_conversation path', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food', stackable: true }],
      },
    });
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });
    const alice = await registerAgent(app, 'bot-alice');
    const bob = await registerAgent(app, 'bot-bob');
    const carol = await registerAgent(app, 'bot-carol');

    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${alice.data.api_key}` } });
    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${bob.data.api_key}` } });
    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${carol.data.api_key}` } });
    engine.state.setNode(alice.data.agent_id, '1-1');
    engine.state.setNode(bob.data.agent_id, '1-2');
    engine.state.setNode(carol.data.agent_id, '2-1');
    engine.state.setItems(alice.data.agent_id, [{ item_id: 'apple', quantity: 1 }]);

    const started = await requestJson(app, '/api/agents/conversation/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ target_agent_id: bob.data.agent_id, message: 'hello' }),
    });
    await requestJson(app, '/api/agents/conversation/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ message: 'hi' }),
    });
    await requestJson(app, '/api/agents/conversation/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${carol.data.api_key}` },
      body: JSON.stringify({ conversation_id: started.data.conversation_id }),
    });

    vi.advanceTimersByTime(500);
    await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({
        message: 'take this',
        next_speaker_agent_id: bob.data.agent_id,
        transfer: { items: [{ item_id: 'apple', quantity: 1 }] },
      }),
    });

    vi.advanceTimersByTime(500);
    const ended = await requestJson(app, '/api/agents/conversation/end', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({
        message: 'I need to go',
        next_speaker_agent_id: carol.data.agent_id,
        transfer_response: 'accept',
      }),
    });

    expect(ended.response.status).toBe(200);
    expect(ended.data.transfer_status).toBe('completed');
    expect(engine.state.getLoggedIn(bob.data.agent_id)?.items).toEqual([{ item_id: 'apple', quantity: 1 }]);
  });

  it('rejects standalone transfer accept API for an in-conversation offer', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food', stackable: true }],
      },
    });
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });
    const alice = await registerAgent(app, 'bot-alice');
    const bob = await registerAgent(app, 'bot-bob');

    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${alice.data.api_key}` } });
    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${bob.data.api_key}` } });
    engine.state.setNode(alice.data.agent_id, '1-1');
    engine.state.setNode(bob.data.agent_id, '1-2');
    engine.state.setItems(alice.data.agent_id, [{ item_id: 'apple', quantity: 1 }]);

    await requestJson(app, '/api/agents/conversation/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ target_agent_id: bob.data.agent_id, message: 'hello' }),
    });
    await requestJson(app, '/api/agents/conversation/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ message: 'hi' }),
    });

    vi.advanceTimersByTime(500);
    const spoke = await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({
        message: 'take this',
        next_speaker_agent_id: bob.data.agent_id,
        transfer: { items: [{ item_id: 'apple', quantity: 1 }] },
      }),
    });

    const accepted = await requestJson(app, '/api/agents/transfer/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ transfer_id: spoke.data.transfer_id }),
    });

    expect(accepted.response.status).toBe(409);
    expect(engine.state.getLoggedIn(bob.data.agent_id)?.items).toEqual([]);
  });

  it('interrupts the conversation before moving during a server event with a pending in-conversation transfer', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food', stackable: true }],
      },
    });
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });
    const alice = await registerAgent(app, 'bot-alice');
    const bob = await registerAgent(app, 'bot-bob');

    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${alice.data.api_key}` } });
    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${bob.data.api_key}` } });
    engine.state.setNode(alice.data.agent_id, '1-1');
    engine.state.setNode(bob.data.agent_id, '1-2');
    engine.state.setItems(alice.data.agent_id, [{ item_id: 'apple', quantity: 1 }]);

    const started = await requestJson(app, '/api/agents/conversation/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ target_agent_id: bob.data.agent_id, message: 'hello' }),
    });
    await requestJson(app, '/api/agents/conversation/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ message: 'hi' }),
    });

    vi.advanceTimersByTime(500);
    await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({
        message: 'take this',
        next_speaker_agent_id: bob.data.agent_id,
        transfer: { items: [{ item_id: 'apple', quantity: 1 }] },
      }),
    });

    engine.fireServerEvent('Storm warning.');

    const moved = await requestJson(app, '/api/agents/move', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ target_node_id: '2-2' }),
    });

    expect(moved.response.status).toBe(200);
    expect(engine.state.getLoggedIn(bob.data.agent_id)?.state).toBe('moving');
    expect(engine.state.getLoggedIn(bob.data.agent_id)?.current_conversation_id).toBeNull();
    const conversation = engine.state.conversations.get(started.data.conversation_id);
    expect(conversation).not.toBeNull();
    expect(conversation?.participant_agent_ids).not.toContain(bob.data.agent_id);
  });

  it('cleans up a pending in-conversation transfer when a closing conversation is interrupted by a server event', async () => {
    const { engine } = createTestWorld({
      config: {
        conversation: { max_turns: 3 },
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food', stackable: true }],
      },
    });
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });
    const alice = await registerAgent(app, 'bot-alice');
    const bob = await registerAgent(app, 'bot-bob');

    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${alice.data.api_key}` } });
    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${bob.data.api_key}` } });
    engine.state.setNode(alice.data.agent_id, '1-1');
    engine.state.setNode(bob.data.agent_id, '1-2');
    engine.state.setItems(alice.data.agent_id, [{ item_id: 'apple', quantity: 1 }]);

    const started = await requestJson(app, '/api/agents/conversation/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ target_agent_id: bob.data.agent_id, message: 'hello' }),
    });
    await requestJson(app, '/api/agents/conversation/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ message: 'hi' }),
    });

    vi.advanceTimersByTime(500);
    await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({
        message: 'take this',
        next_speaker_agent_id: bob.data.agent_id,
        transfer: { items: [{ item_id: 'apple', quantity: 1 }] },
      }),
    });

    vi.advanceTimersByTime(500);
    expect(engine.state.conversations.get(started.data.conversation_id)?.status).toBe('closing');
    expect(engine.state.getLoggedIn(alice.data.agent_id)?.active_transfer_id).not.toBeNull();
    expect(engine.state.getLoggedIn(bob.data.agent_id)?.pending_transfer_id).not.toBeNull();

    engine.fireServerEvent('Storm warning.');

    const moved = await requestJson(app, '/api/agents/move', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ target_node_id: '2-2' }),
    });

    expect(moved.response.status).toBe(200);
    expect(engine.state.getLoggedIn(alice.data.agent_id)?.active_transfer_id).toBeNull();
    expect(engine.state.getLoggedIn(bob.data.agent_id)?.pending_transfer_id).toBeNull();
  });

  it('returns failed transfer_status sync feedback when in-conversation transfer is invalid (D5)', async () => {
    // 第 4 版 plan の Stage 順序 (A: validate 軽量 → B: 発話本体 → C: transfer 副作用) に従い、
    // transfer の在庫不足等は Stage C の startTransfer 内 validate で検出され、speak 自体は Stage B
    // で成立する。クライアントは transfer_status='failed' で原因を sync feedback として受け取る。
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food', stackable: true }],
      },
    });
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });
    const alice = await registerAgent(app, 'bot-alice');
    const bob = await registerAgent(app, 'bot-bob');

    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${alice.data.api_key}` } });
    await requestJson(app, '/api/agents/login', { method: 'POST', headers: { Authorization: `Bearer ${bob.data.api_key}` } });
    engine.state.setNode(alice.data.agent_id, '1-1');
    engine.state.setNode(bob.data.agent_id, '1-2');

    const started = await requestJson(app, '/api/agents/conversation/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ target_agent_id: bob.data.agent_id, message: 'hello' }),
    });
    await requestJson(app, '/api/agents/conversation/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ message: 'hi' }),
    });

    vi.advanceTimersByTime(500);
    const spoke = await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({
        message: 'take this',
        next_speaker_agent_id: bob.data.agent_id,
        transfer: { items: [{ item_id: 'apple', quantity: 1 }] },
      }),
    });

    // 発話自体は反映 (Stage B 成功)
    expect(spoke.response.status).toBe(200);
    expect(spoke.data.transfer_status).toBe('failed');
    // turn は進む (Stage B で advance) が transfer は成立しない
    const conversation = engine.state.conversations.get(started.data.conversation_id);
    expect(conversation?.current_turn).toBe(3);
    // alice の inventory は変動なし (escrow 取り込み失敗)
    expect(engine.state.getLoggedIn(alice.data.agent_id)?.items).toEqual([]);
  });
});
