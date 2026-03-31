import { once } from 'node:events';

import { Client, GatewayIntentBits, type Guild, type GuildMember } from 'discord.js';

import type { DiscordRuntimeAdapter } from '../engine/world-engine.js';
import { ChannelManager, type StaticChannels } from './channel-manager.js';

export interface DiscordBotOptions {
  token: string;
  guildId: string;
}

export interface DiscordNotificationAdapter extends DiscordRuntimeAdapter {
  sendAgentMessage(channelId: string, content: string): Promise<void>;
  sendWorldLog(content: string): Promise<void>;
  createWorldLogThread(content: string, threadName: string): Promise<string>;
  sendToThread(threadId: string, content: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  close(): Promise<void>;
}

export class WorldLogThreadCreationError extends Error {
  constructor(
    readonly startMessagePosted: boolean,
    cause?: unknown,
  ) {
    super('Failed to create world log thread.', { cause });
    this.name = 'WorldLogThreadCreationError';
  }
}

function requireWorldBotUserId(client: Client): string {
  const userId = client.user?.id;
  if (!userId) {
    throw new Error('Discord client is not ready.');
  }

  return userId;
}

async function ensureMemberRole(
  member: GuildMember,
  roleId: string,
  shouldHaveRole: boolean,
  failFast = false,
): Promise<void> {
  const hasRole = member.roles.cache.has(roleId);
  if (hasRole === shouldHaveRole) {
    return;
  }

  const action = shouldHaveRole ? 'add' : 'remove';

  try {
    if (shouldHaveRole) {
      await member.roles.add(roleId);
    } else {
      await member.roles.remove(roleId);
    }
  } catch (error) {
    if (failFast) {
      throw new Error(`Failed to ${action} Discord role ${roleId} for member ${member.id}.`, { cause: error });
    }

    console.warn(`Failed to ${action} Discord role ${roleId} for member ${member.id}.`, error);
  }
}

async function syncMemberRole(member: GuildMember, staticChannels: StaticChannels, worldBotUserId: string): Promise<void> {
  if (member.id === worldBotUserId) {
    await ensureMemberRole(member, staticChannels.admin_role_id, true, true);
    await ensureMemberRole(member, staticChannels.human_role_id, false);
    await ensureMemberRole(member, staticChannels.agent_role_id, false);
    return;
  }

  if (member.user.bot) {
    await ensureMemberRole(member, staticChannels.agent_role_id, true);
    await ensureMemberRole(member, staticChannels.human_role_id, false);
    await ensureMemberRole(member, staticChannels.admin_role_id, false);
    return;
  }

  await ensureMemberRole(member, staticChannels.human_role_id, true);
  await ensureMemberRole(member, staticChannels.agent_role_id, false);
}

export class DiscordBot implements DiscordNotificationAdapter {
  private constructor(
    private readonly client: Client,
    readonly guild: Guild,
    readonly channelManager: ChannelManager,
  ) {}

  static async create(options: DiscordBotOptions): Promise<DiscordBot> {
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    });

    await client.login(options.token);
    if (!client.isReady()) {
      await once(client, 'clientReady');
    }

    const guild = await client.guilds.fetch(options.guildId);
    const channelManager = new ChannelManager(guild);
    const staticChannels = await channelManager.ensureStaticChannels();
    const worldBotUserId = requireWorldBotUserId(client);

    // Register the listener before the initial fetch to avoid missing joins during startup.
    client.on('guildMemberAdd', (member) => {
      if (member.guild.id !== guild.id) {
        return;
      }

      void syncMemberRole(member, staticChannels, worldBotUserId).catch((error) => {
        console.error('Failed to sync Discord member role on join.', error);
      });
    });

    const members = await guild.members.fetch();
    for (const member of members.values()) {
      await syncMemberRole(member, staticChannels, worldBotUserId);
    }

    return new DiscordBot(client, guild, channelManager);
  }

  async createAgentChannel(agentName: string, discordBotId: string): Promise<string> {
    return this.channelManager.createAgentChannel(agentName, discordBotId);
  }

  async deleteAgentChannel(channelId: string): Promise<void> {
    await this.channelManager.deleteAgentChannel(channelId);
  }

  async channelExists(channelId: string): Promise<boolean> {
    return (await this.channelManager.getTextChannel(channelId)) !== null;
  }

  async sendAgentMessage(channelId: string, content: string): Promise<void> {
    const channel = await this.channelManager.getTextChannel(channelId);
    if (!channel) {
      throw new Error(`Discord channel not found: ${channelId}`);
    }

    await channel.send(content);
  }

  async sendWorldLog(content: string): Promise<void> {
    const channel = await this.channelManager.getWorldLogChannel();
    await channel.send(content);
  }

  async createWorldLogThread(content: string, threadName: string): Promise<string> {
    const channel = await this.channelManager.getWorldLogChannel();
    let startMessagePosted = false;

    try {
      const message = await channel.send(content);
      startMessagePosted = true;
      const thread = await message.startThread({ name: threadName.slice(0, 100) });
      return thread.id;
    } catch (error) {
      throw new WorldLogThreadCreationError(startMessagePosted, error);
    }
  }

  async sendToThread(threadId: string, content: string): Promise<void> {
    const channel = await this.guild.channels.fetch(threadId);
    if (!channel || !channel.isThread()) {
      throw new Error(`Discord thread not found: ${threadId}`);
    }

    await channel.send(content);
  }

  async archiveThread(threadId: string): Promise<void> {
    const channel = await this.guild.channels.fetch(threadId);
    if (!channel || !channel.isThread()) {
      console.warn(`Cannot archive thread ${threadId}: channel not found or not a thread.`);
      return;
    }

    await channel.setArchived(true);
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}
