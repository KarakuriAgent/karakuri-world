import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  ALTERNATE_SAMPLE_PNG_BYTES,
  createJpegAvatarFile,
  createPngAvatarFile,
  SAMPLE_JPEG_BYTES,
  SAMPLE_PNG_BYTES,
} from '../helpers/avatar-fixtures.js';
import { createTestWorld } from '../helpers/test-world.js';

const ADMIN_KEY = 'test-admin-key';
const CONFIG_PATH = './config/example.yaml';
const PUBLIC_BASE_URL = 'http://localhost:3000';
const tempDirs: string[] = [];

type JsonResult = {
  response: Response;
  data: any;
};

type FetchableApp = {
  fetch: (request: Request) => Response | Promise<Response>;
};

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karakuri-world-avatar-'));
  tempDirs.push(dir);
  return dir;
}

async function request(app: FetchableApp, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers ?? {});
  if (init?.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return app.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers,
    }),
  );
}

async function requestJson(app: FetchableApp, path: string, init?: RequestInit): Promise<JsonResult> {
  const response = await request(app, path, init);
  const contentType = response.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, data };
}

async function registerAgent(app: FetchableApp, body: NonNullable<RequestInit['body']>, headers?: RequestInit['headers']): Promise<JsonResult> {
  return requestJson(app, '/api/admin/agents', {
    method: 'POST',
    headers: { 'X-Admin-Key': ADMIN_KEY, ...(headers ?? {}) },
    body,
  });
}

async function registerAgentWithAvatar(app: FetchableApp): Promise<JsonResult> {
  const form = new FormData();
  form.set('agent_name', 'alice');
  form.set('agent_label', 'Alice');
  form.set('discord_bot_id', 'bot-alice');
  form.set('avatar', createPngAvatarFile());
  return registerAgent(app, form);
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('avatar integration', () => {
  it('registers agents with multipart avatars, lists has_avatar, and serves avatars without auth', async () => {
    const dataDir = createTempDir();
    const { engine } = createTestWorld({ dataDir });
    const { app } = createApp(engine, {
      adminKey: ADMIN_KEY,
      configPath: CONFIG_PATH,
      dataDir,
      publicBaseUrl: PUBLIC_BASE_URL,
    });

    const registered = await registerAgentWithAvatar(app);
    expect(registered.response.status).toBe(201);

    const avatarPath = join(dataDir, 'avatars', `${registered.data.agent_id}.png`);
    expect(existsSync(avatarPath)).toBe(true);
    expect(readFileSync(avatarPath)).toEqual(SAMPLE_PNG_BYTES);

    const listed = await requestJson(app, '/api/admin/agents', {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(listed.data.agents).toEqual([
      {
        agent_id: registered.data.agent_id,
        agent_name: 'alice',
        agent_label: 'Alice',
        discord_bot_id: 'bot-alice',
        has_avatar: true,
        is_logged_in: false,
      },
    ]);

    const avatarResponse = await request(app, `/api/admin/agents/${registered.data.agent_id}/avatar`);
    expect(avatarResponse.status).toBe(200);
    expect(avatarResponse.headers.get('cache-control')).toBe('no-store');
    expect(avatarResponse.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await avatarResponse.arrayBuffer())).toEqual(SAMPLE_PNG_BYTES);
  });

  it('updates and deletes avatars and rebroadcasts snapshots for logged-in agents', async () => {
    const dataDir = createTempDir();
    const { engine } = createTestWorld({ dataDir });
    const { app, websocketManager } = createApp(engine, {
      adminKey: ADMIN_KEY,
      configPath: CONFIG_PATH,
      dataDir,
      publicBaseUrl: PUBLIC_BASE_URL,
    });
    const broadcastSnapshot = vi.spyOn(websocketManager, 'broadcastSnapshot');

    const registered = await registerAgent(
      app,
      JSON.stringify({ agent_name: 'alice', agent_label: 'Alice', discord_bot_id: 'bot-alice' }),
    );
    const agentId = registered.data.agent_id as string;

    const joined = await requestJson(app, '/api/agents/login', {
      method: 'POST',
      headers: { Authorization: `Bearer ${registered.data.api_key}` },
    });
    expect(joined.response.status).toBe(200);

    const pngForm = new FormData();
    pngForm.set('avatar', createPngAvatarFile());
    const setPng = await requestJson(app, `/api/admin/agents/${agentId}/avatar`, {
      method: 'PUT',
      headers: { 'X-Admin-Key': ADMIN_KEY },
      body: pngForm,
    });
    expect(setPng.response.status).toBe(200);
    expect(broadcastSnapshot).toHaveBeenCalledTimes(1);

    const snapshot = await requestJson(app, '/api/snapshot', {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(snapshot.data.agents).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        avatar_url: `/api/admin/agents/${agentId}/avatar`,
      }),
    ]);

    const pngPath = join(dataDir, 'avatars', `${agentId}.png`);
    expect(existsSync(pngPath)).toBe(true);

    const jpegForm = new FormData();
    jpegForm.set('avatar', createJpegAvatarFile());
    const setJpeg = await requestJson(app, `/api/admin/agents/${agentId}/avatar`, {
      method: 'PUT',
      headers: { 'X-Admin-Key': ADMIN_KEY },
      body: jpegForm,
    });
    expect(setJpeg.response.status).toBe(200);
    expect(broadcastSnapshot).toHaveBeenCalledTimes(2);

    const jpegPath = join(dataDir, 'avatars', `${agentId}.jpg`);
    expect(existsSync(pngPath)).toBe(false);
    expect(existsSync(jpegPath)).toBe(true);

    const avatarResponse = await request(app, `/api/admin/agents/${agentId}/avatar`);
    expect(avatarResponse.status).toBe(200);
    expect(avatarResponse.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await avatarResponse.arrayBuffer())).toEqual(SAMPLE_JPEG_BYTES);

    const deleted = await requestJson(app, `/api/admin/agents/${agentId}/avatar`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(deleted.response.status).toBe(200);
    expect(broadcastSnapshot).toHaveBeenCalledTimes(3);
    expect(existsSync(jpegPath)).toBe(false);

    const snapshotAfterDelete = await requestJson(app, '/api/snapshot', {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(snapshotAfterDelete.data.agents[0].avatar_url).toBeUndefined();

    const listed = await requestJson(app, '/api/admin/agents', {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(listed.data.agents[0].has_avatar).toBe(false);

    const missingAvatar = await requestJson(app, `/api/admin/agents/${agentId}/avatar`);
    expect(missingAvatar.response.status).toBe(404);
  });

  it('removes avatar files when deleting agents', async () => {
    const dataDir = createTempDir();
    const { engine } = createTestWorld({ dataDir });
    const { app } = createApp(engine, {
      adminKey: ADMIN_KEY,
      configPath: CONFIG_PATH,
      dataDir,
      publicBaseUrl: PUBLIC_BASE_URL,
    });

    const registered = await registerAgentWithAvatar(app);
    const avatarPath = join(dataDir, 'avatars', `${registered.data.agent_id}.png`);
    expect(existsSync(avatarPath)).toBe(true);

    const deleted = await requestJson(app, `/api/admin/agents/${registered.data.agent_id}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(deleted.response.status).toBe(200);
    expect(existsSync(avatarPath)).toBe(false);
  });

  it('fails agent registration when avatar persistence fails', async () => {
    const tempRoot = createTempDir();
    const dataDir = join(tempRoot, 'data-root');
    writeFileSync(dataDir, 'not a directory');
    const { engine } = createTestWorld({ dataDir });
    const { app } = createApp(engine, {
      adminKey: ADMIN_KEY,
      configPath: CONFIG_PATH,
      dataDir,
      publicBaseUrl: PUBLIC_BASE_URL,
    });

    const registered = await registerAgentWithAvatar(app);
    expect(registered.response.status).toBe(500);

    const listed = await requestJson(app, '/api/admin/agents', {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(listed.response.status).toBe(200);
    expect(listed.data.agents).toEqual([]);
  });

  it('surfaces registration rollback failures after avatar persistence fails', async () => {
    const tempRoot = createTempDir();
    const dataDir = join(tempRoot, 'data-root');
    writeFileSync(dataDir, 'not a directory');
    let persistCount = 0;
    const { engine } = createTestWorld({
      dataDir,
      engineOptions: {
        onRegistrationChanged: () => {
          persistCount += 1;
          if (persistCount === 2) {
            throw new Error('rollback save failed');
          }
        },
      },
    });
    const { app } = createApp(engine, {
      adminKey: ADMIN_KEY,
      configPath: CONFIG_PATH,
      dataDir,
      publicBaseUrl: PUBLIC_BASE_URL,
    });

    const registered = await registerAgentWithAvatar(app);
    expect(registered.response.status).toBe(500);

    expect(console.error).toHaveBeenCalledTimes(1);
    const loggedError = vi.mocked(console.error).mock.calls[0]?.[0];
    expect(loggedError).toBeInstanceOf(AggregateError);
    expect((loggedError as AggregateError).message).toBe(
      'Failed to roll back agent registration after avatar persistence failed.',
    );
    expect((loggedError as AggregateError).errors[1]).toEqual(expect.objectContaining({ message: 'rollback save failed' }));
  });

  it('restores the previous avatar when a same-extension replacement fails to persist', async () => {
    const dataDir = createTempDir();
    let persistCount = 0;
    const { engine } = createTestWorld({
      dataDir,
      engineOptions: {
        onRegistrationChanged: () => {
          persistCount += 1;
          if (persistCount === 3) {
            throw new Error('persist failed');
          }
        },
      },
    });
    const { app } = createApp(engine, {
      adminKey: ADMIN_KEY,
      configPath: CONFIG_PATH,
      dataDir,
      publicBaseUrl: PUBLIC_BASE_URL,
    });

    const registered = await registerAgent(
      app,
      JSON.stringify({ agent_name: 'alice', agent_label: 'Alice', discord_bot_id: 'bot-alice' }),
    );
    const agentId = registered.data.agent_id as string;

    const initialForm = new FormData();
    initialForm.set('avatar', createPngAvatarFile());
    const initialAvatar = await requestJson(app, `/api/admin/agents/${agentId}/avatar`, {
      method: 'PUT',
      headers: { 'X-Admin-Key': ADMIN_KEY },
      body: initialForm,
    });
    expect(initialAvatar.response.status).toBe(200);

    const avatarPath = join(dataDir, 'avatars', `${agentId}.png`);
    expect(readFileSync(avatarPath)).toEqual(SAMPLE_PNG_BYTES);

    const replacementForm = new FormData();
    replacementForm.set('avatar', createPngAvatarFile('replacement.png', ALTERNATE_SAMPLE_PNG_BYTES));
    const failedReplacement = await requestJson(app, `/api/admin/agents/${agentId}/avatar`, {
      method: 'PUT',
      headers: { 'X-Admin-Key': ADMIN_KEY },
      body: replacementForm,
    });
    expect(failedReplacement.response.status).toBe(500);
    expect(readFileSync(avatarPath)).toEqual(SAMPLE_PNG_BYTES);
    expect(readdirSync(join(dataDir, 'avatars'))).toEqual([`${agentId}.png`]);

    const avatarResponse = await request(app, `/api/admin/agents/${agentId}/avatar`);
    expect(avatarResponse.status).toBe(200);
    expect(Buffer.from(await avatarResponse.arrayBuffer())).toEqual(SAMPLE_PNG_BYTES);
  });

  it('rejects tampered avatar filenames that escape the avatars directory', async () => {
    const dataDir = createTempDir();
    const { engine } = createTestWorld({ dataDir });
    const { app } = createApp(engine, {
      adminKey: ADMIN_KEY,
      configPath: CONFIG_PATH,
      dataDir,
      publicBaseUrl: PUBLIC_BASE_URL,
    });

    const registered = await registerAgent(
      app,
      JSON.stringify({ agent_name: 'alice', agent_label: 'Alice', discord_bot_id: 'bot-alice' }),
    );
    const agentId = registered.data.agent_id as string;
    const registration = engine.getAgentById(agentId)!;
    registration.avatar_filename = '../escape.png';
    writeFileSync(join(dataDir, 'escape.png'), SAMPLE_PNG_BYTES);

    const avatarResponse = await requestJson(app, `/api/admin/agents/${agentId}/avatar`);
    expect(avatarResponse.response.status).toBe(500);
    expect(avatarResponse.data).toEqual({
      error: 'invalid_config',
      message: 'Invalid avatar filename.',
    });
  });
});
