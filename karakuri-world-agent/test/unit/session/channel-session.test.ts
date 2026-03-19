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

    const store = new ChannelSessionStore({ dataDir });

    await store.restoreFromDisk();

    const session = store.getOrCreateSession('channel-1');
    await session.addUserMessage('Hello there');
    await session.addAssistantMessage('Greetings');

    const restoredStore = new ChannelSessionStore({ dataDir });

    await restoredStore.restoreFromDisk();

    const restored = restoredStore.getSessionData('channel-1');
    expect(restored).toBeDefined();
    expect(restored!.channelId).toBe('channel-1');
    expect(restored!.messages).toEqual([
      { role: 'user', content: 'Hello there' },
      { role: 'assistant', content: 'Greetings' },
    ]);
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
    });

    await store.restoreFromDisk();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(store.getSessionData('broken')).toBeUndefined();
  });
});
