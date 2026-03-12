import { describe, expect, it } from 'vitest';

import { createTestWorld } from '../helpers/test-world.js';

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
    const { engine } = createTestWorld({ withDiscord: false });
    const alice = engine.registerAgent({ agent_name: 'alice' });
    const bob = engine.registerAgent({ agent_name: 'bob' });

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
});
