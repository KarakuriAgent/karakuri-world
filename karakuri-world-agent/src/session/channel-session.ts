import { join } from 'node:path';

import type { ModelMessage } from 'ai';
import { z } from 'zod';

import { KeyedTaskRunner } from '../keyed-task-runner.js';
import { createLogger } from '../logger.js';
import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from '../persistence.js';

const moduleLogger = createLogger('session');

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
  dataDir: string;
  logger?: ChannelSessionStoreLogger;
}

export class ChannelSessionStore {
  private readonly logger: ChannelSessionStoreLogger;
  private readonly mutationQueue = new KeyedTaskRunner();
  private readonly sessions = new Map<string, PersistedChannelSession>();
  private readonly sessionsDir: string;

  constructor({
    dataDir,
    logger = console,
  }: ChannelSessionStoreOptions) {
    this.logger = logger;
    this.sessionsDir = join(dataDir, 'sessions');
  }

  async restoreFromDisk(): Promise<void> {
    this.sessions.clear();

    const files = await listJsonFiles(this.sessionsDir);
    await Promise.all(
      files.map(async (fileName) => {
        const filePath = join(this.sessionsDir, fileName);
        const parsed = await (async (): Promise<z.infer<typeof sessionFileSchema> | undefined> => {
          try {
            return sessionFileSchema.parse(await readJsonFile<unknown>(filePath));
          } catch (error) {
            this.logger.warn(`Ignoring corrupt session file: ${filePath}`, error);
            return undefined;
          }
        })();

        if (!parsed) {
          return;
        }

        const session: PersistedChannelSession = {
          channelId: parsed.channelId,
          messages: parsed.messages as ModelMessage[],
          lastActivity: parsed.lastActivity,
        };

        this.sessions.set(session.channelId, session);
      }),
    );

    moduleLogger.info('Sessions restored', { count: this.sessions.size });
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

  private ensureSession(channelId: string): PersistedChannelSession {
    let session = this.sessions.get(channelId);

    if (!session) {
      session = {
        channelId,
        messages: [],
        lastActivity: Date.now(),
      };

      this.sessions.set(channelId, session);
    }

    return session;
  }

  private sessionFilePath(channelId: string): string {
    return join(this.sessionsDir, `${channelId}.json`);
  }

  private async persistSession(session: PersistedChannelSession): Promise<void> {
    try {
      await writeJsonFileAtomic(this.sessionFilePath(session.channelId), session);
    } catch (error) {
      moduleLogger.error('Failed to persist session', {
        channelId: session.channelId,
        error,
      });
      throw error;
    }
  }

  private async runMutation(
    channelId: string,
    mutate: (session: PersistedChannelSession) => void,
  ): Promise<void> {
    await this.mutationQueue.run(channelId, async () => {
      const session = this.ensureSession(channelId);
      mutate(session);
      session.lastActivity = Date.now();
      await this.persistSession(session);
      moduleLogger.debug('Session persisted', {
        channelId,
        messageCount: session.messages.length,
      });
    });
  }

}
