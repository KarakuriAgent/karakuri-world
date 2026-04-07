import type { GuildMember } from 'discord.js';
import { GatewayIntentBits, RESTJSONErrorCodes } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const staticChannels = {
    world_log_id: 'world-log',
    world_status_id: 'world-status',
    world_admin_id: 'world-admin',
    agents_category_id: 'agents',
    admin_role_id: 'admin-role',
    human_role_id: 'human-role',
    agent_role_id: 'agent-role',
  };

  let guildMemberAddHandler: ((member: GuildMember) => void) | undefined;

  const ensureStaticChannels = vi.fn(async () => staticChannels);
  const getAdminRoleId = vi.fn(() => staticChannels.admin_role_id);
  const getWorldAdminChannelId = vi.fn(() => staticChannels.world_admin_id);
  const membersFetch = vi.fn(async () => new Map());
  const usersFetch = vi.fn();
  const commandsSet = vi.fn(async () => []);
  const login = vi.fn(async () => undefined);
  const isReady = vi.fn(() => true);
  const guildsFetch = vi.fn();
  const on = vi.fn();
  const off = vi.fn();
  const destroy = vi.fn();

  const guild = {
    id: 'guild-1',
    ownerId: 'guild-owner',
    members: {
      fetch: membersFetch,
    },
    commands: {
      set: commandsSet,
    },
  };

  const client = {
    login,
    isReady,
    guilds: {
      fetch: guildsFetch,
    },
    on,
    off,
    destroy,
    users: {
      fetch: usersFetch,
    },
    user: {
      id: 'world-bot',
    },
  };

  const Client = vi.fn(function MockClient() {
    return client;
  });

  class MockChannelManager {
    ensureStaticChannels = ensureStaticChannels;
    getAdminRoleId = getAdminRoleId;
    getWorldAdminChannelId = getWorldAdminChannelId;
    createAgentChannel = vi.fn();
    deleteAgentChannel = vi.fn();
    getTextChannel = vi.fn();
    getWorldLogChannel = vi.fn();
    getWorldStatusChannel = vi.fn();
  }

  function reset(): void {
    guildMemberAddHandler = undefined;
    ensureStaticChannels.mockReset().mockResolvedValue(staticChannels);
    getAdminRoleId.mockReset().mockReturnValue(staticChannels.admin_role_id);
    getWorldAdminChannelId.mockReset().mockReturnValue(staticChannels.world_admin_id);
    membersFetch.mockReset().mockResolvedValue(new Map());
    usersFetch.mockReset();
    commandsSet.mockReset().mockResolvedValue([]);
    login.mockReset().mockResolvedValue(undefined);
    isReady.mockReset().mockReturnValue(true);
    guildsFetch.mockReset().mockResolvedValue(guild);
    on.mockReset().mockImplementation((event: string, handler: (member: GuildMember) => void) => {
      if (event === 'guildMemberAdd') {
        guildMemberAddHandler = handler;
      }

      return client;
    });
    off.mockReset().mockImplementation(() => client);
    destroy.mockReset();
    Client.mockClear();
    client.user.id = 'world-bot';
  }

  function setMembers(members: GuildMember[]): void {
    membersFetch.mockResolvedValue(new Map(members.map((member) => [member.id, member])));
  }

  function emitGuildMemberAdd(member: GuildMember): void {
    if (!guildMemberAddHandler) {
      throw new Error('guildMemberAdd handler has not been registered.');
    }

    guildMemberAddHandler(member);
  }

  return {
    Client,
    MockChannelManager,
    client,
    commandsSet,
    destroy,
    emitGuildMemberAdd,
    ensureStaticChannels,
    getAdminRoleId,
    getWorldAdminChannelId,
    guild,
    guildsFetch,
    login,
    membersFetch,
    usersFetch,
    off,
    on,
    reset,
    setMembers,
    staticChannels,
  };
});

vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('discord.js')>();
  return {
    ...actual,
    Client: mocks.Client,
  };
});

vi.mock('../../../src/discord/channel-manager.js', () => ({
  ChannelManager: mocks.MockChannelManager,
}));

import { DiscordBot } from '../../../src/discord/bot.js';

function createMockMember(
  id: string,
  options?: {
    bot?: boolean;
    guildId?: string;
    guildOwnerId?: string;
    isAdmin?: boolean;
    roleIds?: string[];
    failAddRoleIds?: string[];
    failRemoveRoleIds?: string[];
  },
): GuildMember & {
  roles: {
    cache: Set<string>;
    add: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
} {
  const roleIds = new Set(options?.roleIds ?? []);
  const failAddRoleIds = new Set(options?.failAddRoleIds ?? []);
  const failRemoveRoleIds = new Set(options?.failRemoveRoleIds ?? []);

  const roles = {
    cache: roleIds,
    add: vi.fn(async (roleId: string) => {
      if (failAddRoleIds.has(roleId)) {
        throw new Error(`Failed to add role ${roleId}`);
      }

      roleIds.add(roleId);
    }),
    remove: vi.fn(async (roleId: string) => {
      if (failRemoveRoleIds.has(roleId)) {
        throw new Error(`Failed to remove role ${roleId}`);
      }

      roleIds.delete(roleId);
    }),
  };

  return {
    id,
    user: {
      bot: options?.bot ?? false,
    },
    guild: {
      id: options?.guildId ?? mocks.guild.id,
      ownerId: options?.guildOwnerId ?? mocks.guild.ownerId,
    },
    permissions: {
      has: vi.fn((permission: string) => permission === 'Administrator' && (options?.isAdmin ?? false)),
    },
    roles,
  } as unknown as GuildMember & {
    roles: {
      cache: Set<string>;
      add: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
  };
}

async function flushAsyncWork(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('DiscordBot role sync', () => {
  beforeEach(() => {
    mocks.reset();
  });

  it('requests GuildMembers intent, registers guildMemberAdd before fetching members, and syncs existing roles', async () => {
    const human = createMockMember('human-1');
    const agentBot = createMockMember('agent-bot-1', { bot: true });
    const worldBot = createMockMember('world-bot', { bot: true });
    mocks.setMembers([human, agentBot, worldBot]);

    await DiscordBot.create({
      token: 'test-token',
      guildId: 'guild-1',
    });

    expect(mocks.Client).toHaveBeenCalledWith({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
    });
    expect(mocks.on).toHaveBeenCalledWith('guildMemberAdd', expect.any(Function));
    expect(mocks.on.mock.invocationCallOrder[0]).toBeLessThan(mocks.membersFetch.mock.invocationCallOrder[0]);

    expect(human.roles.add).toHaveBeenCalledWith(mocks.staticChannels.human_role_id);
    expect(agentBot.roles.add).toHaveBeenCalledWith(mocks.staticChannels.agent_role_id);
    expect(worldBot.roles.add).toHaveBeenCalledWith(mocks.staticChannels.admin_role_id);
  });

  it('skips members that already have the correct roles', async () => {
    const human = createMockMember('human-1', {
      roleIds: [mocks.staticChannels.human_role_id],
    });
    const agentBot = createMockMember('agent-bot-1', {
      bot: true,
      roleIds: [mocks.staticChannels.agent_role_id],
    });
    const worldBot = createMockMember('world-bot', {
      bot: true,
      roleIds: [mocks.staticChannels.admin_role_id],
    });
    mocks.setMembers([human, agentBot, worldBot]);

    await DiscordBot.create({
      token: 'test-token',
      guildId: 'guild-1',
    });

    expect(human.roles.add).not.toHaveBeenCalled();
    expect(human.roles.remove).not.toHaveBeenCalled();
    expect(agentBot.roles.add).not.toHaveBeenCalled();
    expect(agentBot.roles.remove).not.toHaveBeenCalled();
    expect(worldBot.roles.add).not.toHaveBeenCalled();
    expect(worldBot.roles.remove).not.toHaveBeenCalled();
  });

  it('removes inconsistent roles during startup sync', async () => {
    const human = createMockMember('human-1', {
      roleIds: [mocks.staticChannels.agent_role_id],
    });
    const agentBot = createMockMember('agent-bot-1', {
      bot: true,
      roleIds: [mocks.staticChannels.human_role_id, mocks.staticChannels.admin_role_id],
    });
    const worldBot = createMockMember('world-bot', {
      bot: true,
      roleIds: [mocks.staticChannels.human_role_id, mocks.staticChannels.agent_role_id],
    });
    mocks.setMembers([human, agentBot, worldBot]);

    await DiscordBot.create({
      token: 'test-token',
      guildId: 'guild-1',
    });

    expect(human.roles.remove).toHaveBeenCalledWith(mocks.staticChannels.agent_role_id);
    expect(agentBot.roles.remove).toHaveBeenCalledWith(mocks.staticChannels.human_role_id);
    expect(agentBot.roles.remove).toHaveBeenCalledWith(mocks.staticChannels.admin_role_id);
    expect(worldBot.roles.remove).toHaveBeenCalledWith(mocks.staticChannels.human_role_id);
    expect(worldBot.roles.remove).toHaveBeenCalledWith(mocks.staticChannels.agent_role_id);
  });

  it('assigns the human role on guildMemberAdd for humans', async () => {
    mocks.setMembers([createMockMember('world-bot', { bot: true })]);

    await DiscordBot.create({
      token: 'test-token',
      guildId: 'guild-1',
    });

    const member = createMockMember('human-2');
    mocks.emitGuildMemberAdd(member);
    await flushAsyncWork();

    expect(member.roles.add).toHaveBeenCalledWith(mocks.staticChannels.human_role_id);
  });

  it('assigns the agent role on guildMemberAdd for bots', async () => {
    mocks.setMembers([createMockMember('world-bot', { bot: true })]);

    await DiscordBot.create({
      token: 'test-token',
      guildId: 'guild-1',
    });

    const member = createMockMember('agent-bot-2', { bot: true });
    mocks.emitGuildMemberAdd(member);
    await flushAsyncWork();

    expect(member.roles.add).toHaveBeenCalledWith(mocks.staticChannels.agent_role_id);
  });

  it('removes inconsistent roles on guildMemberAdd', async () => {
    mocks.setMembers([createMockMember('world-bot', { bot: true })]);

    await DiscordBot.create({
      token: 'test-token',
      guildId: 'guild-1',
    });

    const humanWithAgent = createMockMember('human-3', {
      roleIds: [mocks.staticChannels.agent_role_id],
    });
    mocks.emitGuildMemberAdd(humanWithAgent);
    await flushAsyncWork();

    expect(humanWithAgent.roles.add).toHaveBeenCalledWith(mocks.staticChannels.human_role_id);
    expect(humanWithAgent.roles.remove).toHaveBeenCalledWith(mocks.staticChannels.agent_role_id);

    const botWithHuman = createMockMember('agent-bot-3', {
      bot: true,
      roleIds: [mocks.staticChannels.human_role_id, mocks.staticChannels.admin_role_id],
    });
    mocks.emitGuildMemberAdd(botWithHuman);
    await flushAsyncWork();

    expect(botWithHuman.roles.add).toHaveBeenCalledWith(mocks.staticChannels.agent_role_id);
    expect(botWithHuman.roles.remove).toHaveBeenCalledWith(mocks.staticChannels.human_role_id);
    expect(botWithHuman.roles.remove).toHaveBeenCalledWith(mocks.staticChannels.admin_role_id);
  });

  it('ignores guildMemberAdd events from other guilds', async () => {
    mocks.setMembers([createMockMember('world-bot', { bot: true })]);

    await DiscordBot.create({
      token: 'test-token',
      guildId: 'guild-1',
    });

    const member = createMockMember('human-2', { guildId: 'guild-2' });
    mocks.emitGuildMemberAdd(member);
    await flushAsyncWork();

    expect(member.roles.add).not.toHaveBeenCalled();
    expect(member.roles.remove).not.toHaveBeenCalled();
  });

  it('throws when assigning the admin role to the world bot fails at startup', async () => {
    const worldBot = createMockMember('world-bot', {
      bot: true,
      failAddRoleIds: [mocks.staticChannels.admin_role_id],
    });
    mocks.setMembers([worldBot]);

    await expect(
      DiscordBot.create({
        token: 'test-token',
        guildId: 'guild-1',
      }),
    ).rejects.toThrow(`Failed to add Discord role ${mocks.staticChannels.admin_role_id} for member world-bot.`);
  });

  it('warns and continues when syncing another member fails at startup', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const worldBot = createMockMember('world-bot', { bot: true });
    const human = createMockMember('human-1', {
      failAddRoleIds: [mocks.staticChannels.human_role_id],
    });
    mocks.setMembers([human, worldBot]);

    await expect(
      DiscordBot.create({
        token: 'test-token',
        guildId: 'guild-1',
      }),
    ).resolves.toBeInstanceOf(DiscordBot);

    expect(warn).toHaveBeenCalledWith(
      `Failed to add Discord role ${mocks.staticChannels.human_role_id} for member human-1.`,
      expect.any(Error),
    );
  });
});

describe('DiscordBot admin command helpers', () => {
  beforeEach(() => {
    mocks.reset();
  });

  it('registers and unregisters interaction handlers', async () => {
    const bot = await DiscordBot.create({
      token: 'test-token',
      guildId: 'guild-1',
    });
    const handler = vi.fn();

    const unsubscribe = bot.registerInteractionHandler(handler as never);
    unsubscribe();

    expect(mocks.on).toHaveBeenCalledWith('interactionCreate', handler);
    expect(mocks.off).toHaveBeenCalledWith('interactionCreate', handler);
  });

  it('registers guild commands through the guild command manager', async () => {
    const bot = await DiscordBot.create({
      token: 'test-token',
      guildId: 'guild-1',
    });
    const commands = [{ name: 'agent-list', description: 'list agents', type: 1 }];

    await bot.registerGuildCommands(commands as never);

    expect(mocks.commandsSet).toHaveBeenCalledWith(commands);
  });

  it('exposes admin role and world-admin channel ids from the channel manager', async () => {
    const bot = await DiscordBot.create({
      token: 'test-token',
      guildId: 'guild-1',
    });

    expect(bot.getAdminRoleId()).toBe(mocks.staticChannels.admin_role_id);
    expect(bot.getWorldAdminChannelId()).toBe(mocks.staticChannels.world_admin_id);
    expect(mocks.getAdminRoleId).toHaveBeenCalledTimes(1);
    expect(mocks.getWorldAdminChannelId).toHaveBeenCalledTimes(1);
  });

  it('returns a validation error when the Discord bot id does not exist', async () => {
    const bot = await DiscordBot.create({
      token: 'test-token',
      guildId: 'guild-1',
    });
    const discordBotId = '123456789012345678';

    mocks.membersFetch.mockRejectedValueOnce({ code: RESTJSONErrorCodes.UnknownMember });
    mocks.usersFetch.mockRejectedValueOnce({ code: RESTJSONErrorCodes.UnknownUser });

    await expect(bot.fetchBotInfo(discordBotId)).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
      message: `Discord bot not found: ${discordBotId}`,
    });
  });

  it('returns a validation error when the Discord bot id is malformed', async () => {
    const bot = await DiscordBot.create({
      token: 'test-token',
      guildId: 'guild-1',
    });

    await expect(bot.fetchBotInfo('not-a-snowflake')).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
      message: 'Discord bot ID is malformed: not-a-snowflake',
    });
    expect(mocks.membersFetch).not.toHaveBeenCalledWith('not-a-snowflake');
    expect(mocks.usersFetch).not.toHaveBeenCalledWith('not-a-snowflake');
  });
});
