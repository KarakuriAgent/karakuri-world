import { createServer, type Server } from 'node:http';

import { getRequestListener } from '@hono/node-server';

import { createApp } from './api/app.js';
import { loadConfig } from './config/index.js';
import { DiscordBot } from './discord/bot.js';
import { DiscordEventHandler } from './discord/event-handler.js';
import { WorldEngine } from './engine/world-engine.js';
import { McpServerManager } from './mcp/server.js';

export interface RuntimeOptions {
  adminKey: string;
  configPath: string;
  port: number;
  publicBaseUrl: string;
  discordToken?: string;
  discordGuildId?: string;
}

export interface Runtime {
  engine: WorldEngine;
  server: Server;
  discordBot: DiscordBot | null;
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

  const discordToken = getOptionalEnv(env.DISCORD_TOKEN);
  const discordGuildId = getOptionalEnv(env.DISCORD_GUILD_ID);
  if (Boolean(discordToken) !== Boolean(discordGuildId)) {
    throw new Error('DISCORD_TOKEN and DISCORD_GUILD_ID must be set together.');
  }

  return {
    adminKey: getRequiredEnv('ADMIN_KEY', env.ADMIN_KEY),
    configPath: getOptionalEnv(env.CONFIG_PATH) ?? './config/example.yaml',
    port,
    publicBaseUrl: getOptionalEnv(env.PUBLIC_BASE_URL) ?? `http://127.0.0.1:${port}`,
    discordToken,
    discordGuildId,
  };
}

export async function startRuntime(options: RuntimeOptions): Promise<Runtime> {
  const config = await loadConfig(options.configPath);
  const discordBot =
    options.discordToken && options.discordGuildId
      ? await DiscordBot.create({
          token: options.discordToken,
          guildId: options.discordGuildId,
        })
      : null;
  const engine = new WorldEngine(config, discordBot);
  const discordEventHandler = discordBot ? new DiscordEventHandler(engine, discordBot) : null;
  const { app, injectWebSocket, websocketManager } = createApp(engine, {
    adminKey: options.adminKey,
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
  discordEventHandler?.register();

  await new Promise<void>((resolve) => {
    server.listen(options.port, resolve);
  });

  return {
    engine,
    server,
    discordBot,
    mcpServerManager,
    async stop() {
      discordEventHandler?.dispose();
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
      await discordBot?.close();
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
    `Karakuri World listening on port ${options.port}${options.discordToken ? ' with Discord integration enabled' : ''}.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
