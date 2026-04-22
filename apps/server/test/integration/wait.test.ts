import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DiscordEventHandler } from '../../src/discord/event-handler.js';
import { WAIT_UNIT_MS } from '../../src/domain/wait.js';
import { createTestWorld } from '../helpers/test-world.js';

class RecordingDiscordBot {
  readonly agentMessages: Array<{ channelId: string; content: string }> = [];
  readonly worldLogMessages: string[] = [];

  async sendAgentMessage(channelId: string, content: string): Promise<void> {
    this.agentMessages.push({ channelId, content });
  }

  async sendWorldLog(content: string): Promise<void> {
    this.worldLogMessages.push(content);
  }

  async sendWorldLogAsAgent(content: string): Promise<void> {
    this.worldLogMessages.push(content);
  }
}

describe('wait integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('executes wait end-to-end: idle → in_action → timer fires → idle', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice', });
    await engine.loginAgent(alice.agent_id);

    const response = engine.executeWait(alice.agent_id, { duration: 1 });
    expect(response.completes_at).toBe(Date.now() + WAIT_UNIT_MS);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('in_action');

    vi.advanceTimersByTime(WAIT_UNIT_MS);
    expect(engine.state.getLoggedIn(alice.agent_id)?.state).toBe('idle');
  });

  it('rejects wait when agent is not idle', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice', });
    await engine.loginAgent(alice.agent_id);

    engine.executeWait(alice.agent_id, { duration: 1 });
    expect(() => engine.executeWait(alice.agent_id, { duration: 1 })).toThrow('Agent cannot wait in the current state.');
  });

  it('sends Discord notifications on wait completion', async () => {
    const { engine } = createTestWorld();
    const bot = new RecordingDiscordBot();
    const handler = new DiscordEventHandler(engine, bot as never);
    handler.register();

    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice', });
    await engine.loginAgent(alice.agent_id);
    await vi.waitFor(() => {
      expect(bot.worldLogMessages).toHaveLength(1);
    });
    bot.agentMessages.length = 0;
    bot.worldLogMessages.length = 0;

    engine.executeWait(alice.agent_id, { duration: 1 });
    vi.advanceTimersByTime(WAIT_UNIT_MS);

    await vi.waitFor(() => {
      expect(bot.agentMessages.some((m) => m.content.includes('10分間待機しました。'))).toBe(true);
      expect(bot.worldLogMessages.some((m) => m.includes('10分間待機しました'))).toBe(true);
    });

    handler.dispose();
  });

  it('cancels wait timer when conversation is accepted during wait', async () => {
    const { engine } = createTestWorld({
      config: {
        spawn: { nodes: ['3-1'] },
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice', });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob', });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);

    engine.executeWait(bob.agent_id, { duration: 1 });
    expect(engine.state.getLoggedIn(bob.agent_id)?.state).toBe('in_action');

    engine.startConversation(alice.agent_id, { target_agent_id: bob.agent_id, message: 'hello' });
    const conversation = [...engine.state.conversations.list()][0];
    engine.acceptConversation(bob.agent_id, { message: 'Hey there' });

    expect(engine.state.getLoggedIn(bob.agent_id)?.state).toBe('in_conversation');

    const events: string[] = [];
    engine.eventBus.onAny((event) => {
      events.push(event.type);
    });

    vi.advanceTimersByTime(WAIT_UNIT_MS);
    expect(events).not.toContain('wait_completed');
  });

  it('emits wait_started and wait_completed events', async () => {
    const { engine } = createTestWorld();
    const events: string[] = [];
    engine.eventBus.onAny((event) => {
      events.push(event.type);
    });

    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice', });
    await engine.loginAgent(alice.agent_id);
    events.length = 0;

    engine.executeWait(alice.agent_id, { duration: 1 });
    expect(events).toContain('wait_started');

    vi.advanceTimersByTime(WAIT_UNIT_MS);
    expect(events).toContain('wait_completed');
  });
});
