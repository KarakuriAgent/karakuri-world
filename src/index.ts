import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { getRequestListener } from '@hono/node-server';

import { createApp } from './api/app.js';
import { loadConfigFromFile } from './config/index.js';
import { DiscordBot } from './discord/bot.js';
import { DiscordEventHandler } from './discord/event-handler.js';
import { WorldEngine } from './engine/world-engine.js';
import { McpServerManager } from './mcp/server.js';
import { loadAgents, saveAgents } from './storage/agent-storage.js';

export interface RuntimeOptions {
  adminKey: string;
  configPath: string;
  dataDir: string;
  port: number;
  publicBaseUrl: string;
  discordToken: string;
  discordGuildId: string;
}

export interface Runtime {
  engine: WorldEngine;
  server: Server;
  discordBot: DiscordBot;
  mcpServerManager: McpServerManager;
  stop(): Promise<void>;
}

function getRequiredEnv(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return trimmed;
}

function getOptionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveRuntimeOptions(env: NodeJS.ProcessEnv = process.env): RuntimeOptions {
  const port = Number.parseInt(env.PORT ?? '3000', 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT value: ${env.PORT ?? ''}`);
  }

  return {
    adminKey: getRequiredEnv('ADMIN_KEY', env.ADMIN_KEY),
    configPath: getOptionalEnv(env.CONFIG_PATH) ?? './config/example.yaml',
    dataDir: getOptionalEnv(env.DATA_DIR) ?? './data',
    port,
    publicBaseUrl: getOptionalEnv(env.PUBLIC_BASE_URL) ?? `http://127.0.0.1:${port}`,
    discordToken: getRequiredEnv('DISCORD_TOKEN', env.DISCORD_TOKEN),
    discordGuildId: getRequiredEnv('DISCORD_GUILD_ID', env.DISCORD_GUILD_ID),
  };
}

export async function startRuntime(options: RuntimeOptions): Promise<Runtime> {
  const config = await loadConfigFromFile(options.configPath);
  const agentsFilePath = join(options.dataDir, 'agents.json');
  const initialRegistrations = loadAgents(agentsFilePath);
  const discordBot = await DiscordBot.create({
    token: options.discordToken,
    guildId: options.discordGuildId,
  });
  const engine = new WorldEngine(config, discordBot, {
    initialRegistrations,
    onRegistrationChanged: (agents) => saveAgents(agentsFilePath, agents),
  });
  const discordEventHandler = new DiscordEventHandler(engine, discordBot);
  const { app, injectWebSocket, websocketManager } = createApp(engine, {
    adminKey: options.adminKey,
    configPath: options.configPath,
    publicBaseUrl: options.publicBaseUrl,
  });
  const mcpServerManager = new McpServerManager(engine);
  const requestListener = getRequestListener(app.fetch);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (url.pathname === '/mcp') {
      void mcpServerManager.handleRequest(req, res);
      return;
    }

    void requestListener(req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Internal server error');
      }
    });
  });

  injectWebSocket(server);
  discordEventHandler.register();

  await new Promise<void>((resolve) => {
    server.listen(options.port, resolve);
  });

  return {
    engine,
    server,
    discordBot,
    mcpServerManager,
    async stop() {
      discordEventHandler.dispose();
      websocketManager.dispose();
      await mcpServerManager.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
      await discordBot.close();
    },
  };
}

export async function main(): Promise<void> {
  const options = resolveRuntimeOptions();
  const runtime = await startRuntime(options);

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down...`);
    await runtime.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  console.log(
    `Karakuri World listening on port ${options.port}.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
