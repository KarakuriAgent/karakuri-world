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

    const worldBotId = this.requireWorldBotUserId();
    const channels = await this.guild.channels.fetch();
    const availableChannels = [...channels.values()].filter((channel): channel is NonNullable<typeof channel> => channel !== null);

    // 1. admin ロール: fetch してから検索、無ければ作成
    const roles = await this.guild.roles.fetch();
    let adminRole = [...roles.values()].find((role) => role.name === 'admin' || role.name === '@admin');
    if (!adminRole) {
      console.log('Creating missing admin role...');
      adminRole = await this.guild.roles.create({ name: 'admin' });
    }

    const restrictedOverwrites: OverwriteResolvable[] = [
      {
        id: this.guild.roles.everyone.id,
        type: OverwriteType.Role,
        deny: PermissionFlagsBits.ViewChannel,
      },
      {
        id: worldBotId,
        type: OverwriteType.Member,
        allow: combinePermissions(
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ),
      },
      {
        id: adminRole.id,
        type: OverwriteType.Role,
        allow: combinePermissions(
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ),
      },
    ];

    // 2. agents カテゴリ
    let agentsCategory = availableChannels.find(
      (channel) => channel.type === ChannelType.GuildCategory && channel.name === 'agents',
    );
    if (!agentsCategory) {
      console.log('Creating missing agents category...');
      agentsCategory = await this.guild.channels.create({
        name: 'agents',
        type: ChannelType.GuildCategory,
        permissionOverwrites: restrictedOverwrites,
      });
    }

    // 3. admin カテゴリ
    let adminCategory = availableChannels.find(
      (channel) => channel.type === ChannelType.GuildCategory && channel.name === 'admin',
    );
    if (!adminCategory) {
      console.log('Creating missing admin category...');
      adminCategory = await this.guild.channels.create({
        name: 'admin',
        type: ChannelType.GuildCategory,
        permissionOverwrites: restrictedOverwrites,
      });
    }

    // 4. #announcements
    let announcements = availableChannels.find(
      (channel) => channel.type === ChannelType.GuildText && channel.name === 'announcements',
    );
    if (!announcements) {
      console.log('Creating missing #announcements channel...');
      announcements = await this.guild.channels.create({
        name: 'announcements',
        type: ChannelType.GuildText,
      });
    }

    // 5. #world-log
    let worldLog = availableChannels.find(
      (channel) => channel.type === ChannelType.GuildText && channel.name === 'world-log',
    );
    if (!worldLog) {
      console.log('Creating missing #world-log channel...');
      worldLog = await this.guild.channels.create({
        name: 'world-log',
        type: ChannelType.GuildText,
      });
    }

    // 6. #system-control (admin カテゴリ配下)
    let systemControl = availableChannels.find(
      (channel) =>
        channel.type === ChannelType.GuildText &&
        channel.name === 'system-control' &&
        channel.parentId === adminCategory.id,
    );
    if (!systemControl) {
      console.log('Creating missing #system-control channel...');
      systemControl = await this.guild.channels.create({
        name: 'system-control',
        type: ChannelType.GuildText,
        parent: adminCategory.id,
      });
    }

    this.staticChannels = {
      announcements_id: announcements.id,
      world_log_id: worldLog.id,
      agents_category_id: agentsCategory.id,
      admin_category_id: adminCategory.id,
      system_control_id: systemControl.id,
      admin_role_id: adminRole.id,
    };

    return this.staticChannels;
  }

  async createAgentChannel(agentName: string, discordBotId: string): Promise<string> {
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

    permissionOverwrites.push({
      id: discordBotId,
      type: OverwriteType.Member,
      allow: worldBotPermissions,
    });

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

}
