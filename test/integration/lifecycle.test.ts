import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { WorldEngine, type DiscordRuntimeAdapter } from '../../src/engine/world-engine.js';
import { loadAgents, saveAgents } from '../../src/storage/agent-storage.js';
import type { AgentRegistration } from '../../src/types/agent.js';
import { createTestConfig } from '../helpers/test-map.js';
import { createTestWorld } from '../helpers/test-world.js';

function createRegistration(overrides: Partial<AgentRegistration> = {}): AgentRegistration {
  return {
    agent_id: 'agent-1',
    agent_name: 'alice',
    api_key: 'karakuri_deadbeef',
    discord_bot_id: 'bot-alice',
    created_at: 1,
    ...overrides,
  };
}

class DeferredDiscordBot implements DiscordRuntimeAdapter {
  readonly deletedChannels: string[] = [];
  private pendingChannel: { channelId: string; resolve: (channelId: string) => void } | null = null;

  createAgentChannel(agentName: string, _discordBotId: string): Promise<string> {
    return new Promise((resolve) => {
      this.pendingChannel = {
        channelId: `channel-${agentName}`,
        resolve,
      };
    });
  }

  async deleteAgentChannel(channelId: string): Promise<void> {
    this.deletedChannels.push(channelId);
  }

  resolvePendingChannel(): void {
    if (!this.pendingChannel) {
      throw new Error('No pending channel creation');
    }

    const pendingChannel = this.pendingChannel;
    this.pendingChannel = null;
    pendingChannel.resolve(pendingChannel.channelId);
  }
}

describe('WorldEngine lifecycle', () => {
  it('registers, joins, leaves, and rejoins an agent', async () => {
    const { config, engine, discordBot } = createTestWorld();
    const registration = engine.registerAgent({
      agent_name: 'alice',
      discord_bot_id: 'discord-alice',
    });

    const joinResponse = await engine.joinAgent(registration.agent_id);
    expect(joinResponse.channel_id).toBe('channel-alice');
    expect(config.spawn.nodes).toContain(joinResponse.node_id);

    const joinedAgent = engine.state.getJoined(registration.agent_id);
    expect(joinedAgent).toMatchObject({
      agent_id: registration.agent_id,
      agent_name: 'alice',
      node_id: joinResponse.node_id,
      state: 'idle',
      discord_channel_id: 'channel-alice',
    });

    expect(engine.getSnapshot().agents).toHaveLength(1);
    expect(discordBot?.createdChannels).toHaveLength(1);

    await engine.leaveAgent(registration.agent_id);
    expect(engine.state.getJoined(registration.agent_id)).toBeNull();
    expect(discordBot?.deletedChannels).toEqual(['channel-alice']);

    const rejoined = await engine.joinAgent(registration.agent_id);
    expect(config.spawn.nodes).toContain(rejoined.node_id);
    expect(engine.state.getJoined(registration.agent_id)?.node_id).toBe(rejoined.node_id);
  });

  it('lists agents and prevents deleting joined registrations', async () => {
    const { engine } = createTestWorld();
    const alice = engine.registerAgent({ agent_name: 'alice', discord_bot_id: 'bot-alice' });
    const bob = engine.registerAgent({ agent_name: 'bob', discord_bot_id: 'bot-bob' });

    expect(engine.listAgents().map((agent) => agent.agent_name)).toEqual(['alice', 'bob']);

    await engine.joinAgent(alice.agent_id);
    await expect(engine.deleteAgent(alice.agent_id)).rejects.toMatchObject({
      status: 409,
      code: 'state_conflict',
    });
    await engine.leaveAgent(alice.agent_id);
    expect(await engine.deleteAgent(alice.agent_id)).toBe(true);
    expect(engine.getAgentById(alice.agent_id)).toBeNull();
    expect(engine.getSnapshot().agents).toHaveLength(0);
    expect(await engine.deleteAgent(bob.agent_id)).toBe(true);
  });

  it('persists registrations on register and delete', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'karakuri-world-lifecycle-'));
    const filePath = join(dataDir, 'agents.json');
    const { engine } = createTestWorld({
      engineOptions: {
        onRegistrationChanged: (agents) => saveAgents(filePath, agents),
      },
    });

    try {
      const alice = engine.registerAgent({ agent_name: 'alice', discord_bot_id: 'bot-alice' });
      const bob = engine.registerAgent({ agent_name: 'bob', discord_bot_id: 'bot-bob' });

      expect(loadAgents(filePath)).toEqual([
        alice,
        bob,
      ]);

      expect(await engine.deleteAgent(alice.agent_id)).toBe(true);
      expect(loadAgents(filePath)).toEqual([bob]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('does not mutate in-memory registrations when persistence fails', async () => {
    const failure = new Error('save failed');
    const registerWorld = createTestWorld({
      engineOptions: {
        onRegistrationChanged: () => {
          throw failure;
        },
      },
    });

    expect(() => registerWorld.engine.registerAgent({ agent_name: 'alice', discord_bot_id: 'bot-alice' })).toThrowError(failure);
    expect(registerWorld.engine.listAgents()).toEqual([]);

    const persistedAlice = createRegistration();
    const deleteWorld = createTestWorld({
      engineOptions: {
        initialRegistrations: [persistedAlice],
        onRegistrationChanged: () => {
          throw failure;
        },
      },
    });

    await expect(deleteWorld.engine.deleteAgent(persistedAlice.agent_id)).rejects.toThrowError(failure);
    expect(deleteWorld.engine.getAgentById(persistedAlice.agent_id)).toEqual(persistedAlice);
  });

  it('prevents deleting an agent while join is in progress', async () => {
    const discordBot = new DeferredDiscordBot();
    const engine = new WorldEngine(createTestConfig(), discordBot);
    const alice = engine.registerAgent({ agent_name: 'alice', discord_bot_id: 'bot-alice' });
    const joinPromise = engine.joinAgent(alice.agent_id);

    await expect(engine.deleteAgent(alice.agent_id)).rejects.toMatchObject({
      status: 409,
      code: 'state_conflict',
    });

    discordBot.resolvePendingChannel();
    const joinResponse = await joinPromise;

    expect(joinResponse.channel_id).toBe('channel-alice');
    expect(discordBot.deletedChannels).toEqual([]);
  });
});
