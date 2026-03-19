import { readRecentDiaryEntries, type DiaryEntry } from './diary.js';
import { createLogger } from '../logger.js';
import { listImportantMemories, type ImportantMemory } from './important.js';

const DEFAULT_RECENT_DIARY_DAYS = 7;
const DEFAULT_RECENT_DIARY_ENTRY_LIMIT = 6;
const DEFAULT_IMPORTANT_MEMORY_LIMIT = 12;
const logger = createLogger('memory');

export interface MemoryPromptContextOptions {
  dataDir: string;
  now?: () => Date;
  recentDiaryDays?: number;
  recentDiaryEntryLimit?: number;
  importantMemoryLimit?: number;
}

function formatMemory(memory: ImportantMemory): string {
  const date = memory.createdAt.slice(0, 10);
  const tags = memory.tags.length > 0 ? ` (タグ: ${memory.tags.join(', ')})` : '';
  return `- [${date}] ${memory.content}${tags}`;
}

function sliceRecentDiaryEntries(entries: DiaryEntry[], maxEntries: number): DiaryEntry[] {
  const selected: DiaryEntry[] = [];
  let remaining = maxEntries;

  for (const entry of entries) {
    if (remaining <= 0) {
      break;
    }

    const recentEntries = entry.entries.slice(-remaining);
    if (recentEntries.length === 0) {
      continue;
    }

    selected.push({
      ...entry,
      entries: recentEntries,
    });
    remaining -= recentEntries.length;
  }

  return selected;
}

function formatDiaryEntries(entries: DiaryEntry[]): string[] {
  return entries.flatMap((entry) => entry.entries.map((content) => `- [${entry.date}] ${content}`));
}

export async function buildMemoryPromptContext({
  dataDir,
  now = () => new Date(),
  recentDiaryDays = DEFAULT_RECENT_DIARY_DAYS,
  recentDiaryEntryLimit = DEFAULT_RECENT_DIARY_ENTRY_LIMIT,
  importantMemoryLimit = DEFAULT_IMPORTANT_MEMORY_LIMIT,
}: MemoryPromptContextOptions): Promise<string | undefined> {
  const [importantMemories, recentDiaryEntries] = await Promise.all([
    listImportantMemories(dataDir),
    readRecentDiaryEntries(dataDir, now, recentDiaryDays),
  ]);

  const visibleMemories = importantMemories.slice(0, importantMemoryLimit);
  const visibleDiaryEntries = sliceRecentDiaryEntries(recentDiaryEntries, recentDiaryEntryLimit);
  const diaryCount = visibleDiaryEntries.reduce((count, entry) => count + entry.entries.length, 0);

  logger.debug('Memory prompt built', {
    memoryCount: visibleMemories.length,
    diaryCount,
  });

  if (visibleMemories.length === 0 && visibleDiaryEntries.length === 0) {
    return undefined;
  }

  const sections = [
    '以下はこの返信の前に想起しておくべきあなた自身の記録です。ユーザー入力ではなく、長期記憶と直近の行動記録として必要に応じて参照してください。',
  ];

  if (visibleMemories.length > 0) {
    sections.push('## 重要なメモ');
    sections.push(...visibleMemories.map(formatMemory));
  }

  if (visibleDiaryEntries.length > 0) {
    sections.push('## 直近の日記');
    sections.push(...formatDiaryEntries(visibleDiaryEntries));
  }

  return sections.join('\n');
}

export function appendMemoryPromptContext(baseInstructions: string, memoryPrompt?: string): string {
  const trimmedMemoryPrompt = memoryPrompt?.trim();
  if (!trimmedMemoryPrompt) {
    return baseInstructions;
  }

  return `${baseInstructions}\n\n---\n\n${trimmedMemoryPrompt}`;
}
