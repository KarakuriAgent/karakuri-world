import { ChannelType, OverwriteType, PermissionFlagsBits, type Guild } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { ChannelManager } from '../../../src/discord/channel-manager.js';

function createMockGuild(options?: {
  omitChannels?: string[];
  omitAdminRole?: boolean;
}): {
  guild: Guild;
  createdChannelOptions: Array<Record<string, unknown>>;
  createdRoleOptions: Array<Record<string, unknown>>;
  channels: Map<string, Record<string, unknown>>;
} {
  const omitChannels = new Set(options?.omitChannels ?? []);

  const channels = new Map<string, Record<string, unknown>>();
  if (!omitChannels.has('announcements')) {
    channels.set('announcements', { id: 'announcements', name: 'announcements', type: ChannelType.GuildText, parentId: null });
  }
  if (!omitChannels.has('world-log')) {
    channels.set('world-log', { id: 'world-log', name: 'world-log', type: ChannelType.GuildText, parentId: null });
  }
  if (!omitChannels.has('agents')) {
    channels.set('agents', { id: 'agents', name: 'agents', type: ChannelType.GuildCategory, parentId: null });
  }
  if (!omitChannels.has('admin')) {
    channels.set('admin', { id: 'admin', name: 'admin', type: ChannelType.GuildCategory, parentId: null });
  }
  if (!omitChannels.has('system-control')) {
    channels.set('system-control', {
      id: 'system-control',
      name: 'system-control',
      type: ChannelType.GuildText,
      parentId: 'admin',
    });
  }

  const rolesMap = new Map<string, Record<string, unknown>>();
  if (!options?.omitAdminRole) {
    rolesMap.set('admin-role', { id: 'admin-role', name: 'admin' });
  }

  const createdChannelOptions: Array<Record<string, unknown>> = [];
  const createdRoleOptions: Array<Record<string, unknown>> = [];
  let channelCreateCounter = 0;

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
        const role = { id: 'created-admin-role', name: opts.name };
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
    const fullAccess =
      PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory;
    expect(permissionOverwrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'everyone',
          type: OverwriteType.Role,
          deny: PermissionFlagsBits.ViewChannel,
        }),
        expect.objectContaining({
          id: 'world-bot',
          type: OverwriteType.Member,
          allow: fullAccess,
        }),
        expect.objectContaining({
          id: 'admin-role',
          type: OverwriteType.Role,
          allow: fullAccess,
        }),
        expect.objectContaining({
          id: 'agent-bot',
          type: OverwriteType.Member,
          allow: fullAccess,
        }),
      ]),
    );
  });

  it('does not create anything when all resources exist', async () => {
    const { guild, createdChannelOptions, createdRoleOptions } = createMockGuild();
    const manager = new ChannelManager(guild);

    const result = await manager.ensureStaticChannels();

    expect(createdChannelOptions).toHaveLength(0);
    expect(createdRoleOptions).toHaveLength(0);
    expect(result).toEqual({
      announcements_id: 'announcements',
      world_log_id: 'world-log',
      agents_category_id: 'agents',
      admin_category_id: 'admin',
      system_control_id: 'system-control',
      admin_role_id: 'admin-role',
    });
  });

  it('auto-creates all missing resources', async () => {
    const { guild, createdChannelOptions, createdRoleOptions } = createMockGuild({
      omitChannels: ['announcements', 'world-log', 'agents', 'admin', 'system-control'],
      omitAdminRole: true,
    });
    const manager = new ChannelManager(guild);

    const result = await manager.ensureStaticChannels();

    expect(createdRoleOptions).toHaveLength(1);
    expect(createdRoleOptions[0]).toMatchObject({ name: 'admin' });

    // 4 channels + 1 system-control = 4 channel creates (agents cat, admin cat, announcements, world-log, system-control)
    expect(createdChannelOptions).toHaveLength(5);
    expect(createdChannelOptions.map((o) => o.name)).toEqual([
      'agents',
      'admin',
      'announcements',
      'world-log',
      'system-control',
    ]);

    expect(result.admin_role_id).toBe('created-admin-role');
    expect(result.agents_category_id).toBe('created-channel-1');
    expect(result.admin_category_id).toBe('created-channel-2');
    expect(result.announcements_id).toBe('created-channel-3');
    expect(result.world_log_id).toBe('created-channel-4');
    expect(result.system_control_id).toBe('created-channel-5');
  });

  it('creates #system-control under newly created admin category', async () => {
    const { guild, createdChannelOptions } = createMockGuild({
      omitChannels: ['admin', 'system-control'],
    });
    const manager = new ChannelManager(guild);

    await manager.ensureStaticChannels();

    const systemControlCreate = createdChannelOptions.find((o) => o.name === 'system-control');
    expect(systemControlCreate).toBeDefined();
    // system-control should reference the newly created admin category's id (created-channel-1)
    expect(systemControlCreate!.parent).toBe('created-channel-1');
  });
});
