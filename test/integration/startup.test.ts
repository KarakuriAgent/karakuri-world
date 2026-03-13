import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { startRuntime, type Runtime } from '../../src/index.js';
import { saveAgents } from '../../src/storage/agent-storage.js';
import type { AgentRegistration } from '../../src/types/agent.js';

vi.mock('../../src/discord/bot.js', () => {
  const bot = {
    createAgentChannel: async () => 'channel-mock',
    deleteAgentChannel: async () => {},
    sendAgentMessage: async () => {},
    sendWorldLog: async () => {},
    close: async () => {},
  };
  return {
    DiscordBot: {
      create: async () => bot,
    },
  };
});

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

describe('runtime startup', () => {
  it('hydrates persisted agent registrations', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'karakuri-world-startup-'));
    let runtime: Runtime | null = null;

    saveAgents(join(dataDir, 'agents.json'), [
      createRegistration({
        agent_id: 'agent-2',
        agent_name: 'bob',
        api_key: 'karakuri_feedface',
        discord_bot_id: 'bot-bob',
        created_at: 2,
      }),
      createRegistration(),
    ]);

    try {
      runtime = await startRuntime({
        adminKey: 'test-admin-key',
        configPath: './config/example.yaml',
        dataDir,
        port: 0,
        publicBaseUrl: 'http://127.0.0.1',
        discordToken: 'fake-token',
        discordGuildId: 'fake-guild',
      });

      expect(runtime.engine.listAgents()).toEqual([
        createRegistration(),
        createRegistration({
          agent_id: 'agent-2',
          agent_name: 'bob',
          api_key: 'karakuri_feedface',
          discord_bot_id: 'bot-bob',
          created_at: 2,
        }),
      ]);
    } finally {
      if (runtime) {
        await runtime.stop();
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
