import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { AdminCommandHandler } from '../../../src/discord/admin-commands.js';
import { createTestWorld } from '../../helpers/test-world.js';

type MockBot = {
  registerGuildCommands: ReturnType<typeof vi.fn>;
  registerInteractionHandler: ReturnType<typeof vi.fn>;
  emit: (interaction: unknown) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
};

type MockCommandInteraction = ReturnType<typeof createCommandInteraction>;
type MockAutocompleteInteraction = ReturnType<typeof createAutocompleteInteraction>;

function createMockBot(): MockBot {
  let interactionHandler: ((interaction: unknown) => void) | null = null;
  const unsubscribe = vi.fn();
  return {
    registerGuildCommands: vi.fn(async () => undefined),
    registerInteractionHandler: vi.fn((handler: (interaction: unknown) => void) => {
      interactionHandler = handler;
      return unsubscribe;
    }),
    emit(interaction: unknown) {
      if (!interactionHandler) {
        throw new Error('interaction handler is not registered');
      }
      interactionHandler(interaction);
    },
    unsubscribe,
  };
}

function createMember(
  roleIds: string[],
  options?: { administrator?: boolean },
): { roles: { cache: Map<string, string> }; permissions: { has: (flag: bigint) => boolean } } {
  const isAdmin = options?.administrator ?? false;
  return {
    roles: {
      cache: new Map(roleIds.map((roleId) => [roleId, roleId])),
    },
    permissions: {
      has: () => isAdmin,
    },
  };
}

function createCommandInteraction(
  commandName: string,
  values: Record<string, string> = {},
  overrides: Partial<Record<'channelId' | 'member', unknown>> & {
    deferReply?: ReturnType<typeof vi.fn>;
    editReply?: ReturnType<typeof vi.fn>;
    followUp?: ReturnType<typeof vi.fn>;
    reply?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const interaction = {
    channelId: 'world-admin',
    member: createMember(['admin-role']),
    commandName,
    deferred: false,
    replied: false,
    options: {
      getString(name: string, required?: boolean): string | null {
        const value = values[name];
        if (value === undefined) {
          if (required) {
            throw new Error(`Missing option: ${name}`);
          }
          return null;
        }
        return value;
      },
    },
    deferReply: overrides.deferReply ?? vi.fn(async (_payload) => {
      interaction.deferred = true;
    }),
    editReply: overrides.editReply ?? vi.fn(async (_payload) => {
      interaction.replied = true;
    }),
    followUp: overrides.followUp ?? vi.fn(async () => undefined),
    reply: overrides.reply ?? vi.fn(async () => undefined),
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    ...overrides,
  };

  return interaction;
}

function createAutocompleteInteraction(
  commandName: string,
  focused: string,
  overrides: Partial<Record<'channelId' | 'member', unknown>> & {
    respond?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    channelId: 'world-admin',
    member: createMember(['admin-role']),
    commandName,
    options: {
      getFocused: () => focused,
    },
    respond: overrides.respond ?? vi.fn(async () => undefined),
    isChatInputCommand: () => false,
    isAutocomplete: () => true,
    ...overrides,
  };
}

async function flushAsyncWork(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('AdminCommandHandler', () => {
  it('registers guild commands once and unsubscribes on dispose', async () => {
    const { engine } = createTestWorld();
    const bot = createMockBot();
    const handler = new AdminCommandHandler(engine, 'http://127.0.0.1:3000/', 'admin-role', 'world-admin');

    await handler.register(bot as never);
    await handler.register(bot as never);
    handler.dispose();

    expect(bot.registerGuildCommands).toHaveBeenCalledTimes(1);
    const [commands] = bot.registerGuildCommands.mock.calls[0];
    expect(commands).toHaveLength(9);
    expect(commands.map((command: { name: string }) => command.name)).toEqual([
      'agent-list',
      'agent-register',
      'agent-delete',
      'fire-announcement',
      'create-event',
      'clear-event',
      'list-event',
      'login-agent',
      'logout-agent',
    ]);
    expect(bot.registerInteractionHandler).toHaveBeenCalledTimes(1);
    expect(bot.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('lists agents and splits long responses into follow-up messages', async () => {
    const { engine } = createTestWorld();
    for (let index = 0; index < 30; index++) {
      await engine.registerAgent({
        discord_bot_id: `bot-${index}`,
      });
    }

    const bot = createMockBot();
    const handler = new AdminCommandHandler(engine, 'http://127.0.0.1:3000', 'admin-role', 'world-admin');
    await handler.register(bot as never);

    const interaction = createCommandInteraction('agent-list');
    bot.emit(interaction);
    await flushAsyncWork();

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.followUp.mock.calls.length).toBeGreaterThanOrEqual(0);
  });

  it('registers an agent and returns credentials', async () => {
    const { engine } = createTestWorld();
    const bot = createMockBot();
    const handler = new AdminCommandHandler(engine, 'http://127.0.0.1:3000/', 'admin-role', 'world-admin');
    await handler.register(bot as never);

    const interaction = createCommandInteraction('agent-register', {
      discord_bot_id: '123456789012345678',
    });
    bot.emit(interaction);
    await flushAsyncWork();

    expect(engine.listAgents()).toHaveLength(1);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('api_base_url: http://127.0.0.1:3000/api'));
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('mcp_endpoint: http://127.0.0.1:3000/mcp'));
  });

  it('deletes, logs in, logs out, and fires events through slash commands', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({
      discord_bot_id: 'bot-alice',
    });
    const bob = await engine.registerAgent({
      discord_bot_id: 'bot-bob',
    });

    const bot = createMockBot();
    const handler = new AdminCommandHandler(engine, 'http://127.0.0.1:3000', 'admin-role', 'world-admin');
    await handler.register(bot as never);

    const loginInteraction = createCommandInteraction('login-agent', { agent_name: 'alice' });
    bot.emit(loginInteraction);
    await flushAsyncWork();
    expect(loginInteraction.editReply).toHaveBeenCalledWith(expect.stringContaining('channel_id: channel-alice'));

    const logoutInteraction = createCommandInteraction('logout-agent', { agent_name: 'alice' });
    bot.emit(logoutInteraction);
    await flushAsyncWork();
    expect(logoutInteraction.editReply).toHaveBeenCalledWith('エージェントをログアウトしました: alice');

    const fireEventInteraction = createCommandInteraction('fire-announcement', { description: '  テスト通知  ' });
    bot.emit(fireEventInteraction);
    await flushAsyncWork();
    expect(fireEventInteraction.editReply).toHaveBeenCalledWith(expect.stringContaining('サーバーアナウンスを発火しました: server-announcement-'));

    const deleteInteraction = createCommandInteraction('agent-delete', { agent_name: 'bob' });
    bot.emit(deleteInteraction);
    await flushAsyncWork();
    expect(deleteInteraction.editReply).toHaveBeenCalledWith('エージェントを削除しました: bob');
    expect(engine.getAgentById(bob.agent_id)).toBeNull();
    expect(engine.getAgentById(alice.agent_id)).not.toBeNull();
  });

  it('rejects commands outside #world-admin and without the admin role', async () => {
    const { engine } = createTestWorld();
    const bot = createMockBot();
    const handler = new AdminCommandHandler(engine, 'http://127.0.0.1:3000', 'admin-role', 'world-admin');
    await handler.register(bot as never);

    const wrongChannel = createCommandInteraction('agent-list', {}, { channelId: 'world-log' });
    bot.emit(wrongChannel);
    await flushAsyncWork();
    expect(wrongChannel.editReply).toHaveBeenCalledWith('このコマンドは #world-admin でのみ使用できます。');

    const noRole = createCommandInteraction('agent-list', {}, { member: createMember(['human-role']) });
    bot.emit(noRole);
    await flushAsyncWork();
    expect(noRole.editReply).toHaveBeenCalledWith('権限がありません。');
  });

  it('returns empty autocomplete results when permissions are missing', async () => {
    const { engine } = createTestWorld();
    await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bot = createMockBot();
    const handler = new AdminCommandHandler(engine, 'http://127.0.0.1:3000', 'admin-role', 'world-admin');
    await handler.register(bot as never);

    const interaction = createAutocompleteInteraction('agent-delete', 'a', { member: createMember(['human-role']) });
    bot.emit(interaction);
    await flushAsyncWork();

    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  it('returns empty autocomplete results outside #world-admin', async () => {
    const { engine } = createTestWorld();
    await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bot = createMockBot();
    const handler = new AdminCommandHandler(engine, 'http://127.0.0.1:3000', 'admin-role', 'world-admin');
    await handler.register(bot as never);

    const interaction = createAutocompleteInteraction('agent-delete', 'a', { channelId: 'world-log' });
    bot.emit(interaction);
    await flushAsyncWork();

    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  it('filters autocomplete candidates by command state', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.registerAgent({ discord_bot_id: 'bot-charlie' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(bob.agent_id);

    const bot = createMockBot();
    const handler = new AdminCommandHandler(engine, 'http://127.0.0.1:3000', 'admin-role', 'world-admin');
    await handler.register(bot as never);

    const deleteInteraction = createAutocompleteInteraction('agent-delete', 'a');
    bot.emit(deleteInteraction);
    await flushAsyncWork();
    expect(deleteInteraction.respond).toHaveBeenCalledWith([
      { name: 'alice', value: 'alice' },
      { name: 'charlie', value: 'charlie' },
    ]);

    const loginInteraction = createAutocompleteInteraction('login-agent', '');
    bot.emit(loginInteraction);
    await flushAsyncWork();
    expect(loginInteraction.respond).toHaveBeenCalledWith([
      { name: 'alice', value: 'alice' },
      { name: 'charlie', value: 'charlie' },
    ]);

    const logoutInteraction = createAutocompleteInteraction('logout-agent', 'b');
    bot.emit(logoutInteraction);
    await flushAsyncWork();
    expect(logoutInteraction.respond).toHaveBeenCalledWith([{ name: 'bob', value: 'bob' }]);
    expect(engine.getAgentById(alice.agent_id)).not.toBeNull();
  });

  it('returns validation and runtime errors to the caller', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);

    const bot = createMockBot();
    const handler = new AdminCommandHandler(engine, 'http://127.0.0.1:3000', 'admin-role', 'world-admin');
    await handler.register(bot as never);

    const invalidInteraction = createCommandInteraction('agent-register', {
      discord_bot_id: 'bot-alice',
    });
    bot.emit(invalidInteraction);
    await flushAsyncWork();
    expect(invalidInteraction.editReply).toHaveBeenCalledWith(
      'Agent already exists: bot-alice',
    );

    const worldErrorInteraction = createCommandInteraction('login-agent', { agent_name: 'alice' });
    bot.emit(worldErrorInteraction);
    await flushAsyncWork();
    expect(worldErrorInteraction.editReply).toHaveBeenCalledWith(`Agent is already logged in: ${alice.agent_id}`);

    const summaryError = vi.spyOn(engine, 'listAgentSummaries').mockImplementation(() => {
      throw new Error('boom');
    });
    const unexpectedInteraction = createCommandInteraction('agent-list');
    bot.emit(unexpectedInteraction);
    await flushAsyncWork();
    expect(unexpectedInteraction.editReply).toHaveBeenCalledWith('エラー: boom');
    summaryError.mockRestore();
  });

  it('returns early when deferReply fails', async () => {
    const { engine } = createTestWorld();
    const bot = createMockBot();
    const handler = new AdminCommandHandler(engine, 'http://127.0.0.1:3000', 'admin-role', 'world-admin');
    await handler.register(bot as never);

    const interaction = createCommandInteraction('agent-list', {}, {
      deferReply: vi.fn(async () => {
        throw new Error('defer failed');
      }),
    });
    bot.emit(interaction);
    await flushAsyncWork();

    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('ignores unknown command names without responding', async () => {
    const { engine } = createTestWorld();
    const bot = createMockBot();
    const handler = new AdminCommandHandler(engine, 'http://127.0.0.1:3000', 'admin-role', 'world-admin');
    await handler.register(bot as never);

    const interaction = createCommandInteraction('unknown-command');
    bot.emit(interaction);
    await flushAsyncWork();

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('rejects commands when member is null', async () => {
    const { engine } = createTestWorld();
    const bot = createMockBot();
    const handler = new AdminCommandHandler(engine, 'http://127.0.0.1:3000', 'admin-role', 'world-admin');
    await handler.register(bot as never);

    const interaction = createCommandInteraction('agent-list', {}, { member: null });
    bot.emit(interaction);
    await flushAsyncWork();

    expect(interaction.editReply).toHaveBeenCalledWith('権限がありません。');
  });

  it('allows commands when roles is a plain string array', async () => {
    const { engine } = createTestWorld();
    const bot = createMockBot();
    const handler = new AdminCommandHandler(engine, 'http://127.0.0.1:3000', 'admin-role', 'world-admin');
    await handler.register(bot as never);

    const interaction = createCommandInteraction('agent-list', {}, {
      member: { roles: ['admin-role', 'other-role'] },
    });
    bot.emit(interaction);
    await flushAsyncWork();

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('登録済みエージェントはありません。'));
  });

  it('rejects commands when roles is a plain string array without admin role', async () => {
    const { engine } = createTestWorld();
    const bot = createMockBot();
    const handler = new AdminCommandHandler(engine, 'http://127.0.0.1:3000', 'admin-role', 'world-admin');
    await handler.register(bot as never);

    const interaction = createCommandInteraction('agent-list', {}, {
      member: { roles: ['human-role'] },
    });
    bot.emit(interaction);
    await flushAsyncWork();

    expect(interaction.editReply).toHaveBeenCalledWith('権限がありません。');
  });

  it('allows commands for Discord Administrator even without the admin role', async () => {
    const { engine } = createTestWorld();
    const bot = createMockBot();
    const handler = new AdminCommandHandler(engine, 'http://127.0.0.1:3000', 'admin-role', 'world-admin');
    await handler.register(bot as never);

    const interaction = createCommandInteraction('agent-list', {}, {
      member: createMember(['other-role'], { administrator: true }),
    });
    bot.emit(interaction);
    await flushAsyncWork();

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('登録済みエージェントはありません。'));
  });
});
