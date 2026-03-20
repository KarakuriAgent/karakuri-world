import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  appendMemoryPromptContext,
  buildMemoryPromptContext,
} from '../../../src/memory/prompt-context.js';
import { writeDiaryEntry } from '../../../src/memory/diary.js';
import { saveImportantMemory } from '../../../src/memory/important.js';

const tempDirs: string[] = [];

async function createTempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'karakuri-world-agent-memory-context-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('memory prompt context', () => {
  it('builds a system prompt from important memories and recent diary entries', async () => {
    const dataDir = await createTempDataDir();

    await saveImportantMemory(
      dataDir,
      {
        content: 'Mina promised to meet at the workshop tomorrow.',
        tags: ['mina', 'workshop'],
      },
      () => new Date('2026-03-16T10:00:00.000Z'),
      () => 'memory-1',
    );
    await saveImportantMemory(
      dataDir,
      {
        content: 'The north forest becomes dangerous after sunset.',
        tags: ['forest'],
      },
      () => new Date('2026-03-16T12:00:00.000Z'),
      () => 'memory-2',
    );

    await writeDiaryEntry(dataDir, 'Visited the workshop and checked the tools.', () => new Date('2026-03-16T09:00:00.000Z'));
    await writeDiaryEntry(dataDir, 'Talked with Mina about the broken windmill.', () => new Date('2026-03-16T10:00:00.000Z'));
    await writeDiaryEntry(dataDir, 'Took shelter from the sudden rain.', () => new Date('2026-03-15T10:00:00.000Z'));

    const prompt = await buildMemoryPromptContext({
      dataDir,
      now: () => new Date('2026-03-16T21:00:00.000Z'),
      importantMemoryLimit: 2,
      recentDiaryEntryLimit: 2,
    });

    expect(prompt).toContain('## 重要なメモ');
    expect(prompt).toContain('The north forest becomes dangerous after sunset.');
    expect(prompt).toContain('Mina promised to meet at the workshop tomorrow.');
    expect(prompt).toContain('## 直近の日記');
    expect(prompt).toContain('[2026-03-16] Visited the workshop and checked the tools.');
    expect(prompt).toContain('[2026-03-16] Talked with Mina about the broken windmill.');
    expect(prompt).not.toContain('Took shelter from the sudden rain.');
  });

  it('returns the original system prompt when no memory context exists', () => {
    expect(appendMemoryPromptContext('Base system prompt')).toBe('Base system prompt');
  });

  it('concatenates memory context onto the existing system prompt', () => {
    expect(appendMemoryPromptContext('Base system prompt', '## 重要なメモ\n- [2026-03-16] Example')).toBe(
      'Base system prompt\n\n---\n\n## 重要なメモ\n- [2026-03-16] Example',
    );
  });
});
