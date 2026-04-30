import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createTestWorld } from '../helpers/test-world.js';

type FetchableApp = {
  fetch: (request: Request) => Response | Promise<Response>;
};

async function requestJson(app: FetchableApp, path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers ?? {});
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
  return {
    response,
    data: await response.json() as any,
  };
}

describe('info loop integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('blocks repeated info commands until an executable command is accepted', async () => {
    const { engine } = createTestWorld();
    const { app } = createApp(engine, { adminKey: 'admin', publicBaseUrl: 'http://localhost:3000' });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    const auth = { Authorization: `Bearer ${alice.api_key}` };

    const first = await requestJson(app, '/api/agents/perception', { headers: auth });
    expect(first.response.status).toBe(200);

    const repeated = await requestJson(app, '/api/agents/perception', { headers: auth });
    expect(repeated.response.status).toBe(409);
    expect(repeated.data.error).toBe('info_already_consumed');

    const moved = await requestJson(app, '/api/agents/move', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ target_node_id: '3-4' }),
    });
    expect(moved.response.status).toBe(200);

    const whileMoving = await requestJson(app, '/api/agents/perception', { headers: auth });
    expect(whileMoving.response.status).toBe(409);
    expect(whileMoving.data.error).toBe('state_conflict');

    vi.advanceTimersByTime(moved.data.arrives_at - Date.now());

    const afterMove = await requestJson(app, '/api/agents/perception', { headers: auth });
    expect(afterMove.response.status).toBe(200);
  });

  it('keeps the server-event window open across info commands until an executable command closes it', async () => {
    const { engine } = createTestWorld();
    const { app } = createApp(engine, { adminKey: 'admin', publicBaseUrl: 'http://localhost:3000' });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    const auth = { Authorization: `Bearer ${alice.api_key}` };

    const fired = engine.fireServerEvent('Dark clouds gather.');

    for (const path of [
      '/api/agents/perception',
      '/api/agents/actions',
      '/api/agents/map',
      '/api/agents/world-agents',
      '/api/agents/status',
      '/api/agents/nearby-agents',
      '/api/agents/active-conversations',
    ]) {
      const result = await requestJson(app, path, { headers: auth });
      expect(result.response.status).toBe(200);
      expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBe(fired.server_event_id);
    }

    const repeated = await requestJson(app, '/api/agents/map', { headers: auth });
    expect(repeated.response.status).toBe(409);
    expect(repeated.data.error).toBe('info_already_consumed');
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBe(fired.server_event_id);

    const waited = await requestJson(app, '/api/agents/wait', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ duration: 1 }),
    });
    expect(waited.response.status).toBe(200);
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBeNull();
  });

  it('closes the server-event window when an executable command is rejected after validation', async () => {
    const { engine } = createTestWorld({
      config: {
        economy: { initial_money: 100 },
        items: [
          { item_id: 'ticket', name: 'チケット', description: 'テスト用チケット', type: 'venue' as const, stackable: false },
        ],
        map: {
          ...createTestWorld().config.map,
          npcs: [
            {
              npc_id: 'npc-gatekeeper',
              name: 'Gatekeeper',
              description: 'Watches the town gate.',
              node_id: '1-2',
              actions: [
                {
                  action_id: 'expensive-greeting',
                  name: 'Expensive greeting',
                  description: 'Offer a costly greeting.',
                  duration_ms: 1200,
                  cost_money: 500,
                },
              ],
            },
          ],
        },
      },
    });
    const { app } = createApp(engine, { adminKey: 'admin', publicBaseUrl: 'http://localhost:3000' });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setItems(alice.agent_id, [{ item_id: 'ticket', quantity: 1 }]);
    const auth = { Authorization: `Bearer ${alice.api_key}` };

    const firedForAction = engine.fireServerEvent('Dark clouds gather.');
    const rejectedAction = await requestJson(app, '/api/agents/action', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ action_id: 'expensive-greeting' }),
    });
    expect(rejectedAction.response.status).toBe(200);
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBeNull();
    const afterRejectedAction = await requestJson(app, '/api/agents/perception', { headers: auth });
    expect(afterRejectedAction.response.status).toBe(200);
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBeNull();
    expect(
      engine.state.recentServerEvents
        .list()
        .find((event) => event.server_event_id === firedForAction.server_event_id)
        ?.is_active,
    ).toBe(false);

    const firedForVenue = engine.fireServerEvent('A horn sounds.');
    const rejectedVenue = await requestJson(app, '/api/agents/use-item', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ item_id: 'ticket' }),
    });
    expect(rejectedVenue.response.status).toBe(200);
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBeNull();
    const afterRejectedVenue = await requestJson(app, '/api/agents/map', { headers: auth });
    expect(afterRejectedVenue.response.status).toBe(200);
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBeNull();
    expect(
      engine.state.recentServerEvents
        .list()
        .find((event) => event.server_event_id === firedForVenue.server_event_id)
        ?.is_active,
    ).toBe(false);
  });

  it('keeps each agent\'s excluded info commands isolated', async () => {
    const { engine } = createTestWorld();
    const { app } = createApp(engine, { adminKey: 'admin', publicBaseUrl: 'http://localhost:3000' });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    const aliceAuth = { Authorization: `Bearer ${alice.api_key}` };
    const bobAuth = { Authorization: `Bearer ${bob.api_key}` };

    const aliceFirst = await requestJson(app, '/api/agents/perception', { headers: aliceAuth });
    expect(aliceFirst.response.status).toBe(200);

    const bobFirst = await requestJson(app, '/api/agents/perception', { headers: bobAuth });
    expect(bobFirst.response.status).toBe(200);

    const bobWaited = await requestJson(app, '/api/agents/wait', {
      method: 'POST',
      headers: bobAuth,
      body: JSON.stringify({ duration: 1 }),
    });
    expect(bobWaited.response.status).toBe(200);

    const aliceRepeat = await requestJson(app, '/api/agents/perception', { headers: aliceAuth });
    expect(aliceRepeat.response.status).toBe(409);
    expect(aliceRepeat.data.error).toBe('info_already_consumed');
  });

  it('clears excluded info commands when a conversation command is accepted', async () => {
    const { engine } = createTestWorld();
    const { app } = createApp(engine, { adminKey: 'admin', publicBaseUrl: 'http://localhost:3000' });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-1');
    const aliceAuth = { Authorization: `Bearer ${alice.api_key}` };

    const consumed = await requestJson(app, '/api/agents/perception', { headers: aliceAuth });
    expect(consumed.response.status).toBe(200);
    expect(engine.state.getExcludedInfoCommands(alice.agent_id).has('get_perception')).toBe(true);

    const started = await requestJson(app, '/api/agents/conversation/start', {
      method: 'POST',
      headers: aliceAuth,
      body: JSON.stringify({ target_agent_id: bob.agent_id, message: 'hi' }),
    });
    expect(started.response.status).toBe(200);
    expect(engine.state.getExcludedInfoCommands(alice.agent_id).has('get_perception')).toBe(false);
  });

  it('accepts new info commands once and rejects them during transfer', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food' as const, stackable: true }],
      },
    });
    const { app } = createApp(engine, { adminKey: 'admin', publicBaseUrl: 'http://localhost:3000' });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    const auth = { Authorization: `Bearer ${alice.api_key}` };

    for (const path of ['/api/agents/status', '/api/agents/nearby-agents', '/api/agents/active-conversations']) {
      const result = await requestJson(app, path, { headers: auth });
      expect(result.response.status).toBe(200);
      const repeated = await requestJson(app, path, { headers: auth });
      expect(repeated.response.status).toBe(409);
      expect(repeated.data.error).toBe('info_already_consumed');
      const waited = await requestJson(app, '/api/agents/wait', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ duration: 1 }),
      });
      expect(waited.response.status).toBe(200);
      vi.advanceTimersByTime(waited.data.completes_at - Date.now());
    }

    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 1 }]);
    const transfer = await requestJson(app, '/api/agents/transfer', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ target_agent_id: bob.agent_id, item: { item_id: 'apple', quantity: 1 } }),
    });
    expect(transfer.response.status).toBe(200);
    const duringTransfer = await requestJson(app, '/api/agents/status', { headers: auth });
    expect(duringTransfer.response.status).toBe(409);
    expect(duringTransfer.data.error).toBe('state_conflict');
  });
});
