import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createTestWorld } from '../helpers/test-world.js';

const ADMIN_KEY = 'test-admin-key';
const CONFIG_PATH = './config/example.yaml';
const PUBLIC_BASE_URL = 'http://localhost:3000';

type JsonResult = {
  response: Response;
  data: any;
};

type FetchableApp = {
  fetch: (request: Request) => Response | Promise<Response>;
};

async function requestJson(app: FetchableApp, path: string, init?: RequestInit): Promise<JsonResult> {
  const headers = new Headers(init?.headers ?? {});
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers,
    }),
  );
  const contentType = response.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, data };
}

async function registerAgent(app: FetchableApp, agentName: string, discordBotId = `bot-${agentName}`): Promise<JsonResult> {
  return requestJson(app, '/api/admin/agents', {
    method: 'POST',
    headers: { 'X-Admin-Key': ADMIN_KEY },
    body: JSON.stringify({ agent_name: agentName, discord_bot_id: discordBotId }),
  });
}

describe('REST API', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('supports admin registration, lifecycle routes, info routes, and deletion', async () => {
    const { engine } = createTestWorld();
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, configPath: CONFIG_PATH, publicBaseUrl: PUBLIC_BASE_URL });

    const registered = await registerAgent(app, 'alice', 'discord-alice');
    expect(registered.response.status).toBe(201);
    expect(registered.data.api_base_url).toBe('http://localhost:3000/api');
    expect(registered.data.mcp_endpoint).toBe('http://localhost:3000/mcp');

    const listed = await requestJson(app, '/api/admin/agents', {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(listed.response.status).toBe(200);
    expect(listed.data.agents).toEqual([
      {
        agent_id: registered.data.agent_id,
        agent_name: 'alice',
        discord_bot_id: 'discord-alice',
        is_logged_in: false,
      },
    ]);
    expect(listed.data.agents[0]).not.toHaveProperty('api_key');

    const joined = await requestJson(app, '/api/agents/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
    });
    expect(joined.response.status).toBe(200);
    expect(joined.data.channel_id).toBe('channel-alice');
    expect(['3-1', '3-2']).toContain(joined.data.node_id);

    const listedAfterJoin = await requestJson(app, '/api/admin/agents', {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(listedAfterJoin.data.agents).toEqual([
      {
        agent_id: registered.data.agent_id,
        agent_name: 'alice',
        discord_bot_id: 'discord-alice',
        is_logged_in: true,
      },
    ]);

    const perception = await requestJson(app, '/api/agents/perception', {
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
    });
    expect(perception.response.status).toBe(200);
    expect(perception.data.current_node.node_id).toBe(joined.data.node_id);

    const map = await requestJson(app, '/api/agents/map', {
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
    });
    expect(map.data.rows).toBe(3);

    const worldAgents = await requestJson(app, '/api/agents/world-agents', {
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
    });
    expect(worldAgents.data.agents).toHaveLength(1);

    const actions = await requestJson(app, '/api/agents/actions', {
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
    });
    expect(actions.data.actions).toEqual([]);

    const snapshot = await requestJson(app, '/api/snapshot', {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(snapshot.response.status).toBe(200);
    expect(snapshot.data.agents).toHaveLength(1);

    const left = await requestJson(app, '/api/agents/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
    });
    expect(left.data).toEqual({ status: 'ok' });

    const deleted = await requestJson(app, `/api/admin/agents/${listed.data.agents[0].agent_id}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(deleted.data).toEqual({ status: 'ok' });
  });

  it('returns 401, 403, 400, and 409 errors in representative cases', async () => {
    const { engine } = createTestWorld();
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, configPath: CONFIG_PATH, publicBaseUrl: PUBLIC_BASE_URL });
    const registered = await registerAgent(app, 'alice');
    const invalidAgentName = await registerAgent(app, 'Alice');

    expect(invalidAgentName.response.status).toBe(400);
    expect(invalidAgentName.data.error).toBe('invalid_request');

    const unauthorized = await requestJson(app, '/api/agents/perception');
    expect(unauthorized.response.status).toBe(401);
    expect(unauthorized.data.error).toBe('unauthorized');

    const snapshotUnauthorized = await requestJson(app, '/api/snapshot');
    expect(snapshotUnauthorized.response.status).toBe(401);
    expect(snapshotUnauthorized.data.error).toBe('unauthorized');

    const notJoined = await requestJson(app, '/api/agents/perception', {
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
    });
    expect(notJoined.response.status).toBe(403);
    expect(notJoined.data.error).toBe('not_logged_in');

    const leaveBeforeJoin = await requestJson(app, '/api/agents/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
    });
    expect(leaveBeforeJoin.response.status).toBe(409);
    expect(leaveBeforeJoin.data.error).toBe('state_conflict');

    await requestJson(app, '/api/agents/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
    });

    const deleteWhileJoined = await requestJson(app, `/api/admin/agents/${registered.data.agent_id}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(deleteWhileJoined.response.status).toBe(409);
    expect(deleteWhileJoined.data.error).toBe('state_conflict');

    const invalidBody = await requestJson(app, '/api/agents/move', {
      method: 'POST',
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
      body: JSON.stringify({ target_node_id: 'up' }),
    });
    expect(invalidBody.response.status).toBe(400);
    expect(invalidBody.data.error).toBe('invalid_request');

    const firstMove = await requestJson(app, '/api/agents/move', {
      method: 'POST',
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
      body: JSON.stringify({ target_node_id: '3-4' }),
    });
    expect(firstMove.response.status).toBe(200);

    const conflict = await requestJson(app, '/api/agents/move', {
      method: 'POST',
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
      body: JSON.stringify({ target_node_id: '3-4' }),
    });
    expect(conflict.response.status).toBe(409);
    expect(conflict.data.error).toBe('state_conflict');
  });

  it('wires action, conversation, and server event endpoints', async () => {
    const { engine } = createTestWorld();
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, configPath: CONFIG_PATH, publicBaseUrl: PUBLIC_BASE_URL });

    const alice = await registerAgent(app, 'alice');
    const bob = await registerAgent(app, 'bob');

    await requestJson(app, '/api/agents/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
    });
    await requestJson(app, '/api/agents/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
    });

    const aliceRegistration = engine.listAgents().find((agent) => agent.agent_name === 'alice');
    const bobRegistration = engine.listAgents().find((agent) => agent.agent_name === 'bob');
    if (!aliceRegistration || !bobRegistration) {
      throw new Error('Failed to lookup test agents.');
    }

    engine.state.setNode(aliceRegistration.agent_id, '1-1');
    const action = await requestJson(app, '/api/agents/action', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ action_id: 'greet-gatekeeper' }),
    });
    expect(action.response.status).toBe(200);

    engine.state.setNode(aliceRegistration.agent_id, '3-1');
    engine.state.setState(aliceRegistration.agent_id, 'idle');
    engine.state.setNode(bobRegistration.agent_id, '3-2');

    const started = await requestJson(app, '/api/agents/conversation/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ target_agent_id: bobRegistration.agent_id, message: 'Hello Bob' }),
    });
    expect(started.response.status).toBe(200);

    const accepted = await requestJson(app, '/api/agents/conversation/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ conversation_id: started.data.conversation_id }),
    });
    expect(accepted.data).toEqual({ status: 'ok' });

    const spoke = await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ conversation_id: started.data.conversation_id, message: 'Hi Alice' }),
    });
    expect(spoke.data.turn).toBe(2);

    const fired = await requestJson(app, '/api/admin/server-events/sudden-rain/fire', {
      method: 'POST',
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(fired.response.status).toBe(200);

    const selected = await requestJson(app, '/api/agents/server-event/select', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ server_event_id: fired.data.server_event_id, choice_id: 'take-shelter' }),
    });
    expect(selected.data).toEqual({ status: 'ok' });
  });
});
