import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readDiaryEntry, readRecentDiaryEntries, writeDiaryEntry } from '../../../src/memory/diary.js';

const tempDirs: string[] = [];

async function createTempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'karakuri-world-agent-diary-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('diary memory', () => {
  it('appends multiple entries on the same day', async () => {
    const dataDir = await createTempDataDir();
    const now = () => new Date('2026-03-16T12:00:00.000Z');

    await writeDiaryEntry(dataDir, 'Explored the town square.', now);
    const entry = await writeDiaryEntry(dataDir, 'Talked to the blacksmith.', now);

    expect(entry).toEqual({
      date: '2026-03-16',
      entries: ['Explored the town square.', 'Talked to the blacksmith.'],
      updatedAt: '2026-03-16T12:00:00.000Z',
    });

    await expect(readDiaryEntry(dataDir, '2026-03-16')).resolves.toEqual(entry);
  });

  it('returns recent entries in reverse chronological order and skips missing days', async () => {
    const dataDir = await createTempDataDir();

    await writeDiaryEntry(dataDir, 'Visited the library.', () => new Date('2026-03-16T09:00:00.000Z'));
    await writeDiaryEntry(dataDir, 'Went fishing.', () => new Date('2026-03-14T09:00:00.000Z'));

    const entries = await readRecentDiaryEntries(dataDir, () => new Date('2026-03-16T21:00:00.000Z'));

    expect(entries.map((entry) => entry.date)).toEqual(['2026-03-16', '2026-03-14']);
  });
});
