import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { tool } from 'ai';
import { z } from 'zod';

import { isNotFoundError, listJsonFiles, readJsonFile, writeJsonFileAtomic } from '../persistence.js';

export interface ImportantMemory {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
}

export interface ImportantMemoryToolsOptions {
  dataDir: string;
  now?: () => Date;
  createId?: () => string;
}

function memoryFilePath(dataDir: string, id: string): string {
  return join(dataDir, 'memories', `${id}.json`);
}

async function readMemory(filePath: string): Promise<ImportantMemory> {
  return readJsonFile<ImportantMemory>(filePath);
}

function sortMemories(memories: ImportantMemory[]): ImportantMemory[] {
  return [...memories].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function saveImportantMemory(
  dataDir: string,
  params: {
    content: string;
    tags?: string[];
  },
  now: () => Date = () => new Date(),
  createId: () => string = randomUUID,
): Promise<ImportantMemory> {
  const memory: ImportantMemory = {
    id: createId(),
    content: params.content,
    tags: params.tags ?? [],
    createdAt: now().toISOString(),
  };

  await writeJsonFileAtomic(memoryFilePath(dataDir, memory.id), memory);
  return memory;
}

export async function listImportantMemories(dataDir: string): Promise<ImportantMemory[]> {
  const files = await listJsonFiles(join(dataDir, 'memories'));
  const memories = await Promise.all(files.map((fileName) => readMemory(join(dataDir, 'memories', fileName))));
  return sortMemories(memories);
}

export async function searchImportantMemories(dataDir: string, query: string): Promise<ImportantMemory[]> {
  const normalizedQuery = query.toLowerCase();
  const memories = await listImportantMemories(dataDir);

  return memories.filter(
    (memory) =>
      memory.content.toLowerCase().includes(normalizedQuery)
      || memory.tags.some((tag) => tag.toLowerCase().includes(normalizedQuery)),
  );
}

export async function deleteImportantMemory(dataDir: string, id: string): Promise<boolean> {
  try {
    await rm(memoryFilePath(dataDir, id), { force: false });
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

export function createImportantMemoryTools({
  dataDir,
  now = () => new Date(),
  createId = randomUUID,
}: ImportantMemoryToolsOptions) {
  return {
    save_memory: tool({
      description:
        'Save important long-term memory about the world, such as relationships, promises, places, or discoveries.',
      inputSchema: z.object({
        content: z.string().min(1).describe('Memory content to store'),
        tags: z.array(z.string()).optional().describe('Optional search tags such as names or locations'),
      }),
      execute: async ({ content, tags }) => {
        const memory = await saveImportantMemory(dataDir, { content, tags }, now, createId);
        return {
          success: true,
          id: memory.id,
        };
      },
    }),

    search_memories: tool({
      description: 'Search saved important memories using a keyword or phrase.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Search keyword'),
      }),
      execute: async ({ query }) => ({
        results: await searchImportantMemories(dataDir, query),
      }),
    }),

    list_memories: tool({
      description: 'List every saved important memory.',
      inputSchema: z.object({}),
      execute: async () => ({
        memories: await listImportantMemories(dataDir),
      }),
    }),

    delete_memory: tool({
      description: 'Delete an important memory that is no longer needed.',
      inputSchema: z.object({
        id: z.string().min(1).describe('Memory ID to delete'),
      }),
      execute: async ({ id }) => ({
        success: true,
        deleted: await deleteImportantMemory(dataDir, id),
      }),
    }),
  };
}
