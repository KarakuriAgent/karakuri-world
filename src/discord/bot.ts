import { once } from 'node:events';

import { Client, GatewayIntentBits, type Guild } from 'discord.js';

import type { DiscordRuntimeAdapter } from '../engine/world-engine.js';
import { ChannelManager } from './channel-manager.js';

export interface DiscordBotOptions {
  token: string;
  guildId: string;
}

export interface DiscordNotificationAdapter extends DiscordRuntimeAdapter {
  sendAgentMessage(channelId: string, content: string): Promise<void>;
  sendWorldLog(content: string): Promise<void>;
  close(): Promise<void>;
}

export class DiscordBot implements DiscordNotificationAdapter {
  private constructor(
    private readonly client: Client,
    readonly guild: Guild,
    readonly channelManager: ChannelManager,
  ) {}

  static async create(options: DiscordBotOptions): Promise<DiscordBot> {
    const client = new Client({
      intents: [GatewayIntentBits.Guilds],
    });

    await client.login(options.token);
    if (!client.isReady()) {
      await once(client, 'clientReady');
    }

    const guild = await client.guilds.fetch(options.guildId);
    const channelManager = new ChannelManager(guild);
    await channelManager.ensureStaticChannels();

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

  async close(): Promise<void> {
    this.client.destroy();
  }
}
