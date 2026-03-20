import { setTimeout as delay } from 'node:timers/promises';

import { createDiscordAdapter, type DiscordAdapter } from '@chat-adapter/discord';
import { createMemoryState } from '@chat-adapter/state-memory';
import { Chat, type Message, type Thread, type WebhookOptions } from 'chat';
import type { ModelMessage } from 'ai';

import { initializeAgent } from './agent.js';
import { compactConversation } from './compact.js';
import { config } from './config.js';
import { KeyedTaskRunner } from './keyed-task-runner.js';
import { createLogger } from './logger.js';
import { buildMemoryPromptContext } from './memory/prompt-context.js';
import { ChannelSessionStore, type ChannelSessionHandle } from './session/channel-session.js';

const GATEWAY_LISTENER_DURATION_MS = 12 * 60 * 60 * 1000;
const GATEWAY_RETRY_DELAY_MS = 5_000;

const DEFAULT_FAILURE_MESSAGE = 'Sorry, I ran into an internal error. Please try again.';

let botInitialized = false;
let gatewayAbortController: AbortController | undefined;
let gatewayLoopPromise: Promise<void> | undefined;
let running = false;
let sessionsRestored = false;

interface BotRuntime {
  bot: Chat;
  conversationQueue: KeyedTaskRunner;
  discordAdapter: DiscordAdapter;
  sessionStore: ChannelSessionStore;
}

interface ConversationAgent {
  generate(options: {
    messages: ModelMessage[];
    options: {
      memoryPromptContext?: string;
    };
  }): Promise<{ text: string }>;
}

interface ConversationHandlerBot {
  onNewMention(handler: (thread: ConversationThread, message: Message) => Promise<void> | void): void;
  onNewMessage(pattern: RegExp, handler: (thread: ConversationThread, message: Message) => Promise<void> | void): void;
  onSubscribedMessage(handler: (thread: ConversationThread, message: Message) => Promise<void> | void): void;
}

interface ConversationLogger {
  error(message: string, ...optionalParams: unknown[]): void;
  warn(message: string, ...optionalParams: unknown[]): void;
}

interface ConversationThread {
  channelId: string;
  post(message: string): Promise<unknown>;
  startTyping?(status?: string): Promise<void>;
  subscribe(): Promise<unknown>;
}

interface ConversationTurnOptions {
  compactMessages?: (messages: ModelMessage[]) => Promise<ModelMessage[] | null>;
  failureMessage?: string;
  generateResponse: (messages: ModelMessage[], memoryPromptContext?: string) => Promise<{ text: string }>;
  logger?: ConversationLogger;
  messageText: string;
  prepareInstructions?: () => Promise<string | undefined>;
  session: ChannelSessionHandle;
  subscribe: boolean;
  thread: ConversationThread;
}

interface RegisterConversationHandlersOptions {
  bot: ConversationHandlerBot;
  conversationQueue: KeyedTaskRunner;
  initializeConversationAgent?: () => Promise<ConversationAgent>;
  logger?: ConversationLogger;
  prepareInstructions?: () => Promise<string | undefined>;
  sessionStore: Pick<ChannelSessionStore, 'getOrCreateSession'>;
}

const TYPING_KEEPALIVE_INTERVAL_MS = 6_000;
const TYPING_FAILSAFE_TTL_MS = 2 * 60 * 1000;

const UNSUBSCRIBED_MESSAGE_PATTERN = /[\s\S]+/;
const moduleLogger = createLogger('bot');

function startTypingKeepalive(
  thread: ConversationThread,
  logger: ConversationLogger,
): () => void {
  if (!thread.startTyping) {
    return () => {};
  }

  let stopped = false;

  const fire = () => {
    if (stopped) return;
    thread.startTyping!().catch((error) => {
      logger.warn('Failed to send typing indicator.', error);
    });
  };

  fire();

  const intervalId = setInterval(fire, TYPING_KEEPALIVE_INTERVAL_MS);
  const failsafeId = setTimeout(() => {
    stopped = true;
    clearInterval(intervalId);
  }, TYPING_FAILSAFE_TTL_MS);

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(intervalId);
    clearTimeout(failsafeId);
  };
}

let runtime: BotRuntime | undefined;

async function initializeConversationAgentAdapter(): Promise<ConversationAgent> {
  const agent = await initializeAgent();

  return {
    generate: async ({ messages, options }) => agent.generate({ messages, options }),
  };
}

async function enqueueConversationTurn({
  conversationQueue,
  initializeConversationAgent = initializeConversationAgentAdapter,
  logger = console,
  message,
  prepareInstructions,
  sessionStore,
  subscribe,
  thread,
}: {
  conversationQueue: KeyedTaskRunner;
  initializeConversationAgent?: () => Promise<ConversationAgent>;
  logger?: ConversationLogger;
  message: Message;
  prepareInstructions?: () => Promise<string | undefined>;
  sessionStore: Pick<ChannelSessionStore, 'getOrCreateSession'>;
  subscribe: boolean;
  thread: ConversationThread;
}): Promise<void> {
  await conversationQueue.run(thread.channelId, async () => {
    const agent = await initializeConversationAgent();
    await runConversationTurn({
      compactMessages: async (messages) => compactConversation({ messages }),
      generateResponse: async (messages, memoryPromptContext) =>
        agent.generate({
          messages,
          options: {
            memoryPromptContext,
          },
        }),
      logger,
      messageText: message.text,
      prepareInstructions,
      session: sessionStore.getOrCreateSession(thread.channelId),
      subscribe,
      thread,
    });
  });
}

export function registerConversationHandlers({
  bot,
  conversationQueue,
  initializeConversationAgent = initializeConversationAgentAdapter,
  logger = console,
  prepareInstructions = async () => undefined,
  sessionStore,
}: RegisterConversationHandlersOptions): void {
  bot.onNewMention(async (thread, message) => {
    await enqueueConversationTurn({
      conversationQueue,
      initializeConversationAgent,
      logger,
      message,
      prepareInstructions,
      sessionStore,
      subscribe: true,
      thread,
    });
  });

  bot.onNewMessage(UNSUBSCRIBED_MESSAGE_PATTERN, async (thread, message) => {
    await enqueueConversationTurn({
      conversationQueue,
      initializeConversationAgent,
      logger,
      message,
      prepareInstructions,
      sessionStore,
      subscribe: true,
      thread,
    });
  });

  bot.onSubscribedMessage(async (thread, message) => {
    await enqueueConversationTurn({
      conversationQueue,
      initializeConversationAgent,
      logger,
      message,
      prepareInstructions,
      sessionStore,
      subscribe: false,
      thread,
    });
  });
}

function createBotRuntime(): BotRuntime {
  const conversationQueue = new KeyedTaskRunner();
  const discordAdapter = createDiscordAdapter({
    botToken: config.discord.token,
    publicKey: config.discord.publicKey,
    applicationId: config.discord.applicationId,
    mentionRoleIds: config.discord.mentionRoleIds,
    userName: config.agent.botName,
  });

  const sessionStore = new ChannelSessionStore({
    dataDir: config.dataDir,
  });

  const bot = new Chat({
    userName: config.agent.botName,
    adapters: {
      discord: discordAdapter,
    },
    state: createMemoryState(),
  });

  registerConversationHandlers({
    bot,
    conversationQueue,
    prepareInstructions: async () =>
      buildMemoryPromptContext({
        dataDir: config.dataDir,
      }),
    sessionStore,
  });

  return {
    bot,
    conversationQueue,
    discordAdapter,
    sessionStore,
  };
}

function getOrCreateRuntime(): BotRuntime {
  runtime ??= createBotRuntime();
  return runtime;
}

export function getBot(): Chat | undefined {
  return runtime?.bot;
}

export function getSessionStore(): ChannelSessionStore | undefined {
  return runtime?.sessionStore;
}

export async function runConversationTurn({
  compactMessages = async (messages) => compactConversation({ messages }),
  failureMessage = DEFAULT_FAILURE_MESSAGE,
  generateResponse,
  logger = console,
  messageText,
  prepareInstructions = async () => undefined,
  session,
  subscribe,
  thread,
}: ConversationTurnOptions): Promise<void> {
  moduleLogger.debug('Conversation turn started', { channelId: thread.channelId });

  if (subscribe) {
    try {
      await thread.subscribe();
    } catch (error) {
      logger.warn('Failed to subscribe to Discord thread; continuing without subscription.', error);
    }
  }

  await session.addUserMessage(messageText);

  try {
    const compactedMessages = await compactMessages(session.getMessages());
    if (compactedMessages) {
      await session.replaceMessages(compactedMessages);
      moduleLogger.debug('Conversation compacted', { channelId: thread.channelId });
    }
  } catch (error) {
    logger.warn('Failed to compact conversation; continuing with the existing session history.', error);
  }

  const stopTyping = startTypingKeepalive(thread, logger);

  let result: { text: string };
  try {
    const memoryPromptContext = await prepareInstructions();
    result = await generateResponse(session.getMessages(), memoryPromptContext);
    moduleLogger.debug('Response generated', {
      channelId: thread.channelId,
      responseLength: result.text.length,
    });
  } catch (error) {
    stopTyping();
    logger.error('Failed to generate an agent response.', error);

    try {
      await thread.post(failureMessage);
    } catch (postError) {
      logger.error('Failed to post the fallback error message.', postError);
    }

    return;
  }

  stopTyping();

  try {
    await thread.post(result.text);
  } catch (error) {
    logger.error('Failed to post the agent response to Discord.', error);
    return;
  }

  try {
    await session.addAssistantMessage(result.text);
  } catch (error) {
    logger.error('Failed to persist the assistant response.', error);
  }
}

export async function handleDiscordWebhook(
  request: Request,
  options: WebhookOptions = {
    waitUntil(task) {
      void task.catch((error) => {
        moduleLogger.error('Discord webhook background task failed.', error);
      });
    },
  },
): Promise<Response> {
  return getOrCreateRuntime().bot.webhooks.discord(request, options);
}

async function startGatewayCycle(
  currentRuntime: BotRuntime,
  signal: AbortSignal,
  webhookUrl: string,
): Promise<void> {
  moduleLogger.debug('Starting Gateway cycle');
  let listenerTask: Promise<unknown> | undefined;

  const response = await currentRuntime.discordAdapter.startGatewayListener(
    {
      waitUntil(task) {
        listenerTask = task;
      },
    },
    GATEWAY_LISTENER_DURATION_MS,
    signal,
    webhookUrl,
  );

  if (!response.ok) {
    throw new Error(`Failed to start Discord Gateway listener: ${await response.text()}`);
  }

  if (!listenerTask) {
    throw new Error('Discord Gateway listener did not register a background task');
  }

  await listenerTask;
}

async function runGatewayLoop(currentRuntime: BotRuntime, webhookUrl: string): Promise<void> {
  while (running) {
    const abortController = new AbortController();
    gatewayAbortController = abortController;

    try {
      await startGatewayCycle(currentRuntime, abortController.signal, webhookUrl);
    } catch (error) {
      if (!running || abortController.signal.aborted) {
        break;
      }

      moduleLogger.error('Discord Gateway listener failed; retrying.', error);
      await delay(GATEWAY_RETRY_DELAY_MS);
    } finally {
      if (gatewayAbortController === abortController) {
        gatewayAbortController = undefined;
      }
    }
  }
}

export async function startBot(webhookUrl: string): Promise<void> {
  if (running) {
    return;
  }

  moduleLogger.info('Starting bot');
  const currentRuntime = getOrCreateRuntime();

  await initializeAgent();

  if (!sessionsRestored) {
    await currentRuntime.sessionStore.restoreFromDisk();
    sessionsRestored = true;
  }

  if (!botInitialized) {
    await currentRuntime.bot.initialize();
    botInitialized = true;
  }

  running = true;
  gatewayLoopPromise = runGatewayLoop(currentRuntime, webhookUrl);
  void gatewayLoopPromise.catch((error) => {
    if (running) {
      moduleLogger.error('Discord Gateway loop stopped unexpectedly.', error);
    }
  });
}

export async function shutdownBot(): Promise<void> {
  moduleLogger.info('Shutting down bot');
  running = false;
  gatewayAbortController?.abort();

  if (gatewayLoopPromise) {
    await gatewayLoopPromise;
    gatewayLoopPromise = undefined;
  }

  const currentRuntime = runtime;

  if (botInitialized && currentRuntime) {
    await currentRuntime.bot.shutdown();
    botInitialized = false;
  }
}
