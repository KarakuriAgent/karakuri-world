import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiscordEventHandler } from '../../../src/discord/event-handler.js';
import { createTestWorld } from '../../helpers/test-world.js';

class RecordingDiscordBot {
  readonly agentMessages: Array<{ channelId: string; content: string }> = [];
  readonly worldLogMessages: string[] = [];

  async sendAgentMessage(channelId: string, content: string): Promise<void> {
    this.agentMessages.push({ channelId, content });
  }

  async sendWorldLog(content: string): Promise<void> {
    this.worldLogMessages.push(content);
  }
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

    const alice = engine.registerAgent({ agent_name: 'Alice', discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);

    await vi.waitFor(() => {
      expect(bot.agentMessages).toHaveLength(1);
      expect(bot.worldLogMessages).toEqual(['Alice が世界にログインしました']);
    });

    expect(bot.agentMessages[0]).toMatchObject({
      channelId: 'channel-Alice',
    });
    expect(bot.agentMessages[0].content).toContain('世界にログインしました。');
    handler.dispose();
  });

  it('notifies the remaining participant when a conversation is forced to end by logout', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = engine.registerAgent({ agent_name: 'Alice', discord_bot_id: 'bot-alice' });
    const bob = engine.registerAgent({ agent_name: 'Bob', discord_bot_id: 'bot-bob' });
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
      conversation_id: conversation.conversation_id,
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
    });

    handler.dispose();
  });

  it('writes initial and subsequent conversation messages to the world log', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = engine.registerAgent({ agent_name: 'Alice', discord_bot_id: 'bot-alice' });
    const bob = engine.registerAgent({ agent_name: 'Bob', discord_bot_id: 'bot-bob' });
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
      conversation_id: conversation.conversation_id,
    });

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toEqual([
        'Alice と Bob の会話が始まりました',
        'Alice: 「こんにちは。」',
      ]);
    });

    engine.speak(bob.agent_id, {
      conversation_id: conversation.conversation_id,
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

  it('does not duplicate closing messages in the world log', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 2,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = engine.registerAgent({ agent_name: 'Alice', discord_bot_id: 'bot-alice' });
    const bob = engine.registerAgent({ agent_name: 'Bob', discord_bot_id: 'bot-bob' });
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
      conversation_id: conversation.conversation_id,
    });

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toEqual([
        'Alice と Bob の会話が始まりました',
        'Alice: 「こんにちは。」',
      ]);
    });

    engine.speak(bob.agent_id, {
      conversation_id: conversation.conversation_id,
      message: '今日はいい天気ですね。',
    });

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toEqual([
        'Alice と Bob の会話が始まりました',
        'Alice: 「こんにちは。」',
        'Bob: 「今日はいい天気ですね。」',
      ]);
    });

    await vi.advanceTimersByTimeAsync(500);

    engine.speak(alice.agent_id, {
      conversation_id: conversation.conversation_id,
      message: 'それではまた。',
    });

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toEqual([
        'Alice と Bob の会話が始まりました',
        'Alice: 「こんにちは。」',
        'Bob: 「今日はいい天気ですね。」',
        'Alice: 「それではまた。」',
      ]);
    });

    await vi.advanceTimersByTimeAsync(500);

    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toEqual([
        'Alice と Bob の会話が始まりました',
        'Alice: 「こんにちは。」',
        'Bob: 「今日はいい天気ですね。」',
        'Alice: 「それではまた。」',
        'Alice と Bob の会話が終了しました',
      ]);
      expect(bot.worldLogMessages.filter((message) => message === 'Alice: 「それではまた。」')).toHaveLength(1);
    });

    handler.dispose();
  });

  it('sends logout notification to agent channel and world log', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = engine.registerAgent({ agent_name: 'Alice', discord_bot_id: 'bot-alice' });
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

    const alice = engine.registerAgent({ agent_name: 'Alice', discord_bot_id: 'bot-alice' });
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

    handler.dispose();
  });
});
