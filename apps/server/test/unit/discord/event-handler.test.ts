import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorldLogThreadCreationError } from '../../../src/discord/bot.js';
import { DiscordEventHandler } from '../../../src/discord/event-handler.js';
import { beginClosingConversation, detachParticipantFromClosingConversation } from '../../../src/domain/conversation.js';
import type { WorldEngine } from '../../../src/engine/world-engine.js';
import { createTestWorld } from '../../helpers/test-world.js';

class RecordingDiscordBot {
  readonly agentMessages: Array<{ channelId: string; content: string }> = [];
  readonly worldLogMessages: string[] = [];
  readonly worldLogAgentMessages: Array<{ content: string; username: string }> = [];
  readonly threadMessages = new Map<string, string[]>();
  readonly threadAgentMessages = new Map<string, Array<{ content: string; username: string }>>();
  readonly renamedThreads = new Map<string, string>();
  readonly archivedThreads: string[] = [];
  sendAgentMessageOverride: ((channelId: string, content: string) => Promise<void>) | null = null;
  createWorldLogThreadOverride: ((content: string, threadName: string) => Promise<string>) | null = null;
  sendToThreadOverride: ((threadId: string, content: string) => Promise<void>) | null = null;
  renameThreadOverride: ((threadId: string, newName: string) => Promise<void>) | null = null;
  archiveThreadOverride: ((threadId: string) => Promise<void>) | null = null;
  private threadCounter = 0;

  async sendAgentMessage(channelId: string, content: string): Promise<void> {
    if (this.sendAgentMessageOverride) {
      await this.sendAgentMessageOverride(channelId, content);
      return;
    }
    this.agentMessages.push({ channelId, content });
  }

  async sendWorldLog(content: string): Promise<void> {
    this.worldLogMessages.push(content);
  }

  async sendWorldLogAsAgent(content: string, identity: { username: string; avatarURL?: string }): Promise<void> {
    this.worldLogMessages.push(content);
    this.worldLogAgentMessages.push({ content, username: identity.username });
  }

  async createWorldLogThread(content: string, _threadName: string): Promise<string> {
    if (this.createWorldLogThreadOverride) {
      return this.createWorldLogThreadOverride(content, _threadName);
    }
    this.worldLogMessages.push(content);
    const threadId = `thread-${++this.threadCounter}`;
    this.threadMessages.set(threadId, []);
    return threadId;
  }

  async sendToThread(threadId: string, content: string): Promise<void> {
    if (this.sendToThreadOverride) {
      await this.sendToThreadOverride(threadId, content);
      return;
    }
    this.threadMessages.get(threadId)?.push(content);
  }

  async sendToThreadAsAgent(threadId: string, content: string, identity: { username: string; avatarURL?: string }): Promise<void> {
    if (this.sendToThreadOverride) {
      await this.sendToThreadOverride(threadId, content);
      return;
    }
    this.threadMessages.get(threadId)?.push(content);
    const messages = this.threadAgentMessages.get(threadId) ?? [];
    messages.push({ content, username: identity.username });
    this.threadAgentMessages.set(threadId, messages);
  }

  async renameThread(threadId: string, newName: string): Promise<void> {
    if (this.renameThreadOverride) {
      await this.renameThreadOverride(threadId, newName);
      return;
    }
    this.renamedThreads.set(threadId, newName);
  }

  async archiveThread(threadId: string): Promise<void> {
    if (this.archiveThreadOverride) {
      await this.archiveThreadOverride(threadId);
      return;
    }
    this.archivedThreads.push(threadId);
  }

  async close(): Promise<void> {}
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function registerAgent(engine: WorldEngine, agentName: string) {
  return engine.registerAgent({
    discord_bot_id: agentName,
  });
}

function expectWorldContextHeader(message: string, agentName: string): void {
  expect(message).toContain(`あなた (${agentName}) は仮想世界「Karakuri Test World」にログインしています。`);
  expect(message).toContain('A compact map used by automated tests.');
}

describe('DiscordEventHandler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends login notifications and world logs', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    await engine.loginAgent(alice.agent_id);

    await vi.waitFor(() => {
      expect(bot.agentMessages).toHaveLength(1);
      expect(bot.worldLogMessages).toEqual(['世界にログインしました']);
    });

    expect(bot.agentMessages[0]).toMatchObject({
      channelId: 'channel-Alice',
    });
    expectWorldContextHeader(bot.agentMessages[0].content, 'Alice');
    expect(bot.agentMessages[0].content).toContain('世界にログインしました。');
    expect(bot.agentMessages[0].content).toContain('選択肢:');
    expect(bot.agentMessages[0].content).toContain('- move: ノードIDを指定して移動する');
    handler.dispose();
  });

  it('keeps webhook attribution even when avatar backfill is missing', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    await engine.loginAgent(alice.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogAgentMessages).toHaveLength(1);
    });

    bot.worldLogMessages.length = 0;
    bot.worldLogAgentMessages.length = 0;
    const registration = engine.getAgentById(alice.agent_id);
    expect(registration).not.toBeNull();
    registration!.discord_bot_avatar_url = undefined;

    engine.executeWait(alice.agent_id, { duration: 1 });

    await vi.waitFor(() => {
      expect(
        bot.worldLogAgentMessages.some(
          (message) => message.username === 'Alice' && message.content.includes('10分間の待機を開始しました'),
        ),
      ).toBe(true);
    });

    handler.dispose();
  });

  it('notifies the remaining participant when a conversation is forced to end by logout', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(2);
    });
    bot.agentMessages.length = 0;
    bot.worldLogMessages.length = 0;

    const conversation = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: 'やあ、Alice！',
    });
    bot.agentMessages.length = 0;
    bot.worldLogMessages.length = 0;

    await engine.logoutAgent(alice.agent_id);

    await vi.waitFor(() => {
      expect(
        bot.agentMessages.some(
          (message) =>
            message.channelId === 'channel-Bob' &&
            message.content.includes('Alice が世界からログアウトしたため、会話が強制終了されました。'),
        ),
      ).toBe(true);
      expect(bot.worldLogMessages).toContain('会話を終了し、ログアウトしました');
      expect(bot.threadMessages.get('thread-1')).toContain('Alice と Bob の会話が終了しました');
      expect(bot.archivedThreads).toContain('thread-1');
    });

    const bobMessage = bot.agentMessages.find((message) => message.channelId === 'channel-Bob');
    expect(bobMessage).toBeDefined();
    expectWorldContextHeader(bobMessage!.content, 'Bob');
    expect(bobMessage!.content).toContain('選択肢:');

    handler.dispose();
  });

  it('notifies discarded pending joiners when logout ends a conversation before they join', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    const carol = await registerAgent(engine, 'Carol');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await engine.loginAgent(carol.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(3);
    });
    bot.agentMessages.length = 0;
    bot.worldLogMessages.length = 0;

    const conversation = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: 'やあ、Alice！',
    });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: conversation.conversation_id,
    });
    bot.agentMessages.length = 0;
    bot.worldLogMessages.length = 0;

    await engine.logoutAgent(alice.agent_id);

    await vi.waitFor(() => {
      expect(
        bot.agentMessages.some(
          (message) =>
            message.channelId === 'channel-Bob'
            && message.content.includes('Alice が世界からログアウトしたため、会話が強制終了されました。'),
        ),
      ).toBe(true);
      expect(
        bot.agentMessages.some(
          (message) =>
            message.channelId === 'channel-Carol'
            && message.content.includes('参加予定だった会話が、参加者のログアウトにより開始前に終了しました。'),
        ),
      ).toBe(true);
      expect(bot.threadMessages.get('thread-1')).toContain('Alice と Bob の会話が終了しました');
      expect(bot.archivedThreads).toContain('thread-1');
    });

    handler.dispose();
  });

  it('delivers the turn-boundary speaker message to deferred joiners after applyPendingJoiners runs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 10,
          inactive_check_turns: 10,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    const carol = await registerAgent(engine, 'Carol');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await engine.loginAgent(carol.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(3);
    });

    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');
    engine.state.setNode(carol.agent_id, '3-2');
    bot.agentMessages.length = 0;

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: 'やあ、Alice！',
    });
    vi.advanceTimersByTime(500);

    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
    });
    expect(
      engine.state.conversations.get(started.conversation_id)?.pending_participant_agent_ids,
    ).toEqual([carol.agent_id]);

    bot.agentMessages.length = 0;
    engine.speak(alice.agent_id, {
      message: 'Carolも一緒に話そう。',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);

    await vi.waitFor(() => {
      const carolMessages = bot.agentMessages
        .filter((message) => message.channelId === 'channel-Carol')
        .map((message) => message.content);
      expect(carolMessages.some((message) => message.includes('Alice: 「Carolも一緒に話そう。」'))).toBe(true);
    });
    expect(
      engine.state.conversations.get(started.conversation_id)?.participant_agent_ids,
    ).toEqual([alice.agent_id, bob.agent_id, carol.agent_id]);

    handler.dispose();
  });

  it('delivers the pending spoken message before the forced-end notice when logout interrupts an interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 10,
          inactive_check_turns: 10,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    bot.agentMessages.length = 0;

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: 'やあ、Alice！',
    });

    vi.advanceTimersByTime(500);
    expect(engine.state.conversations.get(started.conversation_id)?.current_speaker_agent_id).toBe(alice.agent_id);

    bot.agentMessages.length = 0;
    engine.speak(alice.agent_id, { message: '最後にこれだけ。', next_speaker_agent_id: bob.agent_id });
    await engine.logoutAgent(alice.agent_id);

    await vi.waitFor(() => {
      const bobMessages = bot.agentMessages
        .filter((message) => message.channelId === 'channel-Bob')
        .map((message) => message.content);
      expect(bobMessages.some((message) => message.includes('Alice: 「最後にこれだけ。」'))).toBe(true);
      expect(bobMessages.some((message) => message.includes('Alice が世界からログアウトしたため、会話が強制終了されました。'))).toBe(true);
      expect(
        bobMessages.findIndex((message) => message.includes('Alice: 「最後にこれだけ。」')),
      ).toBeLessThan(
        bobMessages.findIndex((message) => message.includes('Alice が世界からログアウトしたため、会話が強制終了されました。')),
      );
    });

    handler.dispose();
  });

  it('records forced-end notifications even when thread finalization is still pending', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const deferredThread = createDeferred<string>();
    bot.createWorldLogThreadOverride = async (content: string) => {
      bot.worldLogMessages.push(content);
      const threadId = await deferredThread.promise;
      bot.threadMessages.set(threadId, []);
      return threadId;
    };

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(2);
    });
    bot.agentMessages.length = 0;
    bot.worldLogMessages.length = 0;

    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: 'やあ、Alice！',
    });
    bot.agentMessages.length = 0;

    await engine.logoutAgent(alice.agent_id);

    await vi.waitFor(() => {
      expect(
        bot.agentMessages.some(
          (message) =>
            message.channelId === 'channel-Bob' &&
            message.content.includes('Alice が世界からログアウトしたため、会話が強制終了されました。'),
        ),
      ).toBe(true);
    });

    deferredThread.resolve('thread-delayed');

    await vi.waitFor(() => {
      expect(bot.threadMessages.get('thread-delayed')).toContain('Alice と Bob の会話が終了しました');
      expect(bot.archivedThreads).toContain('thread-delayed');
    });

    handler.dispose();
  });

  it('keeps early conversation messages in the thread when logout ends the conversation immediately', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const firstThreadPost = createDeferred<void>();
    let blocked = true;
    bot.sendToThreadOverride = async (threadId, content) => {
      if (blocked && content !== 'Alice と Bob の会話が終了しました') {
        blocked = false;
        await firstThreadPost.promise;
      }
      bot.threadMessages.get(threadId)?.push(content);
    };
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(2);
    });
    bot.agentMessages.length = 0;
    bot.worldLogMessages.length = 0;

    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: 'やあ、Alice！',
    });

    await engine.logoutAgent(alice.agent_id);

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toEqual(['Alice と Bob の会話が始まりました']);
      expect(bot.threadMessages.get('thread-1')).toEqual([]);
    });

    firstThreadPost.resolve();

    await vi.waitFor(() => {
      expect(bot.threadMessages.get('thread-1')).toEqual([
        '「こんにちは。」',
        '「やあ、Alice！」',
        'Alice と Bob の会話が終了しました',
      ]);
      expect(bot.worldLogMessages).toEqual(['Alice と Bob の会話が始まりました', '会話を終了し、ログアウトしました']);
      expect(bot.worldLogMessages).not.toContain('「こんにちは。」');
      expect(bot.worldLogMessages).not.toContain('「やあ、Alice！」');
      expect(bot.archivedThreads).toContain('thread-1');
    });

    handler.dispose();
  });

  it('writes initial and subsequent conversation messages to the world log', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(2);
    });
    bot.agentMessages.length = 0;
    bot.worldLogMessages.length = 0;

    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: '今日はいい天気ですね。',
    });

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toEqual(['Alice と Bob の会話が始まりました']);
      expect(bot.threadMessages.get('thread-1')).toEqual(['「こんにちは。」', '「今日はいい天気ですね。」']);
    });

    handler.dispose();
  });

  it('does not duplicate closing messages in the world log', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 3,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(2);
    });
    bot.agentMessages.length = 0;
    bot.worldLogMessages.length = 0;

    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: '今日はいい天気ですね。',
    });

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toEqual(['Alice と Bob の会話が始まりました']);
      expect(bot.threadMessages.get('thread-1')).toEqual(['「こんにちは。」', '「今日はいい天気ですね。」']);
    });

    await vi.advanceTimersByTimeAsync(500);

    engine.speak(alice.agent_id, {
      message: 'それではまた。',
      next_speaker_agent_id: bob.agent_id,
    });

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toEqual(['Alice と Bob の会話が始まりました']);
      expect(bot.threadMessages.get('thread-1')).toEqual([
        '「こんにちは。」',
        '「今日はいい天気ですね。」',
        '「それではまた。」',
      ]);
    });

    await vi.advanceTimersByTimeAsync(500);

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toEqual(['Alice と Bob の会話が始まりました']);
      expect(bot.threadMessages.get('thread-1')).toEqual([
        '「こんにちは。」',
        '「今日はいい天気ですね。」',
        '「それではまた。」',
        'Alice と Bob の会話が終了しました',
      ]);
      expect(bot.threadMessages.get('thread-1')?.filter((message) => message === '「それではまた。」')).toHaveLength(1);
      expect(bot.archivedThreads).toContain('thread-1');
    });

    handler.dispose();
  });

  it('falls back to flat world-log posts when thread creation fails', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    bot.createWorldLogThreadOverride = async () => {
      throw new Error('thread creation failed');
    };
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(2);
    });
    bot.worldLogMessages.length = 0;

    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: '今日はいい天気ですね。',
    });

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toEqual([
        'Alice と Bob の会話が始まりました',
        '「こんにちは。」',
        '「今日はいい天気ですね。」',
      ]);
    });

    await engine.logoutAgent(alice.agent_id);

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toContain('Alice と Bob の会話が終了しました');
      expect(bot.worldLogMessages).toContain('会話を終了し、ログアウトしました');
    });

    handler.dispose();
  });

  it('keeps logout after flat fallback conversation logs when thread creation fails late', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const deferredThread = createDeferred<string>();
    bot.createWorldLogThreadOverride = async (content) => {
      bot.worldLogMessages.push(content);
      return deferredThread.promise;
    };
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(2);
    });
    bot.agentMessages.length = 0;
    bot.worldLogMessages.length = 0;

    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: 'やあ、Alice！',
    });

    await engine.logoutAgent(alice.agent_id);

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toEqual(['Alice と Bob の会話が始まりました']);
    });

    deferredThread.reject(new WorldLogThreadCreationError(true, new Error('startThread failed')));

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toEqual([
        'Alice と Bob の会話が始まりました',
        '「こんにちは。」',
        '「やあ、Alice！」',
        'Alice と Bob の会話が終了しました',
        '会話を終了し、ログアウトしました',
      ]);
    });

    handler.dispose();
  });

  it('does not duplicate the start log when thread creation fails after posting it', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    bot.createWorldLogThreadOverride = async (content) => {
      bot.worldLogMessages.push(content);
      throw new WorldLogThreadCreationError(true, new Error('startThread failed'));
    };
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(2);
    });
    bot.worldLogMessages.length = 0;

    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: '今日はいい天気ですね。',
    });

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toEqual([
        'Alice と Bob の会話が始まりました',
        '「こんにちは。」',
        '「今日はいい天気ですね。」',
      ]);
    });

    handler.dispose();
  });

  it('falls back to the world log when thread posting fails mid-conversation', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    let failed = false;
    bot.sendToThreadOverride = async (threadId, content) => {
      if (!failed) {
        failed = true;
        throw new Error('thread send failed');
      }
      bot.threadMessages.get(threadId)?.push(content);
    };
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(2);
    });
    bot.worldLogMessages.length = 0;

    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: '今日はいい天気ですね。',
    });

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toContain('「こんにちは。」');
      expect(bot.threadMessages.get('thread-1')).toEqual(['「今日はいい天気ですね。」']);
    });

    handler.dispose();
  });

  it('preserves conversation message order when thread delivery is delayed', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const firstSend = createDeferred<void>();
    let blocked = true;
    bot.sendToThreadOverride = async (threadId, content) => {
      if (blocked) {
        blocked = false;
        await firstSend.promise;
      }
      bot.threadMessages.get(threadId)?.push(content);
    };
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(2);
    });
    bot.worldLogMessages.length = 0;

    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: '今日はいい天気ですね。',
    });

    await vi.waitFor(() => {
      expect(bot.threadMessages.get('thread-1')).toEqual([]);
    });

    firstSend.resolve();

    await vi.waitFor(() => {
      expect(bot.threadMessages.get('thread-1')).toEqual(['「こんにちは。」', '「今日はいい天気ですね。」']);
    });

    handler.dispose();
  });

  it('does not duplicate the end log when only thread archival fails', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    bot.archiveThreadOverride = async () => {
      throw new Error('archive failed');
    };
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(2);
    });
    bot.worldLogMessages.length = 0;

    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: '今日はいい天気ですね。',
    });

    await vi.waitFor(() => {
      expect(bot.threadMessages.get('thread-1')).toEqual(['「こんにちは。」', '「今日はいい天気ですね。」']);
    });

    await engine.logoutAgent(alice.agent_id);

    await vi.waitFor(() => {
      expect(bot.threadMessages.get('thread-1')).toContain('Alice と Bob の会話が終了しました');
      expect(bot.worldLogMessages).not.toContain('Alice と Bob の会話が終了しました');
      expect(bot.worldLogMessages).toContain('会話を終了し、ログアウトしました');
    });

    handler.dispose();
  });

  it('sends logout notification to agent channel and world log', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    await engine.loginAgent(alice.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(1);
    });
    bot.agentMessages.length = 0;
    bot.worldLogMessages.length = 0;

    await engine.logoutAgent(alice.agent_id);

    await vi.waitFor(() => {
      expect(
        bot.agentMessages.some(
          (message) =>
            message.channelId === 'channel-Alice' &&
            message.content === 'ログアウトしました。',
        ),
      ).toBe(true);
    });
    expect(bot.worldLogMessages).toContain('世界からログアウトしました');

    handler.dispose();
  });

  it('uses movement_completed.node_id for arrival notifications', async () => {
    const { engine } = createTestWorld({
      config: {
        spawn: { nodes: ['3-1'] },
      },
    });
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    await engine.loginAgent(alice.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(1);
    });
    bot.agentMessages.length = 0;
    bot.worldLogMessages.length = 0;

    engine.state.setNode(alice.agent_id, '3-4');
    engine.emitEvent({
      type: 'movement_completed',
      agent_id: alice.agent_id,
      agent_name: alice.agent_name,
      node_id: '3-4',
      delivered_server_event_ids: [],
    });

    await vi.waitFor(() => {
      expect(
        bot.agentMessages.some(
          (message) =>
            message.channelId === 'channel-Alice' &&
            message.content.includes('3-4 (Workshop Door) に到着しました。'),
        ),
      ).toBe(true);
      expect(bot.worldLogMessages).toContain('3-4 (Workshop Door) に到着しました');
    });

    const arrivalMessage = bot.agentMessages.find((message) => message.channelId === 'channel-Alice');
    expect(arrivalMessage).toBeDefined();
    expectWorldContextHeader(arrivalMessage!.content, 'Alice');
    expect(arrivalMessage!.content).toContain('選択肢:');

    handler.dispose();
  });

  it('personalizes server event notifications with each agent name', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(2);
    });
    bot.agentMessages.length = 0;
    bot.worldLogMessages.length = 0;

    engine.fireServerEvent('Dark clouds gather.');

    await vi.waitFor(() => {
      expect(bot.agentMessages).toHaveLength(2);
    });

    const aliceMessage = bot.agentMessages.find((message) => message.channelId === 'channel-Alice');
    const bobMessage = bot.agentMessages.find((message) => message.channelId === 'channel-Bob');
    expect(aliceMessage).toBeDefined();
    expect(bobMessage).toBeDefined();
    expectWorldContextHeader(aliceMessage!.content, 'Alice');
    expectWorldContextHeader(bobMessage!.content, 'Bob');
    expect(aliceMessage!.content).toContain('【サーバーイベント】');
    expect(aliceMessage!.content).toContain('Dark clouds gather.');
    expect(bobMessage!.content).toContain('【サーバーイベント】');
    expect(bobMessage!.content).toContain('Dark clouds gather.');
    expect(aliceMessage!.content).not.toBe(bobMessage!.content);

    handler.dispose();
  });

  it('clears active server events after info notifications are delivered', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    await engine.loginAgent(alice.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(1);
    });
    bot.agentMessages.length = 0;

    const infoEvents: Array<'map_info_requested' | 'world_agents_info_requested' | 'perception_requested' | 'available_actions_requested'> = [
      'map_info_requested',
      'world_agents_info_requested',
      'perception_requested',
      'available_actions_requested',
    ];

    for (const infoEvent of infoEvents) {
      const fired = engine.fireServerEvent('Dark clouds gather.');

      await vi.waitFor(() => {
        expect(bot.agentMessages.some((message) => message.content.includes('【サーバーイベント】'))).toBe(true);
      });
      expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBe(fired.server_event_id);

      bot.agentMessages.length = 0;
      engine.emitEvent({ type: infoEvent, agent_id: alice.agent_id });

      await vi.waitFor(() => {
        expect(bot.agentMessages).toHaveLength(1);
      });
      expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBeNull();

      bot.agentMessages.length = 0;
    }

    handler.dispose();
  });

  it('clears delayed server events after the movement completion notification', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    await engine.loginAgent(alice.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(1);
    });
    bot.agentMessages.length = 0;

    engine.state.setNode(alice.agent_id, '3-1');
    engine.move(alice.agent_id, { target_node_id: '3-4' });
    const fired = engine.fireServerEvent('Dark clouds gather.');

    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBeNull();

    vi.advanceTimersByTime(3000);

    await vi.waitFor(() => {
      expect(bot.agentMessages).toHaveLength(2);
    });

    expect(bot.agentMessages[0]?.content).toContain('【サーバーイベント】');
    expect(bot.agentMessages[0]?.content).toContain('Dark clouds gather.');
    expect(bot.agentMessages[1]?.content).toContain('3-4');
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBeNull();
    expect(fired.server_event_id).toMatch(/^server-event-/);

    handler.dispose();
  });

  it('serializes delayed server-event delivery before the arrival notification and keeps the window open until arrival is delivered', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    await engine.loginAgent(alice.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(1);
    });
    bot.agentMessages.length = 0;

    const delayedServerEventSend = createDeferred<void>();
    const attemptedMessages: string[] = [];
    bot.sendAgentMessageOverride = async (channelId, content) => {
      attemptedMessages.push(content);
      if (content.includes('【サーバーイベント】')) {
        await delayedServerEventSend.promise;
      }
      bot.agentMessages.push({ channelId, content });
    };

    engine.state.setNode(alice.agent_id, '3-1');
    engine.move(alice.agent_id, { target_node_id: '3-4' });
    engine.fireServerEvent('Dark clouds gather.');

    vi.advanceTimersByTime(3000);

    await vi.waitFor(() => {
      expect(attemptedMessages).toHaveLength(1);
      expect(attemptedMessages[0]).toContain('【サーバーイベント】');
    });
    expect(bot.agentMessages).toHaveLength(0);
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).not.toBeNull();

    delayedServerEventSend.resolve();

    await vi.waitFor(() => {
      expect(bot.agentMessages).toHaveLength(2);
    });

    expect(bot.agentMessages[0]?.content).toContain('【サーバーイベント】');
    expect(bot.agentMessages[1]?.content).toContain('3-4');
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBeNull();

    handler.dispose();
  });

  it.each([
    {
      title: 'action completion',
      prepare: (engine: WorldEngine, agentId: string) => {
        engine.state.setNode(agentId, '1-1');
        engine.executeAction(agentId, { action_id: 'greet-gatekeeper' });
      },
      complete: () => {
        vi.advanceTimersByTime(1200);
      },
      expectedText: '「Greet the gatekeeper」が完了しました。',
    },
    {
      title: 'wait completion',
      prepare: (engine: WorldEngine, agentId: string) => {
        engine.executeWait(agentId, { duration: 1 });
      },
      complete: () => {
        vi.advanceTimersByTime(600000);
      },
      expectedText: '10分間待機しました。',
    },
    {
      title: 'idle reminder',
      prepare: () => {},
      complete: () => {
        vi.advanceTimersByTime(1000);
      },
      expectedText: '前回の行動から1秒間が経過しました。',
      config: {
        idle_reminder: {
          interval_ms: 1000,
        },
      },
    },
  ])(
    'keeps the server-event window open until the $title notification is delivered',
    async ({ prepare, complete, expectedText, config }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { engine } = createTestWorld({ config });
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    await engine.loginAgent(alice.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(1);
    });
    bot.agentMessages.length = 0;

    prepare(engine, alice.agent_id);
    const fired = engine.fireServerEvent('Dark clouds gather.');
    await vi.waitFor(() => {
      expect(bot.agentMessages).toHaveLength(1);
    });
    bot.agentMessages.length = 0;

    const delayedFollowUpSend = createDeferred<void>();
    const attemptedMessages: string[] = [];
    bot.sendAgentMessageOverride = async (channelId, content) => {
      attemptedMessages.push(content);
      if (content.includes(expectedText)) {
        await delayedFollowUpSend.promise;
      }
      bot.agentMessages.push({ channelId, content });
    };

    complete();

    await vi.waitFor(() => {
      expect(attemptedMessages.some((message) => message.includes(expectedText))).toBe(true);
    });
    expect(bot.agentMessages).toHaveLength(0);
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBe(fired.server_event_id);

    delayedFollowUpSend.resolve();

    await vi.waitFor(() => {
      expect(bot.agentMessages).toHaveLength(1);
    });
    expect(bot.agentMessages[0]?.content).toContain(expectedText);
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBeNull();

    handler.dispose();
    },
  );

  it('keeps a conversation follow-up server-event window open until the prompt is delivered', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 4,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(2);
    });
    bot.agentMessages.length = 0;

    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');
    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: 'やあ、Alice！',
    });

    await vi.waitFor(() => {
      expect(bot.threadMessages.get('thread-1')).toEqual(['「こんにちは。」', '「やあ、Alice！」']);
    });

    bot.agentMessages.length = 0;
    engine.fireServerEvent('Dark clouds gather.');
    await vi.waitFor(() => {
      expect(bot.agentMessages.filter((message) => message.content.includes('【サーバーイベント】'))).toHaveLength(2);
    });

    bot.agentMessages.length = 0;
    const delayedPromptSend = createDeferred<void>();
    const attemptedMessages: string[] = [];
    bot.sendAgentMessageOverride = async (channelId, content) => {
      attemptedMessages.push(`${channelId}:${content}`);
      if (channelId === 'channel-Alice' && content.includes('「やあ、Alice！」')) {
        await delayedPromptSend.promise;
      }
      bot.agentMessages.push({ channelId, content });
    };

    vi.advanceTimersByTime(500);

    await vi.waitFor(() => {
      expect(
        attemptedMessages.some(
          (message) => message.startsWith('channel-Alice:') && message.includes('「やあ、Alice！」'),
        ),
      ).toBe(true);
    });
    expect(bot.agentMessages).toHaveLength(0);
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).not.toBeNull();
    expect(engine.state.getLoggedIn(bob.agent_id)?.active_server_event_id).not.toBeNull();

    delayedPromptSend.resolve();

    await vi.waitFor(() => {
      expect(bot.agentMessages).toHaveLength(1);
    });

    expect(bot.agentMessages[0]).toMatchObject({ channelId: 'channel-Alice' });
    expect(bot.agentMessages[0]?.content).toContain('「やあ、Alice！」');
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBeNull();
    expect(engine.state.getLoggedIn(bob.agent_id)?.active_server_event_id).not.toBeNull();

    handler.dispose();
  });

  it.each([
    ['initiator', 'Alice', 'channel-Alice', 'Bob'],
    ['target', 'Bob', 'channel-Bob', 'Alice'],
  ] as const)(
    'notifies both agents when a pending conversation is interrupted by a server event via the %s',
    async (_role, interrupterName, interrupterChannelId, counterpartName) => {
      const { engine } = createTestWorld();
      const bot = new RecordingDiscordBot();
      const handler = new DiscordEventHandler(engine, bot as never);
      handler.register();

      const alice = await registerAgent(engine, 'Alice');
      const bob = await registerAgent(engine, 'Bob');
      await engine.loginAgent(alice.agent_id);
      await engine.loginAgent(bob.agent_id);
      await vi.waitFor(() => {
        expect(bot.worldLogMessages).toHaveLength(2);
      });
      bot.agentMessages.length = 0;

      engine.state.setNode(alice.agent_id, '3-1');
      engine.state.setNode(bob.agent_id, '3-2');
      engine.startConversation(alice.agent_id, {
        target_agent_id: bob.agent_id,
        message: 'こんにちは。',
      });
      await vi.waitFor(() => {
        expect(bot.agentMessages).toHaveLength(1);
      });

      bot.agentMessages.length = 0;
      engine.fireServerEvent('Dark clouds gather.');
      await vi.waitFor(() => {
        expect(bot.agentMessages.filter((message) => message.content.includes('【サーバーイベント】'))).toHaveLength(2);
      });

      bot.agentMessages.length = 0;
      const interrupterId = interrupterName === 'Alice' ? alice.agent_id : bob.agent_id;
      engine.executeWait(interrupterId, { duration: 1 });

      await vi.waitFor(() => {
        expect(bot.agentMessages).toHaveLength(2);
      });

      expect(bot.agentMessages.map((message) => message.channelId).sort()).toEqual(['channel-Alice', 'channel-Bob']);
      expect(bot.agentMessages.every((message) => message.content.includes('サーバーイベントにより中断されました。'))).toBe(true);
      expect(bot.agentMessages.every((message) => !message.content.includes('ログアウトしました。'))).toBe(true);
      expect(bot.agentMessages.find((message) => message.channelId === interrupterChannelId)?.content).toContain(
        `${counterpartName} との会話開始はサーバーイベントにより中断されました。`,
      );
      expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBeNull();
      expect(engine.state.getLoggedIn(bob.agent_id)?.active_server_event_id).toBeNull();

      handler.dispose();
    },
  );

  it('sends the server-event closing prompt to the farewell speaker', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 4,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(2);
    });
    bot.agentMessages.length = 0;

    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');
    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: 'やあ、Alice！',
    });

    await vi.waitFor(() => {
      expect(bot.threadMessages.get('thread-1')).toEqual(['「こんにちは。」', '「やあ、Alice！」']);
    });

    engine.fireServerEvent('Dark clouds gather.');
    await vi.waitFor(() => {
      expect(bot.agentMessages.filter((message) => message.content.includes('【サーバーイベント】'))).toHaveLength(2);
    });

    bot.agentMessages.length = 0;
    engine.executeWait(bob.agent_id, { duration: 1 });

    await vi.waitFor(() => {
      expect(
        bot.agentMessages.some(
          (message) =>
            message.channelId === 'channel-Alice'
            && message.content.includes('サーバーイベントにより会話が終了します。'),
        ),
      ).toBe(true);
    });

    expect(
      bot.agentMessages.some(
        (message) =>
          message.channelId === 'channel-Bob'
          && message.content.includes('サーバーイベントにより会話が終了します。'),
      ),
    ).toBe(false);
    expect(engine.state.getLoggedIn(alice.agent_id)?.active_server_event_id).toBeNull();

    handler.dispose();
  });

  it('removes the interrupting participant from server-event closing prompts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 6,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    const carol = await registerAgent(engine, 'Carol');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await engine.loginAgent(carol.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(3);
    });
    bot.agentMessages.length = 0;

    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');
    engine.state.setNode(carol.agent_id, '3-2');
    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: 'やあ、Alice！',
    });
    vi.advanceTimersByTime(500);
    await vi.waitFor(() => {
      expect(bot.agentMessages.some((message) => message.channelId === 'channel-Alice')).toBe(true);
    });

    bot.agentMessages.length = 0;
    engine.joinConversation(carol.agent_id, {
      conversation_id: [...engine.state.conversations.list()][0]!.conversation_id,
    });
    engine.speak(alice.agent_id, {
      message: 'Carolも来てね。',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);
    await vi.waitFor(() => {
      expect(bot.renamedThreads.get('thread-1')).toBe('Alice と Bob 他1名');
    });

    bot.agentMessages.length = 0;
    engine.fireServerEvent('Dark clouds gather.');
    await vi.waitFor(() => {
      expect(bot.agentMessages.filter((message) => message.content.includes('【サーバーイベント】'))).toHaveLength(3);
    });

    bot.agentMessages.length = 0;
    engine.executeWait(bob.agent_id, { duration: 1 });

    await vi.waitFor(() => {
      expect(
        bot.agentMessages.some(
          (message) => message.channelId === 'channel-Alice' && message.content.includes('サーバーイベントにより会話が終了します。'),
        ),
      ).toBe(true);
    });

    const alicePrompt = bot.agentMessages.find((message) => message.channelId === 'channel-Alice');
    expect(alicePrompt?.content).toContain(`参加者: Alice (id: ${alice.agent_id})、Carol (id: ${carol.agent_id})`);
    expect(alicePrompt?.content).toContain('次の話者ID');
    expect(bot.renamedThreads.get('thread-1')).toBe('Alice と Carol');
    expect(bot.threadMessages.get('thread-1')).toContain('🔔 Bob が会話から離れました。\n次は Alice の番です。');

    handler.dispose();
  });

  it('sends the server-event closing prompt to the replacement speaker after logout during closing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 6,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    const carol = await registerAgent(engine, 'Carol');
    const dave = await registerAgent(engine, 'Dave');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await engine.loginAgent(carol.agent_id);
    await engine.loginAgent(dave.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(4);
    });
    bot.agentMessages.length = 0;

    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');
    engine.state.setNode(carol.agent_id, '3-2');
    engine.state.setNode(dave.agent_id, '3-2');
    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: 'やあ、Alice！',
    });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: [...engine.state.conversations.list()][0]!.conversation_id,
    });
    engine.joinConversation(dave.agent_id, {
      conversation_id: [...engine.state.conversations.list()][0]!.conversation_id,
    });
    engine.speak(alice.agent_id, {
      message: 'みんなで話そう。',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);

    bot.agentMessages.length = 0;
    const conversationId = [...engine.state.conversations.list()][0]!.conversation_id;
    beginClosingConversation(engine, conversationId, alice.agent_id, 'server_event');
    await vi.waitFor(() => {
      expect(
        bot.agentMessages.some(
          (message) => message.channelId === 'channel-Alice' && message.content.includes('サーバーイベントにより会話が終了します。'),
        ),
      ).toBe(true);
    });

    bot.agentMessages.length = 0;
    await engine.logoutAgent(alice.agent_id);

    await vi.waitFor(() => {
      expect(
        bot.agentMessages.some(
          (message) => message.channelId === 'channel-Bob' && message.content.includes('サーバーイベントにより会話が終了します。'),
        ),
      ).toBe(true);
    });

    const bobPrompt = bot.agentMessages.find((message) => message.channelId === 'channel-Bob');
    expect(bobPrompt?.content).toContain(`参加者: Bob (id: ${bob.agent_id})、Carol (id: ${carol.agent_id})、Dave (id: ${dave.agent_id})`);
    expect(bobPrompt?.content).toContain('次の話者ID');
    expect(bobPrompt?.content).not.toContain('あなたが最後のメッセージを送る番です。');

    handler.dispose();
  });

  it('does not send duplicate action prompts when a server-event closing turn advances in a group conversation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 6,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    const carol = await registerAgent(engine, 'Carol');
    const dave = await registerAgent(engine, 'Dave');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await engine.loginAgent(carol.agent_id);
    await engine.loginAgent(dave.agent_id);
    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');
    engine.state.setNode(carol.agent_id, '3-2');
    engine.state.setNode(dave.agent_id, '3-2');
    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: 'やあ、Alice！',
    });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: [...engine.state.conversations.list()][0]!.conversation_id,
    });
    engine.joinConversation(dave.agent_id, {
      conversation_id: [...engine.state.conversations.list()][0]!.conversation_id,
    });
    engine.speak(alice.agent_id, {
      message: 'CarolとDaveもどうぞ。',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);
    engine.speak(bob.agent_id, {
      message: 'Aliceに戻すね。',
      next_speaker_agent_id: alice.agent_id,
    });
    vi.advanceTimersByTime(500);

    bot.agentMessages.length = 0;
    beginClosingConversation(
      engine,
      [...engine.state.conversations.list()][0]!.conversation_id,
      alice.agent_id,
      'server_event',
      carol.agent_id,
    );
    await vi.waitFor(() => {
      expect(
        bot.agentMessages.some(
          (message) => message.channelId === 'channel-Alice' && message.content.includes('サーバーイベントにより会話が終了します。'),
        ),
      ).toBe(true);
    });

    bot.agentMessages.length = 0;
    engine.speak(alice.agent_id, {
      message: 'Bob、最後をお願い。',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);

    await vi.waitFor(() => {
      const bobMessages = bot.agentMessages
        .filter((message) => message.channelId === 'channel-Bob')
        .map((message) => message.content);

      expect(bobMessages.filter((message) => message.includes('conversation_speak'))).toHaveLength(1);
      expect(bobMessages.some((message) =>
        message.includes('Alice: 「Bob、最後をお願い。」')
        && !message.includes('選択肢:'))).toBe(true);
      expect(bobMessages.some((message) => message.includes('サーバーイベントにより会話が終了します。'))).toBe(true);
    });

    handler.dispose();
  });

  it('sends notification-based info responses for map, perception, actions, and world agents', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(2);
    });
    bot.agentMessages.length = 0;

    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.emitEvent({ type: 'map_info_requested', agent_id: alice.agent_id });
    engine.emitEvent({ type: 'world_agents_info_requested', agent_id: alice.agent_id });
    engine.emitEvent({ type: 'perception_requested', agent_id: alice.agent_id });
    engine.emitEvent({ type: 'available_actions_requested', agent_id: alice.agent_id });

    await vi.waitFor(() => {
      expect(bot.agentMessages).toHaveLength(4);
    });

    expect(bot.agentMessages[0]?.content).toContain('マップ: 3行 × 5列');
    expect(bot.agentMessages[0]?.content).toContain('選択肢:');
    expect(bot.agentMessages[1]?.content).toContain(`Bob (${bob.agent_id}) - 位置: 1-2 - 状態: idle`);
    expect(bot.agentMessages[1]?.content).not.toContain(`Alice (${alice.agent_id})`);
    expect(bot.agentMessages[1]?.content).toContain('選択肢:');
    expect(bot.agentMessages[2]?.content).toContain('近くのノード:');
    expect(bot.agentMessages[2]?.content).toContain('選択肢:');
    expect(bot.agentMessages[3]?.content).toContain('実行可能なアクション:');
    expect(bot.agentMessages[3]?.content).toContain('Greet the gatekeeper');

    handler.dispose();
  });

  it('sends actionable prompts only to the nominated next speaker in group conversations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    const carol = await registerAgent(engine, 'Carol');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await engine.loginAgent(carol.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(3);
    });
    bot.agentMessages.length = 0;

    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');
    engine.state.setNode(carol.agent_id, '3-2');
    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: 'やあ、Alice！',
    });

    await vi.waitFor(() => {
      expect(bot.threadMessages.get('thread-1')).toEqual(['「こんにちは。」', '「やあ、Alice！」']);
    });

    vi.advanceTimersByTime(500);
    await vi.waitFor(() => {
      expect(bot.agentMessages.some((message) => message.channelId === 'channel-Alice')).toBe(true);
    });

    bot.agentMessages.length = 0;
    engine.joinConversation(carol.agent_id, {
      conversation_id: [...engine.state.conversations.list()][0]!.conversation_id,
    });
    engine.speak(alice.agent_id, {
      message: 'Carolも一緒に話そう',
      next_speaker_agent_id: bob.agent_id,
    });

    vi.advanceTimersByTime(500);
    await vi.waitFor(() => {
      expect(bot.renamedThreads.get('thread-1')).toBe('Alice と Bob 他1名');
    });
    bot.agentMessages.length = 0;
    engine.speak(bob.agent_id, {
      message: 'Carol、次どうぞ。',
      next_speaker_agent_id: carol.agent_id,
    });
    vi.advanceTimersByTime(500);

    await vi.waitFor(() => {
      expect(bot.renamedThreads.get('thread-1')).toBe('Alice と Bob 他1名');
      expect(bot.agentMessages).toHaveLength(2);
    });

    const aliceMessage = bot.agentMessages.find((message) => message.channelId === 'channel-Alice');
    const carolMessage = bot.agentMessages.find((message) => message.channelId === 'channel-Carol');
    expect(aliceMessage?.content).toContain('Bob: 「Carol、次どうぞ。」');
    expect(aliceMessage?.content).toContain('次は Carol の番です。');
    expect(aliceMessage?.content).not.toContain('選択肢:');
    expect(carolMessage?.content).toContain('Bob: 「Carol、次どうぞ。」');
    expect(carolMessage?.content).toContain('選択肢:');
    expect(carolMessage?.content).toContain('conversation_speak');

    handler.dispose();
  });

  it('keeps the original pair in the thread name after later participants join', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const zulu = await registerAgent(engine, 'bot-Zulu');
    const alpha = await registerAgent(engine, 'bot-Alpha');
    const beta = await registerAgent(engine, 'bot-Beta');
    await engine.loginAgent(zulu.agent_id);
    await engine.loginAgent(alpha.agent_id);
    await engine.loginAgent(beta.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(3);
    });

    engine.state.setNode(zulu.agent_id, '3-1');
    engine.state.setNode(alpha.agent_id, '3-2');
    engine.state.setNode(beta.agent_id, '3-2');
    engine.startConversation(zulu.agent_id, {
      target_agent_id: alpha.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(alpha.agent_id, {
      message: 'やあ。',
    });

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toContain('Zulu と Alpha の会話が始まりました');
    });

    vi.advanceTimersByTime(500);
    bot.agentMessages.length = 0;

    engine.joinConversation(beta.agent_id, {
      conversation_id: [...engine.state.conversations.list()][0]!.conversation_id,
    });
    engine.speak(zulu.agent_id, {
      message: 'Betaもどうぞ。',
      next_speaker_agent_id: alpha.agent_id,
    });
    vi.advanceTimersByTime(500);

    await vi.waitFor(() => {
      expect(bot.renamedThreads.get('thread-1')).toBe('Zulu と Alpha 他1名');
    });

    handler.dispose();
  });

  it('re-prompts the resumed speaker after inactive checks and participant logout, and renames the thread', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { engine } = createTestWorld({
      config: {
        conversation: {
          inactive_check_turns: 1,
        },
      },
    });
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    const carol = await registerAgent(engine, 'Carol');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await engine.loginAgent(carol.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(3);
    });
    bot.agentMessages.length = 0;

    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');
    engine.state.setNode(carol.agent_id, '3-2');
    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: 'やあ、Alice！',
    });

    await vi.waitFor(() => {
      expect(bot.threadMessages.get('thread-1')).toEqual(['「こんにちは。」', '「やあ、Alice！」']);
    });

    vi.advanceTimersByTime(500);
    await vi.waitFor(() => {
      expect(bot.agentMessages.some((message) => message.channelId === 'channel-Alice')).toBe(true);
    });

    bot.agentMessages.length = 0;
    const conversationId = [...engine.state.conversations.list()][0]!.conversation_id;
    engine.joinConversation(carol.agent_id, {
      conversation_id: conversationId,
    });
    engine.speak(alice.agent_id, {
      message: 'Bob、次にどうする？',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);
    engine.speak(bob.agent_id, {
      message: 'Alice、考えてみて。',
      next_speaker_agent_id: alice.agent_id,
    });
    vi.advanceTimersByTime(500);

    await vi.waitFor(() => {
      expect(bot.renamedThreads.get('thread-1')).toBe('Alice と Bob 他1名');
      expect(bot.agentMessages.some((message) => message.channelId === 'channel-Carol' && message.content.includes('conversation_stay'))).toBe(true);
    });

    bot.agentMessages.length = 0;
    engine.stayInConversation(carol.agent_id);

    await vi.waitFor(() => {
      expect(
        bot.agentMessages.some(
          (message) => message.channelId === 'channel-Alice' && message.content.includes('あなたの番です。'),
        ),
      ).toBe(true);
    });

    bot.agentMessages.length = 0;
    await engine.logoutAgent(carol.agent_id);

    await vi.waitFor(() => {
      expect(bot.renamedThreads.get('thread-1')).toBe('Alice と Bob');
      expect(
        bot.agentMessages.some(
          (message) => message.channelId === 'channel-Alice' && message.content.includes('あなたの番です。'),
        ),
      ).toBe(true);
    });

    handler.dispose();
  });

  it('uses the paused resume speaker for interval prompts during inactive-check pauses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { engine } = createTestWorld({
      config: {
        conversation: {
          inactive_check_turns: 2,
        },
      },
    });
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    const carol = await registerAgent(engine, 'Carol');
    const dave = await registerAgent(engine, 'Dave');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await engine.loginAgent(carol.agent_id);
    await engine.loginAgent(dave.agent_id);
    bot.agentMessages.length = 0;

    engine.state.setNode(alice.agent_id, '3-1');
    engine.state.setNode(bob.agent_id, '3-2');
    engine.state.setNode(carol.agent_id, '3-2');
    engine.state.setNode(dave.agent_id, '3-2');
    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: 'やあ、Alice！',
    });
    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
    });
    engine.joinConversation(dave.agent_id, {
      conversation_id: started.conversation_id,
    });

    bot.agentMessages.length = 0;
    engine.speak(alice.agent_id, {
      message: 'Bob、次をお願い。',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);

    bot.agentMessages.length = 0;
    engine.speak(bob.agent_id, {
      message: 'Alice、続きをどうぞ。',
      next_speaker_agent_id: alice.agent_id,
    });
    vi.advanceTimersByTime(500);

    await vi.waitFor(() => {
      const aliceMessages = bot.agentMessages
        .filter((message) => message.channelId === 'channel-Alice')
        .map((message) => message.content);
      const daveMessages = bot.agentMessages
        .filter((message) => message.channelId === 'channel-Dave')
        .map((message) => message.content);

      expect(aliceMessages.some((message) =>
        message.includes('Bob: 「Alice、続きをどうぞ。」')
        && message.includes('選択肢:')
        && message.includes('conversation_speak'))).toBe(true);
      expect(daveMessages.some((message) =>
        message.includes('Bob: 「Alice、続きをどうぞ。」')
        && message.includes('次は Alice の番です。'))).toBe(true);
      expect(daveMessages.some((message) =>
        message.includes('Bob: 「Alice、続きをどうぞ。」')
        && message.includes('次は Bob の番です。'))).toBe(false);
    });

    handler.dispose();
  });

  it('delivers a two-person farewell without duplicating the closing prompt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 10,
          inactive_check_turns: 10,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    bot.agentMessages.length = 0;

    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: 'やあ、Alice！',
    });

    vi.advanceTimersByTime(500);
    expect(engine.state.conversations.get([...engine.state.conversations.list()][0]!.conversation_id)?.current_speaker_agent_id).toBe(alice.agent_id);

    bot.agentMessages.length = 0;
    engine.endConversation(alice.agent_id, { message: 'またね。', next_speaker_agent_id: bob.agent_id });
    vi.advanceTimersByTime(500);

    await vi.waitFor(() => {
      const bobMessages = bot.agentMessages
        .filter((message) => message.channelId === 'channel-Bob')
        .map((message) => message.content);
      expect(bobMessages.some((message) => message.includes('Alice: 「またね。」'))).toBe(true);
      expect(bobMessages.filter((message) => message.includes('あなたが最後のメッセージを送る番です。'))).toHaveLength(1);
      expect(bobMessages.some((message) => message.includes('これが最後のメッセージです。'))).toBe(false);
      expect(
        bobMessages.findIndex((message) => message.includes('Alice: 「またね。」')),
      ).toBeLessThan(
        bobMessages.findIndex((message) => message.includes('あなたが最後のメッセージを送る番です。')),
      );
    });

    handler.dispose();
  });

  it('delivers pending interval follow-ups when logout interrupts the interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 10,
          inactive_check_turns: 10,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    const carol = await registerAgent(engine, 'Carol');
    const dave = await registerAgent(engine, 'Dave');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await engine.loginAgent(carol.agent_id);
    await engine.loginAgent(dave.agent_id);
    engine.state.setNode(bob.agent_id, '3-2');
    engine.state.setNode(carol.agent_id, '3-2');
    engine.state.setNode(dave.agent_id, '3-2');
    bot.agentMessages.length = 0;

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: 'やあ、Alice！',
    });

    vi.advanceTimersByTime(500);
    expect(engine.state.conversations.get(started.conversation_id)?.current_speaker_agent_id).toBe(alice.agent_id);

    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
    });
    engine.joinConversation(dave.agent_id, {
      conversation_id: started.conversation_id,
    });

    bot.agentMessages.length = 0;
    engine.speak(alice.agent_id, {
      message: 'Bob、次をお願い。',
      next_speaker_agent_id: bob.agent_id,
    });
    await engine.logoutAgent(carol.agent_id);
    vi.advanceTimersByTime(500);

    await vi.waitFor(() => {
      const bobMessages = bot.agentMessages
        .filter((message) => message.channelId === 'channel-Bob')
        .map((message) => message.content);
      expect(bobMessages.some((message) => message.includes('Alice: 「Bob、次をお願い。」'))).toBe(true);
      expect(bobMessages.some((message) => message.includes('conversation_speak'))).toBe(true);
    });

    handler.dispose();
  });

  it('uses the updated closing participants and next speaker after a nominated successor leaves before interval delivery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 3,
          inactive_check_turns: 10,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await registerAgent(engine, 'Alice');
    const bob = await registerAgent(engine, 'Bob');
    const carol = await registerAgent(engine, 'Carol');
    const dave = await registerAgent(engine, 'Dave');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await engine.loginAgent(carol.agent_id);
    await engine.loginAgent(dave.agent_id);
    engine.state.setNode(bob.agent_id, '3-2');
    engine.state.setNode(carol.agent_id, '3-2');
    engine.state.setNode(dave.agent_id, '3-2');
    bot.agentMessages.length = 0;

    const started = engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'こんにちは。',
    });
    engine.acceptConversation(bob.agent_id, {
      message: 'やあ、Alice！',
    });

    vi.advanceTimersByTime(500);
    engine.joinConversation(carol.agent_id, {
      conversation_id: started.conversation_id,
    });
    engine.joinConversation(dave.agent_id, {
      conversation_id: started.conversation_id,
    });

    bot.agentMessages.length = 0;
    engine.speak(alice.agent_id, {
      message: 'Bob、次をお願い。',
      next_speaker_agent_id: bob.agent_id,
    });
    vi.advanceTimersByTime(500);

    bot.agentMessages.length = 0;
    engine.speak(bob.agent_id, {
      message: 'Alice、最後はお願い。',
      next_speaker_agent_id: alice.agent_id,
    });
    detachParticipantFromClosingConversation(engine, started.conversation_id, alice.agent_id);
    vi.advanceTimersByTime(500);

    await vi.waitFor(() => {
      const aliceMessages = bot.agentMessages
        .filter((message) => message.channelId === 'channel-Alice')
        .map((message) => message.content);
      const carolMessages = bot.agentMessages
        .filter((message) => message.channelId === 'channel-Carol')
        .map((message) => message.content);
      const daveMessages = bot.agentMessages
        .filter((message) => message.channelId === 'channel-Dave')
        .map((message) => message.content);

      expect(aliceMessages.some((message) => message.includes('Alice、最後はお願い。'))).toBe(false);
      expect(carolMessages.some((message) => message.includes('Bob: 「Alice、最後はお願い。」'))).toBe(true);
      expect(carolMessages.some((message) => message.includes('これが最後のメッセージです。'))).toBe(true);
      expect(daveMessages.some((message) => message.includes('Bob: 「Alice、最後はお願い。」'))).toBe(true);
      expect(daveMessages.some((message) => message.includes('次は Carol の番です。'))).toBe(true);
      expect(daveMessages.some((message) => message.includes('次は Alice の番です。'))).toBe(false);
    });

    handler.dispose();
  });
});
