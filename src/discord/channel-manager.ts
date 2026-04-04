import {
  ChannelType,
  PermissionFlagsBits,
  OverwriteType,
  type Guild,
  type OverwriteResolvable,
  type Role,
  type TextChannel,
} from 'discord.js';

export interface StaticChannels {
  world_log_id: string;
  world_status_id: string;
  world_admin_id: string;
  agents_category_id: string;
  admin_role_id: string;
  human_role_id: string;
  agent_role_id: string;
}

function combinePermissions(...permissions: bigint[]): bigint {
  return permissions.reduce((combined, permission) => combined | permission, 0n);
}

const fullChannelAccess = combinePermissions(
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.AddReactions,
);

const memberChannelAccess = combinePermissions(
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
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

function findManagedRole(roles: Iterable<Role>, roleName: string): Role | undefined {
  return [...roles].find((role) => role.name === roleName || role.name === `@${roleName}`);
}

function buildRestrictedOverwrites(guild: Guild, adminRoleId: string, humanRoleId: string): OverwriteResolvable[] {
  return [
    {
      id: guild.roles.everyone.id,
      type: OverwriteType.Role,
      deny: PermissionFlagsBits.ViewChannel,
    },
    {
      id: adminRoleId,
      type: OverwriteType.Role,
      allow: fullChannelAccess,
    },
    {
      id: humanRoleId,
      type: OverwriteType.Role,
      allow: humanReadAccess,
      deny: humanWriteRestrictions,
    },
  ];
}

function buildAdminOnlyOverwrites(guild: Guild, adminRoleId: string): OverwriteResolvable[] {
  return [
    {
      id: guild.roles.everyone.id,
      type: OverwriteType.Role,
      deny: PermissionFlagsBits.ViewChannel,
    },
    {
      id: adminRoleId,
      type: OverwriteType.Role,
      allow: fullChannelAccess,
    },
  ];
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

    const roles = await this.guild.roles.fetch();
    let adminRole = findManagedRole(roles.values(), 'admin');
    if (!adminRole) {
      console.log('Creating missing admin role...');
      adminRole = await this.guild.roles.create({ name: 'admin' });
    }

    let humanRole = findManagedRole(roles.values(), 'human');
    if (!humanRole) {
      console.log('Creating missing human role...');
      humanRole = await this.guild.roles.create({ name: 'human' });
    }

    let agentRole = findManagedRole(roles.values(), 'agent');
    if (!agentRole) {
      console.log('Creating missing agent role...');
      agentRole = await this.guild.roles.create({ name: 'agent' });
    }

    const restrictedOverwrites = buildRestrictedOverwrites(this.guild, adminRole.id, humanRole.id);
    const adminOnlyOverwrites = buildAdminOnlyOverwrites(this.guild, adminRole.id);

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

    let worldLog = availableChannels.find(
      (channel) => channel.type === ChannelType.GuildText && channel.name === 'world-log',
    );
    if (!worldLog) {
      console.log('Creating missing #world-log channel...');
      worldLog = await this.guild.channels.create({
        name: 'world-log',
        type: ChannelType.GuildText,
        permissionOverwrites: restrictedOverwrites,
      });
    }

    let worldAdmin = availableChannels.find(
      (channel) => channel.type === ChannelType.GuildText && channel.name === 'world-admin',
    );
    if (!worldAdmin) {
      console.log('Creating missing #world-admin channel...');
      worldAdmin = await this.guild.channels.create({
        name: 'world-admin',
        type: ChannelType.GuildText,
        permissionOverwrites: adminOnlyOverwrites,
      });
    }

    let worldStatus = availableChannels.find(
      (channel) => channel.type === ChannelType.GuildText && channel.name === 'world-status',
    );
    if (!worldStatus) {
      console.log('Creating missing #world-status channel...');
      worldStatus = await this.guild.channels.create({
        name: 'world-status',
        type: ChannelType.GuildText,
        permissionOverwrites: restrictedOverwrites,
      });
    }

    this.staticChannels = {
      world_log_id: worldLog.id,
      world_status_id: worldStatus.id,
      world_admin_id: worldAdmin.id,
      agents_category_id: agentsCategory.id,
      admin_role_id: adminRole.id,
      human_role_id: humanRole.id,
      agent_role_id: agentRole.id,
    };

    return this.staticChannels;
  }

  getAdminRoleId(): string {
    if (!this.staticChannels) {
      throw new Error('Discord static channels are not initialized.');
    }

    return this.staticChannels.admin_role_id;
  }

  getWorldAdminChannelId(): string {
    if (!this.staticChannels) {
      throw new Error('Discord static channels are not initialized.');
    }

    return this.staticChannels.world_admin_id;
  }

  async createAgentChannel(agentName: string, discordBotId: string): Promise<string> {
    const staticChannels = await this.ensureStaticChannels();
    const permissionOverwrites: OverwriteResolvable[] = [
      ...buildRestrictedOverwrites(this.guild, staticChannels.admin_role_id, staticChannels.human_role_id),
    ];

    permissionOverwrites.push({
      id: discordBotId,
      type: OverwriteType.Member,
      allow: memberChannelAccess,
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

  async getWorldStatusChannel(): Promise<TextChannel> {
    const staticChannels = await this.ensureStaticChannels();
    const channel = await this.getTextChannel(staticChannels.world_status_id);
    if (!channel) {
      throw new Error('Discord guild is missing #world-status.');
    }

    return channel;
  }
}
