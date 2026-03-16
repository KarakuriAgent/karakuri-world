import { join, resolve } from 'node:path';

import { tool } from 'ai';
import { z } from 'zod';

import { isNotFoundError, readJsonFile, writeJsonFileAtomic } from '../persistence.js';

export interface DiaryEntry {
  date: string;
  entries: string[];
  updatedAt: string;
}

export interface DiaryToolsOptions {
  dataDir: string;
  now?: () => Date;
  recentDays?: number;
}

const DEFAULT_RECENT_DAYS = 7;

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function diaryFilePath(dataDir: string, date: string): string {
  return join(dataDir, 'diary', `${date}.json`);
}

export async function readDiaryEntry(dataDir: string, date: string): Promise<DiaryEntry | null> {
  try {
    return await readJsonFile<DiaryEntry>(diaryFilePath(dataDir, date));
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

export async function writeDiaryEntry(
  dataDir: string,
  content: string,
  now: () => Date = () => new Date(),
): Promise<DiaryEntry> {
  const currentTime = now();
  const today = formatDate(currentTime);
  const existingEntry = await readDiaryEntry(dataDir, today);

  const nextEntry: DiaryEntry = existingEntry
    ? {
        ...existingEntry,
        entries: [...existingEntry.entries, content],
        updatedAt: currentTime.toISOString(),
      }
    : {
        date: today,
        entries: [content],
        updatedAt: currentTime.toISOString(),
      };

  await writeJsonFileAtomic(diaryFilePath(dataDir, today), nextEntry);
  return nextEntry;
}

export async function readRecentDiaryEntries(
  dataDir: string,
  now: () => Date = () => new Date(),
  recentDays = DEFAULT_RECENT_DAYS,
): Promise<DiaryEntry[]> {
  const entries: DiaryEntry[] = [];
  const currentDate = now();

  for (let offset = 0; offset < recentDays; offset += 1) {
    const date = new Date(currentDate);
    date.setUTCDate(date.getUTCDate() - offset);

    const entry = await readDiaryEntry(dataDir, formatDate(date));
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

export function createDiaryTools({
  dataDir,
  now = () => new Date(),
  recentDays = DEFAULT_RECENT_DAYS,
}: DiaryToolsOptions) {
  return {
    write_diary: tool({
      description:
        'Record today\'s actions and experiences in the world as a diary entry. '
        + 'Include where you went, who you talked to, what you did, and how you felt. '
        + 'Multiple calls on the same day append to the existing diary.',
      inputSchema: z.object({
        content: z.string().min(1).describe('Diary entry content'),
      }),
      execute: async ({ content }) => {
        const entry = await writeDiaryEntry(dataDir, content, now);

        return {
          success: true,
          date: entry.date,
          totalEntries: entry.entries.length,
        };
      },
    }),

    read_diary: tool({
      description: 'Read a diary entry for a specific date, or the most recent 7 diary files when no date is given.',
      inputSchema: z.object({
        date: z.string().optional().describe('Optional diary date in YYYY-MM-DD format'),
      }),
      execute: async ({ date }) => {
        if (date) {
          const entry = await readDiaryEntry(dataDir, date);
          return { entries: entry ? [entry] : [] };
        }

        return { entries: await readRecentDiaryEntries(dataDir, now, recentDays) };
      },
    }),
  };
}
