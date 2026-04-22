import { describe, expect, it, vi } from 'vitest';

import { WorldEngine } from '../../../src/engine/world-engine.js';
import { WorldError } from '../../../src/types/api.js';
import { createTestConfig } from '../../helpers/test-map.js';

describe('WorldEngine registration', () => {
  it('rejects a concurrent duplicate registration for the same bot id', async () => {
    let releaseFetch = () => {};
    const persistedSnapshots: string[][] = [];
    const engine = new WorldEngine(
      createTestConfig(),
      {
        createAgentChannel: async () => 'channel-id',
        deleteAgentChannel: async () => {},
        channelExists: async () => true,
        fetchBotInfo: async (discordBotId: string) => {
          await new Promise<void>((resolve) => {
            releaseFetch = resolve;
          });

          return {
            username: `bot-${discordBotId}`,
            avatarURL: `https://example.com/avatar/${discordBotId}.png`,
          };
        },
      },
      {
        onRegistrationChanged: (agents) => {
          persistedSnapshots.push(agents.map((agent) => agent.agent_id));
        },
      },
    );

    const first = engine.registerAgent({ discord_bot_id: 'bot-duplicate' });
    const second = engine.registerAgent({ discord_bot_id: 'bot-duplicate' });

    releaseFetch();

    const results = await Promise.allSettled([first, second]);
    const rejected = results.find((result) => result.status === 'rejected');

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejected?.status).toBe('rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(WorldError);
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
      code: 'state_conflict',
    });
    expect(engine.listAgents()).toHaveLength(1);
    expect(persistedSnapshots).toHaveLength(1);
  });
});
