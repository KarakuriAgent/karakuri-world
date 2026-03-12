import { ChannelType, OverwriteType, PermissionFlagsBits, type Guild } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { ChannelManager } from '../../../src/discord/channel-manager.js';

function createMockGuild(): {
  guild: Guild;
  createdOptions: Array<Record<string, unknown>>;
  channels: Map<string, Record<string, unknown>>;
} {
  const channels = new Map<string, Record<string, unknown>>([
    ['announcements', { id: 'announcements', name: 'announcements', type: ChannelType.GuildText, parentId: null }],
    ['world-log', { id: 'world-log', name: 'world-log', type: ChannelType.GuildText, parentId: null }],
    ['agents', { id: 'agents', name: 'agents', type: ChannelType.GuildCategory, parentId: null }],
    ['admin', { id: 'admin', name: 'admin', type: ChannelType.GuildCategory, parentId: null }],
    [
      'system-control',
      {
        id: 'system-control',
        name: 'system-control',
        type: ChannelType.GuildText,
        parentId: 'admin',
      },
    ],
  ]);

  const createdOptions: Array<Record<string, unknown>> = [];
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
      cache: new Map([
        [
          'admin-role',
          {
            id: 'admin-role',
            name: 'admin',
          },
        ],
      ]),
    },
    channels: {
      cache: channels,
      fetch: vi.fn(async (id?: string) => {
        if (id) {
          return channels.get(id) ?? null;
        }

        return channels;
      }),
      create: vi.fn(async (options: Record<string, unknown>) => {
        createdOptions.push(options);
        const channel = {
          id: 'agent-channel',
          name: options.name,
          type: options.type,
          parentId: options.parent,
          delete: vi.fn(async () => undefined),
          send: vi.fn(async () => undefined),
        };
        channels.set(channel.id, channel);
        return channel;
      }),
    },
  } as unknown as Guild;

  return { guild, createdOptions, channels };
}

describe('ChannelManager', () => {
  it('creates agent channels with expected permission overwrites', async () => {
    const { guild, createdOptions } = createMockGuild();
    const manager = new ChannelManager(guild);

    const channelId = await manager.createAgentChannel('Alice Example', 'agent-bot');

    expect(channelId).toBe('agent-channel');
    expect(createdOptions).toHaveLength(1);
    expect(createdOptions[0]).toMatchObject({
      name: 'agent-alice-example',
      type: ChannelType.GuildText,
      parent: 'agents',
    });

    const permissionOverwrites = createdOptions[0].permissionOverwrites as Array<Record<string, unknown>>;
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

  it('fails fast when required static channels are missing', async () => {
    const { guild, channels } = createMockGuild();
    channels.delete('world-log');
    const manager = new ChannelManager(guild);

    await expect(manager.ensureStaticChannels()).rejects.toThrow('#world-log');
  });
});
