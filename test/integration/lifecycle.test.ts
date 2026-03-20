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
  const agentName = overrides.agent_name ?? 'alice';
  const discordBotId = overrides.discord_bot_id ?? `bot-${agentName}`;
  return {
    agent_id: 'agent-1',
    agent_name: agentName,
    agent_label: overrides.agent_label ?? agentName,
    api_key: 'karakuri_deadbeef',
    discord_bot_id: discordBotId,
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

  async channelExists(_channelId: string): Promise<boolean> {
    return true;
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
  it('registers, logs in, logs out, and logs back in an agent', async () => {
    const { config, engine, discordBot } = createTestWorld();
    const registration = engine.registerAgent({
      agent_name: 'alice',
      agent_label: 'alice',
      discord_bot_id: 'discord-alice',
    });

    const joinResponse = await engine.loginAgent(registration.agent_id);
    expect(joinResponse.channel_id).toBe('channel-alice');
    expect(config.spawn.nodes).toContain(joinResponse.node_id);

    const loggedInAgent = engine.state.getLoggedIn(registration.agent_id);
    expect(loggedInAgent).toMatchObject({
      agent_id: registration.agent_id,
      agent_name: 'alice',
      agent_label: 'alice',
      node_id: joinResponse.node_id,
      state: 'idle',
      discord_channel_id: 'channel-alice',
    });

    expect(engine.getSnapshot().agents).toHaveLength(1);
    expect(discordBot?.createdChannels).toHaveLength(1);

    await engine.logoutAgent(registration.agent_id);
    expect(engine.state.getLoggedIn(registration.agent_id)).toBeNull();
    expect(discordBot?.deletedChannels).toEqual([]);

    const updatedReg = engine.getAgentById(registration.agent_id)!;
    expect(updatedReg.discord_channel_id).toBe('channel-alice');
    expect(updatedReg.last_node_id).toBe(joinResponse.node_id);

    const rejoined = await engine.loginAgent(registration.agent_id);
    expect(rejoined.channel_id).toBe('channel-alice');
    expect(rejoined.node_id).toBe(joinResponse.node_id);
    expect(discordBot?.createdChannels).toHaveLength(1);
    expect(engine.state.getLoggedIn(registration.agent_id)?.node_id).toBe(rejoined.node_id);
  });

  it('lists agents and prevents deleting logged-in registrations', async () => {
    const { engine } = createTestWorld();
    const alice = engine.registerAgent({ agent_name: 'alice', agent_label: 'alice', discord_bot_id: 'bot-alice', });
    const bob = engine.registerAgent({ agent_name: 'bob', agent_label: 'bob', discord_bot_id: 'bot-bob', });

    expect(engine.listAgents().map((agent) => agent.agent_name)).toEqual(['alice', 'bob']);

    await engine.loginAgent(alice.agent_id);
    await expect(engine.deleteAgent(alice.agent_id)).rejects.toMatchObject({
      status: 409,
      code: 'state_conflict',
    });
    await engine.logoutAgent(alice.agent_id);
    expect(await engine.deleteAgent(alice.agent_id)).toBe(true);
    expect(engine.getAgentById(alice.agent_id)).toBeNull();
    expect(engine.getSnapshot().agents).toHaveLength(0);
    expect(await engine.deleteAgent(bob.agent_id)).toBe(true);
  });

  it('persists registrations on register, logout, and delete', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'karakuri-world-lifecycle-'));
    const filePath = join(dataDir, 'agents.json');
    const { engine } = createTestWorld({
      engineOptions: {
        onRegistrationChanged: (agents) => saveAgents(filePath, agents),
      },
    });

    try {
      const alice = engine.registerAgent({ agent_name: 'alice', agent_label: 'alice', discord_bot_id: 'bot-alice', });
      const bob = engine.registerAgent({ agent_name: 'bob', agent_label: 'bob', discord_bot_id: 'bot-bob', });

      expect(loadAgents(filePath)).toEqual([
        alice,
        bob,
      ]);

      const joinResponse = await engine.loginAgent(alice.agent_id);
      await engine.logoutAgent(alice.agent_id);

      const persisted = loadAgents(filePath);
      const persistedAlice = persisted.find((a) => a.agent_id === alice.agent_id)!;
      expect(persistedAlice.discord_channel_id).toBe('channel-alice');
      expect(persistedAlice.last_node_id).toBe(joinResponse.node_id);

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

    expect(() => registerWorld.engine.registerAgent({ agent_name: 'alice', agent_label: 'alice', discord_bot_id: 'bot-alice', })).toThrowError(failure);
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

  it('falls back to random spawn when last_node_id is invalid', async () => {
    const { config, engine } = createTestWorld({
      engineOptions: {
        initialRegistrations: [
          createRegistration({ last_node_id: '1-3' as never, discord_channel_id: 'channel-alice' }),
        ],
      },
    });

    const joinResponse = await engine.loginAgent('agent-1');
    expect(config.spawn.nodes).toContain(joinResponse.node_id);
    expect(joinResponse.channel_id).toBe('channel-alice');
  });

  it('deletes persisted channel on agent deletion', async () => {
    const { engine, discordBot } = createTestWorld({
      engineOptions: {
        initialRegistrations: [
          createRegistration({ discord_channel_id: 'channel-alice' }),
        ],
      },
    });

    await engine.deleteAgent('agent-1');
    expect(discordBot.deletedChannels).toEqual(['channel-alice']);
  });

  it('prevents deleting an agent while login is in progress', async () => {
    const discordBot = new DeferredDiscordBot();
    const engine = new WorldEngine(createTestConfig(), discordBot);
    const alice = engine.registerAgent({ agent_name: 'alice', agent_label: 'alice', discord_bot_id: 'bot-alice', });
    const joinPromise = engine.loginAgent(alice.agent_id);

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
