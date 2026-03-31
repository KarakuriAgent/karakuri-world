import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorldLogThreadCreationError } from '../../../src/discord/bot.js';
import { DiscordEventHandler } from '../../../src/discord/event-handler.js';
import type { WorldEngine } from '../../../src/engine/world-engine.js';
import { createTestWorld } from '../../helpers/test-world.js';

class RecordingDiscordBot {
  readonly agentMessages: Array<{ channelId: string; content: string }> = [];
  readonly worldLogMessages: string[] = [];
  readonly threadMessages = new Map<string, string[]>();
  readonly archivedThreads: string[] = [];
  createWorldLogThreadOverride: ((content: string, threadName: string) => Promise<string>) | null = null;
  sendToThreadOverride: ((threadId: string, content: string) => Promise<void>) | null = null;
  archiveThreadOverride: ((threadId: string) => Promise<void>) | null = null;
  private threadCounter = 0;

  async sendAgentMessage(channelId: string, content: string): Promise<void> {
    this.agentMessages.push({ channelId, content });
  }

  async sendWorldLog(content: string): Promise<void> {
    this.worldLogMessages.push(content);
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

function registerAgent(engine: WorldEngine, agentName: string, agentLabel: string) {
  return engine.registerAgent({
    agent_name: agentName,
    agent_label: agentLabel,
    discord_bot_id: `bot-${agentName.toLowerCase()}`,
  });
}

function expectWorldContextHeader(message: string, agentLabel: string): void {
  expect(message).toContain(`あなた (${agentLabel}) は仮想世界「Karakuri Test World」にログインしています。`);
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

    const alice = registerAgent(engine, 'Alice', 'Clockwork Alice');
    await engine.loginAgent(alice.agent_id);

    await vi.waitFor(() => {
      expect(bot.agentMessages).toHaveLength(1);
      expect(bot.worldLogMessages).toEqual(['Alice が世界にログインしました']);
    });

    expect(bot.agentMessages[0]).toMatchObject({
      channelId: 'channel-Alice',
    });
    expectWorldContextHeader(bot.agentMessages[0].content, 'Clockwork Alice');
    expect(bot.agentMessages[0].content).toContain('世界にログインしました。');
    expect(bot.agentMessages[0].content).toContain('選択肢:');
    expect(bot.agentMessages[0].content).toContain('- move: ノードIDを指定して移動する');
    handler.dispose();
  });

  it('notifies the remaining participant when a conversation is forced to end by logout', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = registerAgent(engine, 'Alice', 'Clockwork Alice');
    const bob = registerAgent(engine, 'Bob', 'Clockwork Bob');
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
      expect(bot.worldLogMessages).toContain('Alice が会話を終了し、ログアウトしました');
      expect(bot.threadMessages.get('thread-1')).toContain('Alice と Bob の会話が終了しました');
      expect(bot.archivedThreads).toContain('thread-1');
    });

    const bobMessage = bot.agentMessages.find((message) => message.channelId === 'channel-Bob');
    expect(bobMessage).toBeDefined();
    expectWorldContextHeader(bobMessage!.content, 'Clockwork Bob');
    expect(bobMessage!.content).toContain('選択肢:');

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

    const alice = registerAgent(engine, 'Alice', 'Clockwork Alice');
    const bob = registerAgent(engine, 'Bob', 'Clockwork Bob');
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

    const alice = registerAgent(engine, 'Alice', 'Clockwork Alice');
    const bob = registerAgent(engine, 'Bob', 'Clockwork Bob');
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
        'Alice: 「こんにちは。」',
        'Bob: 「やあ、Alice！」',
        'Alice と Bob の会話が終了しました',
      ]);
      expect(bot.worldLogMessages).toEqual(['Alice と Bob の会話が始まりました', 'Alice が会話を終了し、ログアウトしました']);
      expect(bot.worldLogMessages).not.toContain('Alice: 「こんにちは。」');
      expect(bot.worldLogMessages).not.toContain('Bob: 「やあ、Alice！」');
      expect(bot.archivedThreads).toContain('thread-1');
    });

    handler.dispose();
  });

  it('writes initial and subsequent conversation messages to the world log', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = registerAgent(engine, 'Alice', 'Clockwork Alice');
    const bob = registerAgent(engine, 'Bob', 'Clockwork Bob');
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
      expect(bot.threadMessages.get('thread-1')).toEqual(['Alice: 「こんにちは。」', 'Bob: 「今日はいい天気ですね。」']);
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

    const alice = registerAgent(engine, 'Alice', 'Clockwork Alice');
    const bob = registerAgent(engine, 'Bob', 'Clockwork Bob');
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
      expect(bot.threadMessages.get('thread-1')).toEqual(['Alice: 「こんにちは。」', 'Bob: 「今日はいい天気ですね。」']);
    });

    await vi.advanceTimersByTimeAsync(500);

    engine.speak(alice.agent_id, {
      message: 'それではまた。',
    });

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toEqual(['Alice と Bob の会話が始まりました']);
      expect(bot.threadMessages.get('thread-1')).toEqual([
        'Alice: 「こんにちは。」',
        'Bob: 「今日はいい天気ですね。」',
        'Alice: 「それではまた。」',
      ]);
    });

    await vi.advanceTimersByTimeAsync(500);

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toEqual(['Alice と Bob の会話が始まりました']);
      expect(bot.threadMessages.get('thread-1')).toEqual([
        'Alice: 「こんにちは。」',
        'Bob: 「今日はいい天気ですね。」',
        'Alice: 「それではまた。」',
        'Alice と Bob の会話が終了しました',
      ]);
      expect(bot.threadMessages.get('thread-1')?.filter((message) => message === 'Alice: 「それではまた。」')).toHaveLength(1);
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

    const alice = registerAgent(engine, 'Alice', 'Clockwork Alice');
    const bob = registerAgent(engine, 'Bob', 'Clockwork Bob');
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
        'Alice: 「こんにちは。」',
        'Bob: 「今日はいい天気ですね。」',
      ]);
    });

    await engine.logoutAgent(alice.agent_id);

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toContain('Alice と Bob の会話が終了しました');
      expect(bot.worldLogMessages).toContain('Alice が会話を終了し、ログアウトしました');
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

    const alice = registerAgent(engine, 'Alice', 'Clockwork Alice');
    const bob = registerAgent(engine, 'Bob', 'Clockwork Bob');
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
        'Alice: 「こんにちは。」',
        'Bob: 「やあ、Alice！」',
        'Alice と Bob の会話が終了しました',
        'Alice が会話を終了し、ログアウトしました',
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

    const alice = registerAgent(engine, 'Alice', 'Clockwork Alice');
    const bob = registerAgent(engine, 'Bob', 'Clockwork Bob');
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
        'Alice: 「こんにちは。」',
        'Bob: 「今日はいい天気ですね。」',
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

    const alice = registerAgent(engine, 'Alice', 'Clockwork Alice');
    const bob = registerAgent(engine, 'Bob', 'Clockwork Bob');
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
      expect(bot.worldLogMessages).toContain('Alice: 「こんにちは。」');
      expect(bot.threadMessages.get('thread-1')).toEqual(['Bob: 「今日はいい天気ですね。」']);
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

    const alice = registerAgent(engine, 'Alice', 'Clockwork Alice');
    const bob = registerAgent(engine, 'Bob', 'Clockwork Bob');
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
      expect(bot.threadMessages.get('thread-1')).toEqual(['Alice: 「こんにちは。」', 'Bob: 「今日はいい天気ですね。」']);
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

    const alice = registerAgent(engine, 'Alice', 'Clockwork Alice');
    const bob = registerAgent(engine, 'Bob', 'Clockwork Bob');
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
      expect(bot.threadMessages.get('thread-1')).toEqual(['Alice: 「こんにちは。」', 'Bob: 「今日はいい天気ですね。」']);
    });

    await engine.logoutAgent(alice.agent_id);

    await vi.waitFor(() => {
      expect(bot.threadMessages.get('thread-1')).toContain('Alice と Bob の会話が終了しました');
      expect(bot.worldLogMessages).not.toContain('Alice と Bob の会話が終了しました');
      expect(bot.worldLogMessages).toContain('Alice が会話を終了し、ログアウトしました');
    });

    handler.dispose();
  });

  it('sends logout notification to agent channel and world log', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = registerAgent(engine, 'Alice', 'Clockwork Alice');
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
    expect(bot.worldLogMessages).toContain('Alice が世界からログアウトしました');

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

    const alice = registerAgent(engine, 'Alice', 'Clockwork Alice');
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
      agent_name: 'Alice',
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
      expect(bot.worldLogMessages).toContain('Alice が 3-4 (Workshop Door) に到着しました');
    });

    const arrivalMessage = bot.agentMessages.find((message) => message.channelId === 'channel-Alice');
    expect(arrivalMessage).toBeDefined();
    expectWorldContextHeader(arrivalMessage!.content, 'Clockwork Alice');
    expect(arrivalMessage!.content).toContain('選択肢:');

    handler.dispose();
  });

  it('personalizes server event notifications with each agent label', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = registerAgent(engine, 'Alice', 'Clockwork Alice');
    const bob = registerAgent(engine, 'Bob', 'Clockwork Bob');
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(2);
    });
    bot.agentMessages.length = 0;
    bot.worldLogMessages.length = 0;

    engine.fireServerEvent('sudden-rain');

    await vi.waitFor(() => {
      expect(bot.agentMessages).toHaveLength(2);
    });

    const aliceMessage = bot.agentMessages.find((message) => message.channelId === 'channel-Alice');
    const bobMessage = bot.agentMessages.find((message) => message.channelId === 'channel-Bob');
    expect(aliceMessage).toBeDefined();
    expect(bobMessage).toBeDefined();
    expectWorldContextHeader(aliceMessage!.content, 'Clockwork Alice');
    expectWorldContextHeader(bobMessage!.content, 'Clockwork Bob');
    expect(aliceMessage!.content).toContain('【サーバーイベント】Sudden Rain');
    expect(bobMessage!.content).toContain('【サーバーイベント】Sudden Rain');
    expect(aliceMessage!.content).not.toBe(bobMessage!.content);

    handler.dispose();
  });

  it('sends notification-based info responses for map, perception, actions, and world agents', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = registerAgent(engine, 'Alice', 'Clockwork Alice');
    const bob = registerAgent(engine, 'Bob', 'Clockwork Bob');
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
});
