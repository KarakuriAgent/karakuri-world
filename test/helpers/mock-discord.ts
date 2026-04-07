import type { DiscordRuntimeAdapter } from '../../src/engine/world-engine.js';

export class MockDiscordBot implements DiscordRuntimeAdapter {
  readonly createdChannels: Array<{ agentName: string; agentId: string; channelId: string }> = [];
  readonly deletedChannels: string[] = [];

  async createAgentChannel(agentName: string, agentId: string): Promise<string> {
    const channelId = `channel-${agentName}`;
    this.createdChannels.push({ agentName, agentId, channelId });
    return channelId;
  }

  async deleteAgentChannel(channelId: string): Promise<void> {
    this.deletedChannels.push(channelId);
  }

  async channelExists(_channelId: string): Promise<boolean> {
    return true;
  }

  async fetchBotInfo(discordBotId: string): Promise<{ username: string; avatarURL: string }> {
    return {
      username: discordBotId.replace(/^(bot-|discord-)/, ''),
      avatarURL: `https://example.com/avatar/${discordBotId}.png`,
    };
  }
}
