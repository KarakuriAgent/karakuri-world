import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { ModelMessage } from 'ai';
import { z } from 'zod';

import { KeyedTaskRunner } from '../keyed-task-runner.js';
import { isNotFoundError, listJsonFiles, readJsonFile, writeJsonFileAtomic } from '../persistence.js';

export const SESSION_TTL_MS = 30 * 60 * 1000;
export const SESSION_CLEANUP_INTERVAL_MS = 60_000;

const persistedMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.array(z.unknown())]),
  })
  .passthrough();

const sessionFileSchema = z.object({
  channelId: z.string().min(1),
  messages: z.array(persistedMessageSchema),
  lastActivity: z.number().int().nonnegative(),
});

export interface PersistedChannelSession {
  channelId: string;
  messages: ModelMessage[];
  lastActivity: number;
}

export interface ChannelSessionHandle {
  addAssistantMessage(text: string): Promise<void>;
  addUserMessage(text: string): Promise<void>;
  getMessages(): ModelMessage[];
  replaceMessages(messages: ModelMessage[]): Promise<void>;
}

export interface ChannelSessionStoreLogger {
  error(message: string, ...optionalParams: unknown[]): void;
  warn(message: string, ...optionalParams: unknown[]): void;
}

export interface ChannelSessionStoreOptions {
  cleanupIntervalMs?: number;
  dataDir: string;
  logger?: ChannelSessionStoreLogger;
  now?: () => number;
  ttlMs?: number;
}

export class ChannelSessionStore {
  private readonly cleanupIntervalMs: number;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private readonly logger: ChannelSessionStoreLogger;
  private readonly mutationQueue = new KeyedTaskRunner();
  private readonly now: () => number;
  private readonly sessions = new Map<string, PersistedChannelSession>();
  private readonly sessionsDir: string;
  private readonly ttlMs: number;

  constructor({
    cleanupIntervalMs = SESSION_CLEANUP_INTERVAL_MS,
    dataDir,
    logger = console,
    now = () => Date.now(),
    ttlMs = SESSION_TTL_MS,
  }: ChannelSessionStoreOptions) {
    this.cleanupIntervalMs = cleanupIntervalMs;
    this.logger = logger;
    this.now = now;
    this.sessionsDir = join(dataDir, 'sessions');
    this.ttlMs = ttlMs;
  }

  async restoreFromDisk(): Promise<void> {
    this.sessions.clear();

    const files = await listJsonFiles(this.sessionsDir);
    await Promise.all(
      files.map(async (fileName) => {
        const filePath = join(this.sessionsDir, fileName);

        try {
          const parsed = sessionFileSchema.parse(await readJsonFile<unknown>(filePath));
          const session: PersistedChannelSession = {
            channelId: parsed.channelId,
            messages: parsed.messages as ModelMessage[],
            lastActivity: parsed.lastActivity,
          };

          if (this.isExpired(session)) {
            await this.deletePersistedFile(filePath);
            return;
          }

          this.sessions.set(session.channelId, session);
        } catch (error) {
          this.logger.warn(`Ignoring corrupt session file: ${filePath}`, error);
        }
      }),
    );
  }

  startCleanupTimer(): void {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredSessions().catch((error) => {
        this.logger.error('Failed to clean up expired sessions', error);
      });
    }, this.cleanupIntervalMs);

    this.cleanupTimer.unref?.();
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  getOrCreateSession(channelId: string): ChannelSessionHandle {
    this.ensureSession(channelId);

    return {
      addAssistantMessage: async (text: string) => {
        await this.runMutation(channelId, (session) => {
          session.messages.push({ role: 'assistant', content: text });
        });
      },
      addUserMessage: async (text: string) => {
        await this.runMutation(channelId, (session) => {
          session.messages.push({ role: 'user', content: text });
        });
      },
      getMessages: () => structuredClone(this.ensureSession(channelId).messages),
      replaceMessages: async (messages: ModelMessage[]) => {
        await this.runMutation(channelId, (session) => {
          session.messages = structuredClone(messages);
        });
      },
    };
  }

  getSessionData(channelId: string): PersistedChannelSession | undefined {
    const session = this.sessions.get(channelId);
    return session ? structuredClone(session) : undefined;
  }

  async cleanupExpiredSessions(): Promise<void> {
    const expiredSessions = [...this.sessions.values()].filter((session) => this.isExpired(session));

    await Promise.all(
      expiredSessions.map(async (session) => {
        this.sessions.delete(session.channelId);
        await this.deletePersistedFile(this.sessionFilePath(session.channelId));
      }),
    );
  }

  private ensureSession(channelId: string): PersistedChannelSession {
    let session = this.sessions.get(channelId);

    if (!session) {
      session = {
        channelId,
        messages: [],
        lastActivity: this.now(),
      };

      this.sessions.set(channelId, session);
    }

    return session;
  }

  private isExpired(session: PersistedChannelSession): boolean {
    return this.now() - session.lastActivity >= this.ttlMs;
  }

  private sessionFilePath(channelId: string): string {
    return join(this.sessionsDir, `${channelId}.json`);
  }

  private async persistSession(session: PersistedChannelSession): Promise<void> {
    await writeJsonFileAtomic(this.sessionFilePath(session.channelId), session);
  }

  private async runMutation(
    channelId: string,
    mutate: (session: PersistedChannelSession) => void,
  ): Promise<void> {
    await this.mutationQueue.run(channelId, async () => {
      const session = this.ensureSession(channelId);
      mutate(session);
      session.lastActivity = this.now();
      await this.persistSession(session);
    });
  }

  private async deletePersistedFile(filePath: string): Promise<void> {
    try {
      await rm(filePath, { force: false });
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }
}
