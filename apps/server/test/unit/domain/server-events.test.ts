import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadServerEvents, saveServerEvents } from '../../../src/storage/server-events.js';
import type { ServerEvent } from '../../../src/types/server-event.js';
import { createTestWorld } from '../../helpers/test-world.js';

const scratchDir = join(process.cwd(), 'test', '.scratch', 'server-events-storage');

function scratchPath(fileName: string): string {
  return join(scratchDir, fileName);
}

describe('server events domain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('rolls back in-memory creation when persistence fails', () => {
    const persistenceError = new Error('persist failed');
    const { engine } = createTestWorld({
      engineOptions: {
        onServerEventsChanged: () => {
          throw persistenceError;
        },
      },
    });

    expect(() => engine.createServerEvent('Festival')).toThrow(persistenceError);
    expect(engine.state.serverEvents.list()).toEqual([]);
  });

  it('rolls back in-memory clearing when persistence fails', () => {
    let shouldThrow = false;
    const { engine } = createTestWorld({
      engineOptions: {
        onServerEventsChanged: () => {
          if (shouldThrow) {
            throw new Error('persist failed');
          }
        },
      },
    });
    const createdResponse = engine.createServerEvent('Festival');
    const created = engine.state.serverEvents.get(createdResponse.server_event_id);
    if (!created) {
      throw new Error('created event missing');
    }

    shouldThrow = true;

    expect(() => engine.clearServerEvent(createdResponse.server_event_id)).toThrow('persist failed');
    expect(engine.state.serverEvents.get(createdResponse.server_event_id)).toEqual(created);
    expect(engine.state.serverEvents.listActive()).toEqual([created]);
  });

  it('round-trips active server events through JSON storage and restores them at startup', () => {
    const filePath = scratchPath('server-events.json');
    const event: ServerEvent = {
      server_event_id: 'server-event-1',
      description: 'Festival',
      created_at: 1,
      cleared_at: null,
    };

    saveServerEvents(filePath, [event]);

    expect(existsSync(filePath)).toBe(true);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      version: 1,
      events: [event],
    });
    const restored = loadServerEvents(filePath);
    const { engine } = createTestWorld({ engineOptions: { initialServerEvents: restored } });

    expect(engine.state.serverEvents.listActive()).toEqual([event]);
  });

  it('does not interrupt in-action, in-conversation, or in-transfer agents', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    const carol = await engine.registerAgent({ discord_bot_id: 'bot-carol' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await engine.loginAgent(carol.agent_id);
    engine.state.setState(alice.agent_id, 'in_action');
    engine.state.setState(bob.agent_id, 'in_conversation');
    engine.state.setState(carol.agent_id, 'in_transfer');
    engine.state.setActiveTransfer(carol.agent_id, 'transfer-1');

    engine.createServerEvent('Festival');

    expect(engine.state.getLoggedIn(alice.agent_id)).toMatchObject({
      state: 'in_action',
      active_server_announcement_id: null,
      pending_server_announcement_ids: [],
    });
    expect(engine.state.getLoggedIn(bob.agent_id)).toMatchObject({
      state: 'in_conversation',
      active_server_announcement_id: null,
      pending_server_announcement_ids: [],
    });
    expect(engine.state.getLoggedIn(carol.agent_id)).toMatchObject({
      state: 'in_transfer',
      active_transfer_id: 'transfer-1',
      active_server_announcement_id: null,
      pending_server_announcement_ids: [],
    });
  });
});
