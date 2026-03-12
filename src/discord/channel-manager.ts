import {
  ChannelType,
  PermissionFlagsBits,
  OverwriteType,
  type Guild,
  type OverwriteResolvable,
  type TextChannel,
} from 'discord.js';

interface StaticChannels {
  announcements_id: string;
  world_log_id: string;
  agents_category_id: string;
  admin_category_id: string;
  system_control_id: string;
  admin_role_id: string;
}

function combinePermissions(...permissions: bigint[]): bigint {
  return permissions.reduce((combined, permission) => combined | permission, 0n);
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }

  return value;
}

export function sanitizeAgentChannelName(agentName: string): string {
  const normalized = agentName
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return `agent-${normalized || 'agent'}`;
}

export class ChannelManager {
  private staticChannels: StaticChannels | null = null;

  constructor(private readonly guild: Guild) {}

  async ensureStaticChannels(): Promise<StaticChannels> {
    if (this.staticChannels) {
      return this.staticChannels;
    }

    const channels = await this.guild.channels.fetch();
    const availableChannels = [...channels.values()].filter((channel): channel is NonNullable<typeof channel> => channel !== null);
    const adminRoleId = this.findAdminRoleId();

    const announcements = availableChannels.find(
      (channel) => channel.type === ChannelType.GuildText && channel.name === 'announcements',
    );
    const worldLog = availableChannels.find(
      (channel) => channel.type === ChannelType.GuildText && channel.name === 'world-log',
    );
    const agentsCategory = availableChannels.find(
      (channel) => channel.type === ChannelType.GuildCategory && channel.name === 'agents',
    );
    const adminCategory = availableChannels.find(
      (channel) => channel.type === ChannelType.GuildCategory && channel.name === 'admin',
    );
    const systemControl = availableChannels.find(
      (channel) =>
        channel.type === ChannelType.GuildText &&
        channel.name === 'system-control' &&
        channel.parentId === adminCategory?.id,
    );

    this.staticChannels = {
      announcements_id: requireValue(announcements?.id, 'Discord guild is missing #announcements.'),
      world_log_id: requireValue(worldLog?.id, 'Discord guild is missing #world-log.'),
      agents_category_id: requireValue(agentsCategory?.id, 'Discord guild is missing the agents category.'),
      admin_category_id: requireValue(adminCategory?.id, 'Discord guild is missing the admin category.'),
      system_control_id: requireValue(systemControl?.id, 'Discord guild is missing #system-control under admin.'),
      admin_role_id: requireValue(adminRoleId, 'Discord guild is missing the admin role.'),
    };

    return this.staticChannels;
  }

  async createAgentChannel(agentName: string, discordBotId?: string): Promise<string> {
    const staticChannels = await this.ensureStaticChannels();
    const worldBotPermissions = combinePermissions(
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
    );
    const permissionOverwrites: OverwriteResolvable[] = [
      {
        id: this.guild.roles.everyone.id,
        type: OverwriteType.Role,
        deny: PermissionFlagsBits.ViewChannel,
      },
      {
        id: this.requireWorldBotUserId(),
        type: OverwriteType.Member,
        allow: worldBotPermissions,
      },
      {
        id: staticChannels.admin_role_id,
        type: OverwriteType.Role,
        allow: worldBotPermissions,
      },
    ];

    if (discordBotId) {
      permissionOverwrites.push({
        id: discordBotId,
        type: OverwriteType.Member,
        allow: worldBotPermissions,
      });
    }

    const channel = await this.guild.channels.create({
      name: sanitizeAgentChannelName(agentName),
      type: ChannelType.GuildText,
      parent: staticChannels.agents_category_id,
      permissionOverwrites,
    });

    return channel.id;
  }

  async deleteAgentChannel(channelId: string): Promise<void> {
    const channel = await this.guild.channels.fetch(channelId);
    if (channel) {
      await channel.delete();
    }
  }

  async getTextChannel(channelId: string): Promise<TextChannel | null> {
    const channel = await this.guild.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      return null;
    }

    return channel;
  }

  async getWorldLogChannel(): Promise<TextChannel> {
    const staticChannels = await this.ensureStaticChannels();
    const channel = await this.getTextChannel(staticChannels.world_log_id);
    if (!channel) {
      throw new Error('Discord guild is missing #world-log.');
    }

    return channel;
  }

  private requireWorldBotUserId(): string {
    const userId = this.guild.client.user?.id;
    if (!userId) {
      throw new Error('Discord client is not ready.');
    }

    return userId;
  }

  private findAdminRoleId(): string | undefined {
    return [...this.guild.roles.cache.values()].find((role) => role.name === 'admin' || role.name === '@admin')?.id;
  }
}
