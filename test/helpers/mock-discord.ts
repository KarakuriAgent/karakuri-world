import type { DiscordRuntimeAdapter } from '../../src/engine/world-engine.js';

export class MockDiscordBot implements DiscordRuntimeAdapter {
  readonly createdChannels: Array<{ agentName: string; discordBotId?: string; channelId: string }> = [];
  readonly deletedChannels: string[] = [];

  async createAgentChannel(agentName: string, discordBotId?: string): Promise<string> {
    const channelId = `channel-${agentName}`;
    this.createdChannels.push({ agentName, discordBotId, channelId });
    return channelId;
  }

  async deleteAgentChannel(channelId: string): Promise<void> {
    this.deletedChannels.push(channelId);
  }
}
