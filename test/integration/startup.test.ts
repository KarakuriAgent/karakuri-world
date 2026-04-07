import { createServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { startRuntime, type Runtime } from '../../src/index.js';
import { saveAgents } from '../../src/storage/agent-storage.js';
import type { AgentRegistration } from '../../src/types/agent.js';

const discordBotMocks = vi.hoisted(() => {
  const statusBoardChannel = {
    fetchMessages: async () => [],
    bulkDelete: async () => {},
    deleteMessage: async () => {},
    sendMessage: async () => ({ id: 'status-message' }),
    sendMessageWithImage: async () => ({ id: 'status-message-with-image' }),
  };
  const createAgentChannel = vi.fn(async () => 'channel-mock');
  const deleteAgentChannel = vi.fn(async () => {});
  const channelExists = vi.fn(async () => true);
  const sendAgentMessage = vi.fn(async () => {});
  const sendWorldLog = vi.fn(async () => {});
  const getStatusBoardChannel = vi.fn(async () => statusBoardChannel);
  const registerGuildCommands = vi.fn(async () => {});
  const unsubscribeInteractionHandler = vi.fn();
  const registerInteractionHandler = vi.fn(() => unsubscribeInteractionHandler);
  const getAdminRoleId = vi.fn(() => 'admin-role');
  const getWorldAdminChannelId = vi.fn(() => 'world-admin');
  const close = vi.fn(async () => {});
  const bot = {
    createAgentChannel,
    deleteAgentChannel,
    channelExists,
    sendAgentMessage,
    sendWorldLog,
    getStatusBoardChannel,
    registerGuildCommands,
    registerInteractionHandler,
    getAdminRoleId,
    getWorldAdminChannelId,
    close,
  };
  const create = vi.fn(async () => bot);

  function reset(): void {
    createAgentChannel.mockReset().mockResolvedValue('channel-mock');
    deleteAgentChannel.mockReset().mockResolvedValue(undefined);
    channelExists.mockReset().mockResolvedValue(true);
    sendAgentMessage.mockReset().mockResolvedValue(undefined);
    sendWorldLog.mockReset().mockResolvedValue(undefined);
    getStatusBoardChannel.mockReset().mockResolvedValue(statusBoardChannel);
    registerGuildCommands.mockReset().mockResolvedValue(undefined);
    unsubscribeInteractionHandler.mockReset();
    registerInteractionHandler.mockReset().mockReturnValue(unsubscribeInteractionHandler);
    getAdminRoleId.mockReset().mockReturnValue('admin-role');
    getWorldAdminChannelId.mockReset().mockReturnValue('world-admin');
    close.mockReset().mockResolvedValue(undefined);
    create.mockReset().mockResolvedValue(bot);
  }

  return {
    close,
    create,
    getStatusBoardChannel,
    registerGuildCommands,
    registerInteractionHandler,
    reset,
    unsubscribeInteractionHandler,
  };
});

const statusBoardMocks = vi.hoisted(() => {
  const constructed = vi.fn();
  const register = vi.fn(() => () => {});
  const dispose = vi.fn(async () => {});
  class StatusBoard {
    constructor(...args: unknown[]) {
      constructed(...args);
    }

    register = register;

    dispose = dispose;
  }

  function reset(): void {
    constructed.mockReset();
    register.mockReset().mockReturnValue(() => {});
    dispose.mockReset().mockResolvedValue(undefined);
  }

  return {
    StatusBoard,
    constructed,
    register,
    dispose,
    reset,
  };
});

vi.mock('../../src/discord/bot.js', () => {
  return {
    DiscordBot: {
      create: discordBotMocks.create,
    },
  };
});

vi.mock('../../src/discord/status-board.js', () => {
  return {
    StatusBoard: statusBoardMocks.StatusBoard,
  };
});

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
    items: [],
    ...overrides,
  };
}

function createLocalDataDir(name: string): string {
  const dataDir = join(process.cwd(), 'data', name);
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

describe('runtime startup', () => {
  beforeEach(() => {
    discordBotMocks.reset();
    statusBoardMocks.reset();
  });

  it('hydrates persisted agent registrations', async () => {
    const dataDir = createLocalDataDir('test-startup-runtime');
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
        statusBoardDebounceMs: 3000,
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

  it('closes the Discord bot if startup fails after login', async () => {
    discordBotMocks.getStatusBoardChannel.mockRejectedValueOnce(new Error('status board unavailable'));

    await expect(
      startRuntime({
        adminKey: 'test-admin-key',
        configPath: './config/example.yaml',
        dataDir: './data',
        port: 0,
        publicBaseUrl: 'http://127.0.0.1',
        discordToken: 'fake-token',
        discordGuildId: 'fake-guild',
        statusBoardDebounceMs: 3000,
      }),
    ).rejects.toThrow('status board unavailable');

    expect(discordBotMocks.close).toHaveBeenCalledTimes(1);
    expect(discordBotMocks.unsubscribeInteractionHandler).toHaveBeenCalledTimes(1);
  });

  it('does not register the status board if listen fails', async () => {
    const occupiedServer = createServer();
    await new Promise<void>((resolve) => occupiedServer.listen(0, resolve));
    const address = occupiedServer.address();
    const occupiedPort = typeof address === 'object' && address ? address.port : null;

    try {
      expect(occupiedPort).not.toBeNull();

      await expect(
        startRuntime({
          adminKey: 'test-admin-key',
          configPath: './config/example.yaml',
          dataDir: './data',
          port: occupiedPort!,
          publicBaseUrl: 'http://127.0.0.1',
          discordToken: 'fake-token',
          discordGuildId: 'fake-guild',
          statusBoardDebounceMs: 3000,
        }),
      ).rejects.toThrow(/EADDRINUSE|listen/i);
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupiedServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    expect(statusBoardMocks.register).not.toHaveBeenCalled();
    expect(statusBoardMocks.dispose).toHaveBeenCalledTimes(1);
    expect(statusBoardMocks.dispose).toHaveBeenCalledWith({ postStoppedMessage: false });
    expect(discordBotMocks.close).toHaveBeenCalledTimes(1);
    expect(discordBotMocks.unsubscribeInteractionHandler).toHaveBeenCalledTimes(1);
  });
});
