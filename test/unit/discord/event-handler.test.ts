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

  it('sends join notifications and world logs', async () => {
    const { engine } = createTestWorld({ withDiscord: true });
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = engine.registerAgent({ agent_name: 'Alice' });
    await engine.joinAgent(alice.agent_id);

    await vi.waitFor(() => {
      expect(bot.agentMessages).toHaveLength(1);
      expect(bot.worldLogMessages).toEqual(['Alice が世界に参加しました']);
    });

    expect(bot.agentMessages[0]).toMatchObject({
      channelId: 'channel-Alice',
    });
    expect(bot.agentMessages[0].content).toContain('世界に参加しました。');
    handler.dispose();
  });

  it('notifies the remaining participant when a conversation is forced to end by leave', async () => {
    const { engine } = createTestWorld({ withDiscord: true });
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = engine.registerAgent({ agent_name: 'Alice' });
    const bob = engine.registerAgent({ agent_name: 'Bob' });
    await engine.joinAgent(alice.agent_id);
    await engine.joinAgent(bob.agent_id);
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

    await engine.leaveAgent(alice.agent_id);

    await vi.waitFor(() => {
      expect(
        bot.agentMessages.some(
          (message) =>
            message.channelId === 'channel-Bob' &&
            message.content.includes('Alice が世界から退出したため、会話が強制終了されました。'),
        ),
      ).toBe(true);
    });
    expect(bot.worldLogMessages).toContain('Alice が世界から退出しました');

    handler.dispose();
  });

  it('uses movement_completed.node_id for arrival notifications', async () => {
    const { engine } = createTestWorld({
      withDiscord: true,
      config: {
        spawn: { nodes: ['3-1'] },
      },
    });
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = engine.registerAgent({ agent_name: 'Alice' });
    await engine.joinAgent(alice.agent_id);
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
