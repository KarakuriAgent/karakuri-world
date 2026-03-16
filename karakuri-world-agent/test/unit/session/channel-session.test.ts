import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChannelSessionStore } from '../../../src/session/channel-session.js';

const tempDirs: string[] = [];

async function createTempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'karakuri-world-agent-sessions-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('channel session store', () => {
  it('persists and restores session messages', async () => {
    const dataDir = await createTempDataDir();
    let now = 1_000;

    const store = new ChannelSessionStore({
      dataDir,
      now: () => now,
      ttlMs: 10_000,
    });

    await store.restoreFromDisk();

    const session = store.getOrCreateSession('channel-1');
    await session.addUserMessage('Hello there');

    now = 2_000;
    await session.addAssistantMessage('Greetings');
    await store.close();

    const restoredStore = new ChannelSessionStore({
      dataDir,
      now: () => now,
      ttlMs: 10_000,
    });

    await restoredStore.restoreFromDisk();

    expect(restoredStore.getSessionData('channel-1')).toEqual({
      channelId: 'channel-1',
      messages: [
        { role: 'user', content: 'Hello there' },
        { role: 'assistant', content: 'Greetings' },
      ],
      lastActivity: 2_000,
    });

    await restoredStore.close();
  });

  it('removes expired sessions during restore and cleanup', async () => {
    const dataDir = await createTempDataDir();
    const sessionsDir = join(dataDir, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, 'expired.json'),
      JSON.stringify({
        channelId: 'expired',
        messages: [{ role: 'user', content: 'old message' }],
        lastActivity: 0,
      }),
      'utf8',
    );

    let now = 20_000;
    const restoredStore = new ChannelSessionStore({
      dataDir,
      now: () => now,
      ttlMs: 10_000,
    });

    await restoredStore.restoreFromDisk();

    expect(restoredStore.getSessionData('expired')).toBeUndefined();
    expect(existsSync(join(sessionsDir, 'expired.json'))).toBe(false);

    const activeSession = restoredStore.getOrCreateSession('active');
    await activeSession.addUserMessage('still here');

    now = 40_000;
    await restoredStore.cleanupExpiredSessions();

    expect(restoredStore.getSessionData('active')).toBeUndefined();
    expect(existsSync(join(sessionsDir, 'active.json'))).toBe(false);

    await restoredStore.close();
  });

  it('warns and skips corrupt persisted session files', async () => {
    const dataDir = await createTempDataDir();
    const sessionsDir = join(dataDir, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'broken.json'), '{not valid json', 'utf8');

    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    };

    const store = new ChannelSessionStore({
      dataDir,
      logger,
      now: () => 0,
      ttlMs: 10_000,
    });

    await store.restoreFromDisk();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(store.getSessionData('broken')).toBeUndefined();

    await store.close();
  });
});
