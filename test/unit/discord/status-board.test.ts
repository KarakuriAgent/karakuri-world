import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StatusBoard, type StatusBoardChannel } from '../../../src/discord/status-board.js';
import { createTestWorld } from '../../helpers/test-world.js';

function createMockChannel(): StatusBoardChannel & {
  fetchMessages: ReturnType<typeof vi.fn>;
  bulkDelete: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  sendMessageWithImage: ReturnType<typeof vi.fn>;
} {
  let messageCounter = 0;
  return {
    fetchMessages: vi.fn(async () => []),
    bulkDelete: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ id: `sent-${++messageCounter}` })),
    sendMessageWithImage: vi.fn(async () => ({ id: `sent-${++messageCounter}` })),
  };
}

async function flushAsyncWork(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('StatusBoard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T05:30:00Z'));
  });

  it('renders immediately on register and attaches the map image to the first message', async () => {
    const { engine } = createTestWorld();
    const channel = createMockChannel();
    const board = new StatusBoard(engine, channel, {
      timezone: 'Asia/Tokyo',
      debounceMs: 3000,
      mapImage: Buffer.from('png-data'),
    });

    board.register();
    await flushAsyncWork();

    expect(channel.fetchMessages).toHaveBeenCalledTimes(1);
    expect(channel.sendMessageWithImage).toHaveBeenCalledTimes(1);
    expect(channel.sendMessageWithImage.mock.calls[0]?.[2]).toBe('world-map.png');
  });

  it('debounces event bursts and re-runs after an in-flight refresh finishes', async () => {
    const { engine } = createTestWorld();
    const channel = createMockChannel();
    let resolveSend: ((value: { id: string }) => void) | undefined;
    channel.sendMessage.mockImplementationOnce(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveSend = resolve;
        }),
    );

    const board = new StatusBoard(engine, channel, {
      timezone: 'Asia/Tokyo',
      debounceMs: 3000,
      mapImage: null,
    });

    board.register();
    await flushAsyncWork();

    const agent = engine.registerAgent({
      agent_name: 'sakura',
      agent_label: 'Sakura',
      discord_bot_id: 'discord-bot-1',
    });
    await engine.loginAgent(agent.agent_id);

    if (resolveSend) {
      resolveSend({ id: 'delayed-send' });
    }
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(3000);
    await flushAsyncWork();

    expect(channel.fetchMessages).toHaveBeenCalledTimes(2);
    expect(channel.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('falls back to deleting messages one by one when bulk delete fails', async () => {
    const { engine } = createTestWorld();
    const channel = createMockChannel();
    channel.fetchMessages.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);
    channel.bulkDelete.mockRejectedValue(new Error('too old'));

    const board = new StatusBoard(engine, channel, {
      timezone: 'Asia/Tokyo',
      debounceMs: 3000,
      mapImage: null,
    });

    board.register();
    await flushAsyncWork();

    expect(channel.bulkDelete).toHaveBeenCalledWith(['m1', 'm2']);
    expect(channel.deleteMessage).toHaveBeenCalledWith('m1');
    expect(channel.deleteMessage).toHaveBeenCalledWith('m2');
  });

  it('refreshes when the last active server event expires', async () => {
    const { engine } = createTestWorld();
    const channel = createMockChannel();
    const board = new StatusBoard(engine, channel, {
      timezone: 'Asia/Tokyo',
      debounceMs: 3000,
      mapImage: null,
    });

    const agent = engine.registerAgent({
      agent_name: 'ame',
      agent_label: 'Ame',
      discord_bot_id: 'discord-bot-3',
    });

    board.register();
    await flushAsyncWork();
    await engine.loginAgent(agent.agent_id);
    await vi.advanceTimersByTimeAsync(3000);
    await flushAsyncWork();

    channel.fetchMessages.mockClear();
    channel.sendMessage.mockClear();

    engine.fireServerEvent('sudden-rain');
    await vi.advanceTimersByTimeAsync(3000);
    await flushAsyncWork();

    expect(channel.fetchMessages).toHaveBeenCalledTimes(1);

    channel.fetchMessages.mockClear();
    channel.sendMessage.mockClear();

    await vi.advanceTimersByTimeAsync(5000);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(3000);
    await flushAsyncWork();

    expect(channel.fetchMessages).toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalled();
  });

  it('refreshes when a timeout changes outstanding server event counts before final cleanup', async () => {
    const { engine } = createTestWorld({
      config: {
        movement: {
          duration_ms: 3000,
        },
      },
    });
    const channel = createMockChannel();
    const board = new StatusBoard(engine, channel, {
      timezone: 'Asia/Tokyo',
      debounceMs: 3000,
      mapImage: null,
    });

    const alice = engine.registerAgent({
      agent_name: 'alice',
      agent_label: 'Alice',
      discord_bot_id: 'discord-bot-a',
    });
    const bob = engine.registerAgent({
      agent_name: 'bob',
      agent_label: 'Bob',
      discord_bot_id: 'discord-bot-b',
    });

    board.register();
    await flushAsyncWork();
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(bob.agent_id, '3-1');
    await vi.advanceTimersByTimeAsync(3000);
    await flushAsyncWork();

    channel.fetchMessages.mockClear();
    channel.sendMessage.mockClear();

    engine.move(bob.agent_id, { target_node_id: '3-4' });
    engine.fireServerEvent('sudden-rain');
    await vi.advanceTimersByTimeAsync(3000);
    await flushAsyncWork();

    channel.fetchMessages.mockClear();
    channel.sendMessage.mockClear();

    await vi.advanceTimersByTimeAsync(2000);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(3000);
    await flushAsyncWork();

    expect(channel.fetchMessages).toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalled();
  });

  it('refreshes when a conversation enters closing state', async () => {
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
    const channel = createMockChannel();
    const board = new StatusBoard(engine, channel, {
      timezone: 'Asia/Tokyo',
      debounceMs: 3000,
      mapImage: null,
    });

    const alice = engine.registerAgent({
      agent_name: 'alice',
      agent_label: 'Alice',
      discord_bot_id: 'discord-bot-a',
    });
    const bob = engine.registerAgent({
      agent_name: 'bob',
      agent_label: 'Bob',
      discord_bot_id: 'discord-bot-b',
    });

    board.register();
    await flushAsyncWork();
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(bob.agent_id, '3-2');
    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });
    await vi.advanceTimersByTimeAsync(3500);
    await flushAsyncWork();

    channel.fetchMessages.mockClear();
    channel.sendMessage.mockClear();

    await vi.advanceTimersByTimeAsync(500);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(3000);
    await flushAsyncWork();

    expect(channel.fetchMessages).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalled();
  });

  it('refreshes when a conversation turn changes without a dedicated event', async () => {
    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 10,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const channel = createMockChannel();
    const board = new StatusBoard(engine, channel, {
      timezone: 'Asia/Tokyo',
      debounceMs: 10,
      mapImage: null,
    });

    const alice = engine.registerAgent({
      agent_name: 'alice',
      agent_label: 'Alice',
      discord_bot_id: 'discord-bot-a',
    });
    const bob = engine.registerAgent({
      agent_name: 'bob',
      agent_label: 'Bob',
      discord_bot_id: 'discord-bot-b',
    });

    board.register();
    await flushAsyncWork();
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(bob.agent_id, '3-2');
    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });
    await vi.advanceTimersByTimeAsync(10);
    await flushAsyncWork();

    channel.fetchMessages.mockClear();
    channel.sendMessage.mockClear();

    await vi.advanceTimersByTimeAsync(501);
    await flushAsyncWork();

    expect(channel.fetchMessages).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('refreshes after speaking and re-arms interval-driven conversation updates', async () => {
    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 10,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const channel = createMockChannel();
    const board = new StatusBoard(engine, channel, {
      timezone: 'Asia/Tokyo',
      debounceMs: 10,
      mapImage: null,
    });

    const alice = engine.registerAgent({
      agent_name: 'alice',
      agent_label: 'Alice',
      discord_bot_id: 'discord-bot-a',
    });
    const bob = engine.registerAgent({
      agent_name: 'bob',
      agent_label: 'Bob',
      discord_bot_id: 'discord-bot-b',
    });

    board.register();
    await flushAsyncWork();
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(bob.agent_id, '3-2');
    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });
    await vi.advanceTimersByTimeAsync(10);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(501);
    await flushAsyncWork();

    channel.fetchMessages.mockClear();
    channel.sendMessage.mockClear();

    engine.speak(alice.agent_id, { message: 'How are you?' });
    await vi.advanceTimersByTimeAsync(10);
    await flushAsyncWork();

    expect(channel.fetchMessages).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledTimes(1);

    channel.fetchMessages.mockClear();
    channel.sendMessage.mockClear();

    await vi.advanceTimersByTimeAsync(501);
    await flushAsyncWork();

    expect(channel.fetchMessages).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('runs an immediate catch-up refresh when a conversation handoff elapses mid-refresh', async () => {
    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 10,
          interval_ms: 50,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const channel = createMockChannel();
    const board = new StatusBoard(engine, channel, {
      timezone: 'Asia/Tokyo',
      debounceMs: 10,
      mapImage: null,
    });

    const alice = engine.registerAgent({
      agent_name: 'alice',
      agent_label: 'Alice',
      discord_bot_id: 'discord-bot-a',
    });
    const bob = engine.registerAgent({
      agent_name: 'bob',
      agent_label: 'Bob',
      discord_bot_id: 'discord-bot-b',
    });

    board.register();
    await flushAsyncWork();
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(bob.agent_id, '3-2');
    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });
    await vi.advanceTimersByTimeAsync(61);
    await flushAsyncWork();

    channel.fetchMessages.mockClear();
    channel.sendMessage.mockClear();
    channel.sendMessage
      .mockImplementationOnce(
        () =>
          new Promise<{ id: string }>((resolve) => {
            setTimeout(() => resolve({ id: 'delayed-send' }), 100);
          }),
      )
      .mockResolvedValue({ id: 'sent-after-delay' });

    engine.speak(alice.agent_id, { message: 'How are you?' });
    await vi.advanceTimersByTimeAsync(120);
    await flushAsyncWork();

    expect(channel.fetchMessages).toHaveBeenCalledTimes(2);
    expect(channel.sendMessage).toHaveBeenCalledTimes(2);
    expect(channel.sendMessage.mock.calls[0]?.[0]).toContain('aliceの番');
    expect(channel.sendMessage.mock.calls[1]?.[0]).toContain('bobの番');
  });

  it('re-arms the conversation handoff refresh immediately when debounce exceeds the interval', async () => {
    const { engine } = createTestWorld({
      config: {
        conversation: {
          max_turns: 10,
          interval_ms: 500,
          accept_timeout_ms: 1000,
          turn_timeout_ms: 1000,
        },
      },
    });
    const channel = createMockChannel();
    const board = new StatusBoard(engine, channel, {
      timezone: 'Asia/Tokyo',
      debounceMs: 1000,
      mapImage: null,
    });

    const alice = engine.registerAgent({
      agent_name: 'alice',
      agent_label: 'Alice',
      discord_bot_id: 'discord-bot-a',
    });
    const bob = engine.registerAgent({
      agent_name: 'bob',
      agent_label: 'Bob',
      discord_bot_id: 'discord-bot-b',
    });

    board.register();
    await flushAsyncWork();
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(bob.agent_id, '3-2');
    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hi' });
    await vi.advanceTimersByTimeAsync(1001);
    await flushAsyncWork();

    channel.fetchMessages.mockClear();
    channel.sendMessage.mockClear();

    engine.speak(alice.agent_id, { message: 'How are you?' });
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(499);
    await flushAsyncWork();

    expect(channel.fetchMessages).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    await flushAsyncWork();

    expect(channel.fetchMessages).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('refreshes when a moving agent crosses into the next node', async () => {
    const { engine } = createTestWorld();
    const channel = createMockChannel();
    const board = new StatusBoard(engine, channel, {
      timezone: 'Asia/Tokyo',
      debounceMs: 10,
      mapImage: null,
    });

    const agent = engine.registerAgent({
      agent_name: 'sakura',
      agent_label: 'Sakura',
      discord_bot_id: 'discord-bot-1',
    });

    board.register();
    await flushAsyncWork();
    await engine.loginAgent(agent.agent_id);
    await vi.advanceTimersByTimeAsync(10);
    await flushAsyncWork();

    channel.fetchMessages.mockClear();
    channel.sendMessage.mockClear();

    engine.move(agent.agent_id, { target_node_id: '3-4' });
    await vi.advanceTimersByTimeAsync(10);
    await flushAsyncWork();

    channel.fetchMessages.mockClear();
    channel.sendMessage.mockClear();

    await vi.advanceTimersByTimeAsync(1000);
    await flushAsyncWork();

    expect(channel.fetchMessages).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('sends a stopped message during dispose', async () => {
    const { engine } = createTestWorld();
    const channel = createMockChannel();
    channel.fetchMessages
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'm1' }]);

    const board = new StatusBoard(engine, channel, {
      timezone: 'Asia/Tokyo',
      debounceMs: 3000,
      mapImage: null,
    });

    board.register();
    await flushAsyncWork();
    await board.dispose();

    expect(channel.bulkDelete).toHaveBeenCalledWith(['m1']);
    expect(channel.sendMessage).toHaveBeenLastCalledWith('ワールド停止中');
  });

  it('reposts identical content when the previous board messages are missing', async () => {
    const { engine } = createTestWorld();
    const channel = createMockChannel();
    const board = new StatusBoard(engine, channel, {
      timezone: 'Asia/Tokyo',
      debounceMs: 3000,
      mapImage: null,
    });

    board.register();
    await flushAsyncWork();

    channel.fetchMessages.mockClear();
    channel.bulkDelete.mockClear();
    channel.sendMessage.mockClear();
    channel.fetchMessages.mockResolvedValue([]);

    await (board as unknown as { performRefresh(): Promise<void> }).performRefresh();

    expect(channel.fetchMessages).toHaveBeenCalledTimes(1);
    expect(channel.bulkDelete).not.toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('reposts identical content when the channel no longer has the last board message ids', async () => {
    const { engine } = createTestWorld();
    const channel = createMockChannel();
    const board = new StatusBoard(engine, channel, {
      timezone: 'Asia/Tokyo',
      debounceMs: 3000,
      mapImage: null,
    });

    board.register();
    await flushAsyncWork();

    channel.fetchMessages.mockClear();
    channel.bulkDelete.mockClear();
    channel.sendMessage.mockClear();
    channel.fetchMessages.mockResolvedValue([{ id: 'unexpected-message' }]);

    await (board as unknown as { performRefresh(): Promise<void> }).performRefresh();

    expect(channel.fetchMessages).toHaveBeenCalledTimes(1);
    expect(channel.bulkDelete).toHaveBeenCalledWith(['unexpected-message']);
    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('reposts identical content when the channel has extra stray messages', async () => {
    const { engine } = createTestWorld();
    const channel = createMockChannel();
    const board = new StatusBoard(engine, channel, {
      timezone: 'Asia/Tokyo',
      debounceMs: 3000,
      mapImage: null,
    });

    board.register();
    await flushAsyncWork();

    const firstBoardMessageId = channel.sendMessage.mock.results[0]?.value;
    const resolvedFirstBoardMessage = await firstBoardMessageId;

    channel.fetchMessages.mockClear();
    channel.bulkDelete.mockClear();
    channel.sendMessage.mockClear();
    channel.fetchMessages.mockResolvedValue([
      { id: resolvedFirstBoardMessage.id },
      { id: 'stray-message' },
    ]);

    await (board as unknown as { performRefresh(): Promise<void> }).performRefresh();

    expect(channel.fetchMessages).toHaveBeenCalledTimes(1);
    expect(channel.bulkDelete).toHaveBeenCalledWith([resolvedFirstBoardMessage.id, 'stray-message']);
    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not schedule a refresh for non-triggering events', async () => {
    const { engine } = createTestWorld();
    const channel = createMockChannel();
    const board = new StatusBoard(engine, channel, {
      timezone: 'Asia/Tokyo',
      debounceMs: 3000,
      mapImage: null,
    });

    const agent = engine.registerAgent({
      agent_name: 'sakura',
      agent_label: 'Sakura',
      discord_bot_id: 'discord-bot-1',
    });

    board.register();
    await flushAsyncWork();
    await engine.loginAgent(agent.agent_id);
    await vi.advanceTimersByTimeAsync(3000);
    await flushAsyncWork();

    channel.fetchMessages.mockClear();
    channel.sendMessage.mockClear();

    // Emit a non-triggering event (perception_requested)
    engine.emitEvent({ type: 'perception_requested', agent_id: agent.agent_id });
    await vi.advanceTimersByTimeAsync(3000);
    await flushAsyncWork();

    expect(channel.fetchMessages).not.toHaveBeenCalled();
  });

  it('completes dispose gracefully when a refresh is in-flight', async () => {
    const { engine } = createTestWorld();
    const channel = createMockChannel();
    let resolveSend: ((value: { id: string }) => void) | undefined;
    channel.sendMessage.mockImplementationOnce(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveSend = resolve;
        }),
    );

    const board = new StatusBoard(engine, channel, {
      timezone: 'Asia/Tokyo',
      debounceMs: 3000,
      mapImage: null,
    });

    board.register();
    await flushAsyncWork();
    // sendMessage is now hanging (performRefresh reached the send call)

    // dispose while refresh is in-flight
    const disposePromise = board.dispose();

    // resolve the hanging send so refreshPromise can settle
    resolveSend!({ id: 'delayed-send' });
    await flushAsyncWork();
    await disposePromise;

    // After dispose, no further refreshes should be scheduled
    channel.fetchMessages.mockClear();
    channel.sendMessage.mockClear();

    engine.registerAgent({
      agent_name: 'taro',
      agent_label: 'Taro',
      discord_bot_id: 'discord-bot-2',
    });
    await vi.advanceTimersByTimeAsync(3000);
    await flushAsyncWork();

    expect(channel.fetchMessages).not.toHaveBeenCalled();
  });

  it('recovers from refresh failures and can refresh again later', async () => {
    const { engine } = createTestWorld();
    const channel = createMockChannel();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    channel.sendMessage
      .mockRejectedValueOnce(new Error('send failed'))
      .mockResolvedValue({ id: 'sent-after-retry' });

    const board = new StatusBoard(engine, channel, {
      timezone: 'Asia/Tokyo',
      debounceMs: 3000,
      mapImage: null,
    });

    board.register();
    await flushAsyncWork();

    const agent = engine.registerAgent({
      agent_name: 'taro',
      agent_label: 'Taro',
      discord_bot_id: 'discord-bot-2',
    });
    await engine.loginAgent(agent.agent_id);
    await vi.advanceTimersByTimeAsync(3000);
    await flushAsyncWork();

    expect(errorSpy).toHaveBeenCalledWith('Failed to refresh status board.', expect.any(Error));
    expect(channel.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('treats stopped-message delivery as best effort during dispose', async () => {
    const { engine } = createTestWorld();
    const channel = createMockChannel();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    channel.fetchMessages
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('fetch failed'));

    const board = new StatusBoard(engine, channel, {
      timezone: 'Asia/Tokyo',
      debounceMs: 3000,
      mapImage: null,
    });

    board.register();
    await flushAsyncWork();

    await expect(board.dispose()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('Failed to post stopped status board.', expect.any(Error));
  });
});
