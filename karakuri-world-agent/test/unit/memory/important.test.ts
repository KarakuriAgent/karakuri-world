import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  deleteImportantMemory,
  listImportantMemories,
  saveImportantMemory,
  searchImportantMemories,
} from '../../../src/memory/important.js';

const tempDirs: string[] = [];

async function createTempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'karakuri-world-agent-memory-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('important memory', () => {
  it('saves, searches, lists, and deletes important memories', async () => {
    const dataDir = await createTempDataDir();

    const first = await saveImportantMemory(
      dataDir,
      {
        content: 'North forest is dangerous at night.',
        tags: ['forest', 'danger'],
      },
      () => new Date('2026-03-16T10:00:00.000Z'),
      () => 'memory-1',
    );

    const second = await saveImportantMemory(
      dataDir,
      {
        content: 'Mina knows where the blacksmith lives.',
        tags: ['mina', 'blacksmith'],
      },
      () => new Date('2026-03-16T12:00:00.000Z'),
      () => 'memory-2',
    );

    expect(first.id).toBe('memory-1');
    expect(second.id).toBe('memory-2');

    await expect(searchImportantMemories(dataDir, 'FOREST')).resolves.toEqual([first]);
    await expect(searchImportantMemories(dataDir, 'mina')).resolves.toEqual([second]);
    await expect(listImportantMemories(dataDir)).resolves.toEqual([second, first]);

    await expect(deleteImportantMemory(dataDir, 'memory-1')).resolves.toBe(true);
    await expect(deleteImportantMemory(dataDir, 'missing-memory')).resolves.toBe(false);
    await expect(listImportantMemories(dataDir)).resolves.toEqual([second]);
  });
});
