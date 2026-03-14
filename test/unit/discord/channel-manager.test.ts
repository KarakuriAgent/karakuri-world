import { ChannelType, OverwriteType, PermissionFlagsBits, type Guild } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { ChannelManager } from '../../../src/discord/channel-manager.js';

function combinePermissions(...permissions: bigint[]): bigint {
  return permissions.reduce((combined, permission) => combined | permission, 0n);
}

const adminChannelAccess = combinePermissions(
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.AddReactions,
);

const humanReadAccess = combinePermissions(
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
);

const humanWriteRestrictions = combinePermissions(
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.AddReactions,
);

const agentChannelAccess = combinePermissions(
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
);

function createMockGuild(options?: {
  omitChannels?: string[];
  omitAdminRole?: boolean;
  omitHumanRole?: boolean;
  omitAgentRole?: boolean;
}): {
  guild: Guild;
  createdChannelOptions: Array<Record<string, unknown>>;
  createdRoleOptions: Array<Record<string, unknown>>;
  channels: Map<string, Record<string, unknown>>;
} {
  const omitChannels = new Set(options?.omitChannels ?? []);

  const channels = new Map<string, Record<string, unknown>>();
  if (!omitChannels.has('world-log')) {
    channels.set('world-log', { id: 'world-log', name: 'world-log', type: ChannelType.GuildText, parentId: null });
  }
  if (!omitChannels.has('agents')) {
    channels.set('agents', { id: 'agents', name: 'agents', type: ChannelType.GuildCategory, parentId: null });
  }

  const rolesMap = new Map<string, Record<string, unknown>>();
  if (!options?.omitAdminRole) {
    rolesMap.set('admin-role', { id: 'admin-role', name: 'admin' });
  }
  if (!options?.omitHumanRole) {
    rolesMap.set('human-role', { id: 'human-role', name: 'human' });
  }
  if (!options?.omitAgentRole) {
    rolesMap.set('agent-role', { id: 'agent-role', name: 'agent' });
  }

  const createdChannelOptions: Array<Record<string, unknown>> = [];
  const createdRoleOptions: Array<Record<string, unknown>> = [];
  let channelCreateCounter = 0;
  let roleCreateCounter = 0;

  const guild = {
    client: {
      user: {
        id: 'world-bot',
      },
    },
    roles: {
      everyone: {
        id: 'everyone',
      },
      cache: rolesMap,
      fetch: vi.fn(async () => rolesMap),
      create: vi.fn(async (opts: Record<string, unknown>) => {
        createdRoleOptions.push(opts);
        roleCreateCounter++;
        const role = { id: `created-role-${roleCreateCounter}`, name: opts.name };
        rolesMap.set(role.id, role);
        return role;
      }),
    },
    channels: {
      cache: channels,
      fetch: vi.fn(async (id?: string) => {
        if (id) {
          return channels.get(id) ?? null;
        }
        return channels;
      }),
      create: vi.fn(async (opts: Record<string, unknown>) => {
        createdChannelOptions.push(opts);
        channelCreateCounter++;
        const channel = {
          id: `created-channel-${channelCreateCounter}`,
          name: opts.name,
          type: opts.type,
          parentId: opts.parent ?? null,
          delete: vi.fn(async () => undefined),
          send: vi.fn(async () => undefined),
        };
        channels.set(channel.id, channel);
        return channel;
      }),
    },
  } as unknown as Guild;

  return { guild, createdChannelOptions, createdRoleOptions, channels };
}

describe('ChannelManager', () => {
  it('creates agent channels with expected permission overwrites', async () => {
    const { guild, createdChannelOptions } = createMockGuild();
    const manager = new ChannelManager(guild);

    const channelId = await manager.createAgentChannel('Alice Example', 'agent-bot');

    expect(channelId).toBe('created-channel-1');
    expect(createdChannelOptions).toHaveLength(1);
    expect(createdChannelOptions[0]).toMatchObject({
      name: 'agent-alice-example',
      type: ChannelType.GuildText,
      parent: 'agents',
    });

    const permissionOverwrites = createdChannelOptions[0].permissionOverwrites as Array<Record<string, unknown>>;
    expect(permissionOverwrites).toEqual([
      {
        id: 'everyone',
        type: OverwriteType.Role,
        deny: PermissionFlagsBits.ViewChannel,
      },
      {
        id: 'admin-role',
        type: OverwriteType.Role,
        allow: adminChannelAccess,
      },
      {
        id: 'human-role',
        type: OverwriteType.Role,
        allow: humanReadAccess,
        deny: humanWriteRestrictions,
      },
      {
        id: 'agent-bot',
        type: OverwriteType.Member,
        allow: agentChannelAccess,
      },
    ]);
    expect(permissionOverwrites).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'world-bot' })]));
  });

  it('does not create anything when all resources exist', async () => {
    const { guild, createdChannelOptions, createdRoleOptions } = createMockGuild();
    const manager = new ChannelManager(guild);

    const result = await manager.ensureStaticChannels();

    expect(createdChannelOptions).toHaveLength(0);
    expect(createdRoleOptions).toHaveLength(0);
    expect(result).toEqual({
      world_log_id: 'world-log',
      agents_category_id: 'agents',
      admin_role_id: 'admin-role',
      human_role_id: 'human-role',
      agent_role_id: 'agent-role',
    });
  });

  it('auto-creates all missing resources', async () => {
    const { guild, createdChannelOptions, createdRoleOptions } = createMockGuild({
      omitChannels: ['world-log', 'agents'],
      omitAdminRole: true,
      omitHumanRole: true,
      omitAgentRole: true,
    });
    const manager = new ChannelManager(guild);

    const result = await manager.ensureStaticChannels();

    expect(createdRoleOptions).toHaveLength(3);
    expect(createdRoleOptions.map((options) => options.name)).toEqual(['admin', 'human', 'agent']);

    expect(createdChannelOptions).toHaveLength(2);
    expect(createdChannelOptions.map((options) => options.name)).toEqual(['agents', 'world-log']);

    expect(result).toEqual({
      world_log_id: 'created-channel-2',
      agents_category_id: 'created-channel-1',
      admin_role_id: 'created-role-1',
      human_role_id: 'created-role-2',
      agent_role_id: 'created-role-3',
    });
  });

  it('creates agents category with restricted permission overwrites', async () => {
    const { guild, createdChannelOptions } = createMockGuild({
      omitChannels: ['agents'],
    });
    const manager = new ChannelManager(guild);

    await manager.ensureStaticChannels();

    const agentsCategoryCreate = createdChannelOptions.find((options) => options.name === 'agents');
    expect(agentsCategoryCreate).toBeDefined();
    expect(agentsCategoryCreate).toMatchObject({
      name: 'agents',
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        {
          id: 'everyone',
          type: OverwriteType.Role,
          deny: PermissionFlagsBits.ViewChannel,
        },
        {
          id: 'admin-role',
          type: OverwriteType.Role,
          allow: adminChannelAccess,
        },
        {
          id: 'human-role',
          type: OverwriteType.Role,
          allow: humanReadAccess,
          deny: humanWriteRestrictions,
        },
      ],
    });
  });

  it('creates #world-log with restricted permission overwrites', async () => {
    const { guild, createdChannelOptions } = createMockGuild({
      omitChannels: ['world-log'],
    });
    const manager = new ChannelManager(guild);

    await manager.ensureStaticChannels();

    const worldLogCreate = createdChannelOptions.find((options) => options.name === 'world-log');
    expect(worldLogCreate).toBeDefined();
    expect(worldLogCreate).toMatchObject({
      name: 'world-log',
      type: ChannelType.GuildText,
      permissionOverwrites: [
        {
          id: 'everyone',
          type: OverwriteType.Role,
          deny: PermissionFlagsBits.ViewChannel,
        },
        {
          id: 'admin-role',
          type: OverwriteType.Role,
          allow: adminChannelAccess,
        },
        {
          id: 'human-role',
          type: OverwriteType.Role,
          allow: humanReadAccess,
          deny: humanWriteRestrictions,
        },
      ],
    });
  });

  it('denies send, thread, and reaction permissions to the human role', async () => {
    const { guild, createdChannelOptions } = createMockGuild({
      omitChannels: ['world-log'],
    });
    const manager = new ChannelManager(guild);

    await manager.ensureStaticChannels();

    const worldLogCreate = createdChannelOptions.find((options) => options.name === 'world-log');
    const permissionOverwrites = worldLogCreate?.permissionOverwrites as Array<Record<string, unknown>>;
    const humanOverwrite = permissionOverwrites.find((overwrite) => overwrite.id === 'human-role');

    expect(humanOverwrite).toMatchObject({
      allow: humanReadAccess,
      deny: humanWriteRestrictions,
    });
  });

  it('allows send, thread, and reaction permissions to the admin role', async () => {
    const { guild, createdChannelOptions } = createMockGuild({
      omitChannels: ['world-log'],
    });
    const manager = new ChannelManager(guild);

    await manager.ensureStaticChannels();

    const worldLogCreate = createdChannelOptions.find((options) => options.name === 'world-log');
    const permissionOverwrites = worldLogCreate?.permissionOverwrites as Array<Record<string, unknown>>;
    const adminOverwrite = permissionOverwrites.find((overwrite) => overwrite.id === 'admin-role');

    expect(adminOverwrite).toMatchObject({
      allow: adminChannelAccess,
    });
  });
});
