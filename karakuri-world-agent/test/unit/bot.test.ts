import { setTimeout as delay } from 'node:timers/promises';

import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { registerConversationHandlers, runConversationTurn } from '../../src/bot.js';
import { KeyedTaskRunner } from '../../src/keyed-task-runner.js';
import type { ChannelSessionHandle } from '../../src/session/channel-session.js';

function createSession(initialMessages: ModelMessage[] = []): ChannelSessionHandle & { messages: ModelMessage[] } {
  const messages = [...initialMessages];

  return {
    messages,
    async addAssistantMessage(text: string) {
      messages.push({ role: 'assistant', content: text });
    },
    async addUserMessage(text: string) {
      messages.push({ role: 'user', content: text });
    },
    getMessages() {
      return structuredClone(messages);
    },
    async replaceMessages(nextMessages: ModelMessage[]) {
      messages.splice(0, messages.length, ...structuredClone(nextMessages));
    },
  };
}

describe('runConversationTurn', () => {
  it('posts the generated response and then persists it', async () => {
    const session = createSession();
    const post = vi.fn(async () => undefined);
    const addAssistantMessage = vi.spyOn(session, 'addAssistantMessage');
    const logger = { error: vi.fn(), warn: vi.fn() };

    await runConversationTurn({
      generateResponse: async () => ({ text: 'Hello back!' }),
      logger,
      messageText: 'Hello',
      session,
      subscribe: false,
      thread: {
        channelId: 'channel-1',
        post,
        subscribe: async () => undefined,
      },
    });

    expect(post).toHaveBeenCalledWith('Hello back!');
    expect(addAssistantMessage).toHaveBeenCalledWith('Hello back!');
    expect(post.mock.invocationCallOrder[0]).toBeLessThan(addAssistantMessage.mock.invocationCallOrder[0]);
    expect(session.messages).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hello back!' },
    ]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('posts a fallback error message when response generation fails', async () => {
    const session = createSession();
    const post = vi.fn(async () => undefined);
    const logger = { error: vi.fn(), warn: vi.fn() };

    await runConversationTurn({
      failureMessage: 'Temporary failure',
      generateResponse: async () => {
        throw new Error('generation failed');
      },
      logger,
      messageText: 'Hello',
      session,
      subscribe: false,
      thread: {
        channelId: 'channel-1',
        post,
        subscribe: async () => undefined,
      },
    });

    expect(post).toHaveBeenCalledWith('Temporary failure');
    expect(session.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('continues when thread subscription fails', async () => {
    const initialMessages: ModelMessage[] = [{ role: 'assistant', content: 'existing context' }];
    const session = createSession(initialMessages);
    const generateResponse = vi.fn(async () => ({ text: 'Recovered response' }));
    const logger = { error: vi.fn(), warn: vi.fn() };

    await runConversationTurn({
      generateResponse,
      logger,
      messageText: 'Hello',
      session,
      subscribe: true,
      thread: {
        channelId: 'channel-1',
        post: async () => undefined,
        subscribe: async () => {
          throw new Error('subscription failed');
        },
      },
    });

    expect(generateResponse).toHaveBeenCalledWith([
      { role: 'assistant', content: 'existing context' },
      { role: 'user', content: 'Hello' },
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('registerConversationHandlers', () => {
  it('responds to a new non-mention message and subscribes the thread', async () => {
    let newMentionHandler: ((thread: unknown, message: unknown) => Promise<void> | void) | undefined;
    let newMessagePattern: RegExp | undefined;
    let newMessageHandler: ((thread: unknown, message: unknown) => Promise<void> | void) | undefined;
    let subscribedMessageHandler: ((thread: unknown, message: unknown) => Promise<void> | void) | undefined;
    const session = createSession();
    const post = vi.fn(async () => undefined);
    const subscribe = vi.fn(async () => undefined);
    const generate = vi.fn(async () => ({ text: 'Hello from the agent' }));

    registerConversationHandlers({
      bot: {
        onNewMention(handler) {
          newMentionHandler = handler as typeof newMentionHandler;
        },
        onNewMessage(pattern, handler) {
          newMessagePattern = pattern;
          newMessageHandler = handler as typeof newMessageHandler;
        },
        onSubscribedMessage(handler) {
          subscribedMessageHandler = handler as typeof subscribedMessageHandler;
        },
      },
      conversationQueue: new KeyedTaskRunner(),
      initializeConversationAgent: async () => ({ generate }),
      logger: { error: vi.fn(), warn: vi.fn() },
      sessionStore: {
        getOrCreateSession: () => session,
      },
    });

    expect(newMentionHandler).toBeTypeOf('function');
    expect(newMessagePattern?.test('hello there')).toBe(true);
    expect(subscribedMessageHandler).toBeTypeOf('function');

    await newMessageHandler?.(
      {
        channelId: 'channel-1',
        post,
        subscribe,
      },
      {
        text: 'hello there',
      },
    );

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'hello there' }],
    });
    expect(post).toHaveBeenCalledWith('Hello from the agent');
    expect(session.messages).toEqual([
      { role: 'user', content: 'hello there' },
      { role: 'assistant', content: 'Hello from the agent' },
    ]);
  });

  it('serializes rapid messages for the same channel', async () => {
    let subscribedMessageHandler: ((thread: unknown, message: unknown) => Promise<void> | void) | undefined;
    const session = createSession();
    const events: string[] = [];
    const post = vi.fn(async () => undefined);

    registerConversationHandlers({
      bot: {
        onNewMention() {},
        onNewMessage() {},
        onSubscribedMessage(handler) {
          subscribedMessageHandler = handler as typeof subscribedMessageHandler;
        },
      },
      conversationQueue: new KeyedTaskRunner(),
      initializeConversationAgent: async () => ({
        generate: async ({ messages }) => {
          const userMessage = messages[messages.length - 1];
          const text = typeof userMessage.content === 'string' ? userMessage.content : '';
          events.push(`start:${text}`);
          if (text === 'first') {
            await delay(20);
          }
          events.push(`end:${text}`);
          return { text: `reply:${text}` };
        },
      }),
      logger: { error: vi.fn(), warn: vi.fn() },
      sessionStore: {
        getOrCreateSession: () => session,
      },
    });

    await Promise.all([
      subscribedMessageHandler?.(
        {
          channelId: 'channel-1',
          post,
          subscribe: async () => undefined,
        },
        {
          text: 'first',
        },
      ),
      subscribedMessageHandler?.(
        {
          channelId: 'channel-1',
          post,
          subscribe: async () => undefined,
        },
        {
          text: 'second',
        },
      ),
    ]);

    expect(events).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
    expect(session.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply:first' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply:second' },
    ]);
  });
});
