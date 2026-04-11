import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { WorldEngine } from '../../src/engine/world-engine.js';
import { WorldError } from '../../src/types/api.js';
import { createTestWorld } from '../helpers/test-world.js';
import { createTestConfig } from '../helpers/test-map.js';

const ADMIN_KEY = 'test-admin-key';
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

async function registerAgent(
  app: FetchableApp,
  agentName: string,
  discordBotId = agentName,
): Promise<JsonResult> {
  return requestJson(app, '/api/admin/agents', {
    method: 'POST',
    headers: { 'X-Admin-Key': ADMIN_KEY },
    body: JSON.stringify({ discord_bot_id: discordBotId }),
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
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });

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
        is_logged_in: true,
      },
    ]);

    const perception = await requestJson(app, '/api/agents/perception', {
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
    });
    expect(perception.response.status).toBe(200);
    expect(perception.data).toEqual({
      ok: true,
      message: '正常に受け付けました。結果が通知されるまで待機してください。',
    });

    const map = await requestJson(app, '/api/agents/map', {
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
    });
    expect(map.data).toEqual({
      ok: true,
      message: '正常に受け付けました。結果が通知されるまで待機してください。',
    });

    const worldAgents = await requestJson(app, '/api/agents/world-agents', {
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
    });
    expect(worldAgents.data).toEqual({
      ok: true,
      message: '正常に受け付けました。結果が通知されるまで待機してください。',
    });

    const actions = await requestJson(app, '/api/agents/actions', {
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
    });
    expect(actions.data).toEqual({
      ok: true,
      message: '正常に受け付けました。結果が通知されるまで待機してください。',
    });

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
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });
    const registered = await registerAgent(app, 'alice');
    const emptyBotId = await requestJson(app, '/api/admin/agents', {
      method: 'POST',
      headers: { 'X-Admin-Key': ADMIN_KEY },
      body: JSON.stringify({ discord_bot_id: '' }),
    });
    const duplicateAgent = await registerAgent(app, 'alice');

    expect(emptyBotId.response.status).toBe(400);
    expect(emptyBotId.data.error).toBe('invalid_request');

    expect(duplicateAgent.response.status).toBe(409);
    expect(duplicateAgent.data.error).toBe('state_conflict');

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

  it('surfaces Discord bot lookup failures as validation errors during admin registration', async () => {
    const engine = new WorldEngine(createTestConfig(), {
      createAgentChannel: async () => 'channel-id',
      deleteAgentChannel: async () => {},
      channelExists: async () => true,
      fetchBotInfo: async (discordBotId: string) => {
        if (discordBotId === '123456789012345678') {
          throw new WorldError(400, 'invalid_request', `Discord bot not found: ${discordBotId}`);
        }

        if (discordBotId === 'not-a-snowflake') {
          throw new WorldError(400, 'invalid_request', `Discord bot ID is malformed: ${discordBotId}`);
        }

        return {
          username: 'test-bot',
          avatarURL: `https://example.com/avatar/${discordBotId}.png`,
        };
      },
    });
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });

    const missingBot = await requestJson(app, '/api/admin/agents', {
      method: 'POST',
      headers: { 'X-Admin-Key': ADMIN_KEY },
      body: JSON.stringify({ discord_bot_id: '123456789012345678' }),
    });
    expect(missingBot.response.status).toBe(400);
    expect(missingBot.data).toEqual({
      error: 'invalid_request',
      message: 'Discord bot not found: 123456789012345678',
    });

    const malformedBotId = await requestJson(app, '/api/admin/agents', {
      method: 'POST',
      headers: { 'X-Admin-Key': ADMIN_KEY },
      body: JSON.stringify({ discord_bot_id: 'not-a-snowflake' }),
    });
    expect(malformedBotId.response.status).toBe(400);
    expect(malformedBotId.data).toEqual({
      error: 'invalid_request',
      message: 'Discord bot ID is malformed: not-a-snowflake',
    });
  });

  it('wires action, conversation, and admin server event endpoints', async () => {
    const { engine } = createTestWorld();
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });

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
      body: JSON.stringify({ message: 'Hi Alice' }),
    });
    expect(accepted.data).toEqual({ status: 'ok' });

    // advance interval timer so Alice gets her turn
    vi.advanceTimersByTime(500);

    const spoke = await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ message: 'Thanks Bob', next_speaker_agent_id: bob.data.agent_id }),
    });
    expect(spoke.response.status).toBe(200);
    expect(spoke.data.turn).toBe(3);

    // advance interval timer so Bob gets his turn
    vi.advanceTimersByTime(500);

    const ended = await requestJson(app, '/api/agents/conversation/end', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ message: 'Goodbye Alice', next_speaker_agent_id: alice.data.agent_id }),
    });
    expect(ended.response.status).toBe(200);
    expect(ended.data.turn).toBe(4);

    const fired = await requestJson(app, '/api/admin/server-events/fire', {
      method: 'POST',
      headers: { 'X-Admin-Key': ADMIN_KEY },
      body: JSON.stringify({ description: 'Dark clouds gather.' }),
    });
    expect(fired.response.status).toBe(200);
    expect(fired.data.server_event_id).toMatch(/^server-event-/);
  });

  it('emits info-request events for notification-based read endpoints', async () => {
    const { engine } = createTestWorld();
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });
    const registered = await registerAgent(app, 'alice');
    await requestJson(app, '/api/agents/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
    });

    const eventTypes: string[] = [];
    const unsubscribe = engine.eventBus.onAny((event) => {
      eventTypes.push(event.type);
    });

    await requestJson(app, '/api/agents/perception', {
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
    });
    await requestJson(app, '/api/agents/actions', {
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
    });
    await requestJson(app, '/api/agents/map', {
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
    });
    await requestJson(app, '/api/agents/world-agents', {
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
    });
    unsubscribe();

    expect(eventTypes).toContain('perception_requested');
    expect(eventTypes).toContain('available_actions_requested');
    expect(eventTypes).toContain('map_info_requested');
    expect(eventTypes).toContain('world_agents_info_requested');
  });

  it('accepts conversation leave without a request body', async () => {
    const { engine } = createTestWorld({
      config: {
        conversation: {
          inactive_check_turns: 1,
        },
      },
    });
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });

    const alice = await registerAgent(app, 'alice');
    const bob = await registerAgent(app, 'bob');
    const carol = await registerAgent(app, 'carol');
    await requestJson(app, '/api/agents/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
    });
    await requestJson(app, '/api/agents/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
    });
    await requestJson(app, '/api/agents/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${carol.data.api_key}` },
    });

    engine.state.setNode(alice.data.agent_id, '3-1');
    engine.state.setNode(bob.data.agent_id, '3-2');
    engine.state.setNode(carol.data.agent_id, '3-2');

    const started = await requestJson(app, '/api/agents/conversation/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ target_agent_id: bob.data.agent_id, message: 'Hello Bob' }),
    });
    expect(started.response.status).toBe(200);

    const accepted = await requestJson(app, '/api/agents/conversation/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ message: 'Hi Alice' }),
    });
    expect(accepted.response.status).toBe(200);

    vi.advanceTimersByTime(500);
    const joined = await requestJson(app, '/api/agents/conversation/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${carol.data.api_key}` },
      body: JSON.stringify({ conversation_id: started.data.conversation_id }),
    });
    expect(joined.response.status).toBe(200);

    const spoke = await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ message: 'Bob, your turn', next_speaker_agent_id: bob.data.agent_id }),
    });
    expect(spoke.response.status).toBe(200);

    vi.advanceTimersByTime(500);
    const bobSpoke = await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ message: 'Alice, continue', next_speaker_agent_id: alice.data.agent_id }),
    });
    expect(bobSpoke.response.status).toBe(200);

    vi.advanceTimersByTime(500);
    const left = await requestJson(app, '/api/agents/conversation/leave', {
      method: 'POST',
      headers: { Authorization: `Bearer ${carol.data.api_key}` },
    });
    expect(left.response.status).toBe(200);
    expect(left.data).toEqual({ status: 'ok' });
  });

  it('accepts conversation join via API and rejects duplicate join', async () => {
    const { engine } = createTestWorld();
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });

    const alice = await registerAgent(app, 'alice');
    const bob = await registerAgent(app, 'bob');
    const carol = await registerAgent(app, 'carol');
    await requestJson(app, '/api/agents/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
    });
    await requestJson(app, '/api/agents/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
    });
    await requestJson(app, '/api/agents/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${carol.data.api_key}` },
    });

    engine.state.setNode(alice.data.agent_id, '3-1');
    engine.state.setNode(bob.data.agent_id, '3-2');
    engine.state.setNode(carol.data.agent_id, '3-2');

    const started = await requestJson(app, '/api/agents/conversation/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ target_agent_id: bob.data.agent_id, message: 'Hello Bob' }),
    });
    expect(started.response.status).toBe(200);

    const accepted = await requestJson(app, '/api/agents/conversation/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ message: 'Hi Alice' }),
    });
    expect(accepted.response.status).toBe(200);

    vi.advanceTimersByTime(500);

    // Carol joins via API
    const joined = await requestJson(app, '/api/agents/conversation/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${carol.data.api_key}` },
      body: JSON.stringify({ conversation_id: started.data.conversation_id }),
    });
    expect(joined.response.status).toBe(200);

    // Duplicate join should be rejected
    const duplicateJoin = await requestJson(app, '/api/agents/conversation/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${carol.data.api_key}` },
      body: JSON.stringify({ conversation_id: started.data.conversation_id }),
    });
    expect(duplicateJoin.response.status).toBe(409);
    expect(duplicateJoin.data.error).toBe('state_conflict');
  });

  it('accepts conversation stay via API', async () => {
    const { engine } = createTestWorld({
      config: {
        conversation: {
          inactive_check_turns: 1,
        },
      },
    });
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });

    const alice = await registerAgent(app, 'alice');
    const bob = await registerAgent(app, 'bob');
    const carol = await registerAgent(app, 'carol');
    await requestJson(app, '/api/agents/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
    });
    await requestJson(app, '/api/agents/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
    });
    await requestJson(app, '/api/agents/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${carol.data.api_key}` },
    });

    engine.state.setNode(alice.data.agent_id, '3-1');
    engine.state.setNode(bob.data.agent_id, '3-2');
    engine.state.setNode(carol.data.agent_id, '3-2');

    const started = await requestJson(app, '/api/agents/conversation/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ target_agent_id: bob.data.agent_id, message: 'Hello Bob' }),
    });
    expect(started.response.status).toBe(200);

    const accepted = await requestJson(app, '/api/agents/conversation/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ message: 'Hi Alice' }),
    });
    expect(accepted.response.status).toBe(200);

    vi.advanceTimersByTime(500);
    await requestJson(app, '/api/agents/conversation/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${carol.data.api_key}` },
      body: JSON.stringify({ conversation_id: started.data.conversation_id }),
    });

    // Trigger inactive check: alice speaks, then bob speaks
    await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ message: 'Bob, your turn', next_speaker_agent_id: bob.data.agent_id }),
    });
    vi.advanceTimersByTime(500);
    await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ message: 'Alice, continue', next_speaker_agent_id: alice.data.agent_id }),
    });
    vi.advanceTimersByTime(500);

    // Carol stays
    const stayed = await requestJson(app, '/api/agents/conversation/stay', {
      method: 'POST',
      headers: { Authorization: `Bearer ${carol.data.api_key}` },
    });
    expect(stayed.response.status).toBe(200);
    expect(stayed.data).toEqual({ status: 'ok' });
  });

  it('accepts conversation leave with a message via API', async () => {
    const { engine } = createTestWorld({
      config: {
        conversation: {
          inactive_check_turns: 1,
        },
      },
    });
    const { app } = createApp(engine, { adminKey: ADMIN_KEY, publicBaseUrl: PUBLIC_BASE_URL });

    const alice = await registerAgent(app, 'alice');
    const bob = await registerAgent(app, 'bob');
    const carol = await registerAgent(app, 'carol');
    await requestJson(app, '/api/agents/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
    });
    await requestJson(app, '/api/agents/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
    });
    await requestJson(app, '/api/agents/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${carol.data.api_key}` },
    });

    engine.state.setNode(alice.data.agent_id, '3-1');
    engine.state.setNode(bob.data.agent_id, '3-2');
    engine.state.setNode(carol.data.agent_id, '3-2');

    const started = await requestJson(app, '/api/agents/conversation/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ target_agent_id: bob.data.agent_id, message: 'Hello Bob' }),
    });
    expect(started.response.status).toBe(200);

    const accepted = await requestJson(app, '/api/agents/conversation/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ message: 'Hi Alice' }),
    });
    expect(accepted.response.status).toBe(200);

    vi.advanceTimersByTime(500);
    await requestJson(app, '/api/agents/conversation/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${carol.data.api_key}` },
      body: JSON.stringify({ conversation_id: started.data.conversation_id }),
    });

    await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.data.api_key}` },
      body: JSON.stringify({ message: 'Bob, your turn', next_speaker_agent_id: bob.data.agent_id }),
    });
    vi.advanceTimersByTime(500);
    await requestJson(app, '/api/agents/conversation/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.data.api_key}` },
      body: JSON.stringify({ message: 'Alice, continue', next_speaker_agent_id: alice.data.agent_id }),
    });
    vi.advanceTimersByTime(500);

    // Carol leaves with a message
    const left = await requestJson(app, '/api/agents/conversation/leave', {
      method: 'POST',
      headers: { Authorization: `Bearer ${carol.data.api_key}` },
      body: JSON.stringify({ message: 'See you later!' }),
    });
    expect(left.response.status).toBe(200);
    expect(left.data).toEqual({ status: 'ok' });
  });
});
