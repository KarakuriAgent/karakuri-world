import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { getRequestListener } from '@hono/node-server';

import { createApp } from './api/app.js';
import { getShutdownErrorResponse, isRequestAllowedDuringShutdown } from './api/shutdown.js';
import { loadConfigFromFile } from './config/index.js';
import { AdminCommandHandler } from './discord/admin-commands.js';
import { DiscordBot } from './discord/bot.js';
import { DiscordEventHandler } from './discord/event-handler.js';
import { renderMapImage } from './discord/map-renderer.js';
import { StatusBoard } from './discord/status-board.js';
import { WeatherService } from './domain/weather.js';
import { AgentHistoryManager } from './engine/agent-history-manager.js';
import { SnapshotPublisher } from './engine/snapshot-publisher.js';
import { WorldEngine } from './engine/world-engine.js';
import { McpServerManager } from './mcp/server.js';
import { loadAgents, saveAgents } from './storage/agent-storage.js';

export interface RuntimeOptions {
  adminKey: string;
  configPath: string;
  dataDir: string;
  port: number;
  publicBaseUrl: string;
  snapshotPublishBaseUrl: string;
  snapshotPublishAuthKey: string;
  discordToken: string;
  discordGuildId: string;
  openWeatherMapApiKey?: string;
  statusBoardDebounceMs: number;
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

  const statusBoardDebounceMs = Number.parseInt(env.STATUS_BOARD_DEBOUNCE_MS ?? '3000', 10);
  if (!Number.isInteger(statusBoardDebounceMs) || statusBoardDebounceMs < 0) {
    throw new Error(`Invalid STATUS_BOARD_DEBOUNCE_MS value: ${env.STATUS_BOARD_DEBOUNCE_MS ?? ''}`);
  }

  return {
    adminKey: getRequiredEnv('ADMIN_KEY', env.ADMIN_KEY),
    configPath: getOptionalEnv(env.CONFIG_PATH) ?? './config/example.yaml',
    dataDir: getOptionalEnv(env.DATA_DIR) ?? './data',
    port,
    publicBaseUrl: getOptionalEnv(env.PUBLIC_BASE_URL) ?? `http://127.0.0.1:${port}`,
    snapshotPublishBaseUrl: getRequiredEnv('SNAPSHOT_PUBLISH_BASE_URL', env.SNAPSHOT_PUBLISH_BASE_URL),
    snapshotPublishAuthKey: getRequiredEnv('SNAPSHOT_PUBLISH_AUTH_KEY', env.SNAPSHOT_PUBLISH_AUTH_KEY),
    discordToken: getRequiredEnv('DISCORD_TOKEN', env.DISCORD_TOKEN),
    discordGuildId: getRequiredEnv('DISCORD_GUILD_ID', env.DISCORD_GUILD_ID),
    openWeatherMapApiKey: getOptionalEnv(env.OPENWEATHERMAP_API_KEY),
    statusBoardDebounceMs,
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
  let server: Server | null = null;
  let mcpServerManager: McpServerManager | null = null;
  let discordEventHandler: DiscordEventHandler | null = null;
  let adminCommandHandler: AdminCommandHandler | null = null;
  let statusBoard: StatusBoard | null = null;
  let weatherService: WeatherService | null = null;
  const shutdownState = { active: false };
  let stopPromise: Promise<void> | null = null;

  const reportError = (message: string) => {
    void discordBot.sendErrorReport(message).catch((err) => {
      console.error('Failed to send error report to Discord.', err);
    });
  };

  try {
    if (config.weather && options.openWeatherMapApiKey) {
      weatherService = new WeatherService(config.weather, options.openWeatherMapApiKey, reportError);
      await weatherService.start();
    } else if (config.weather) {
      console.warn('Weather config is present but OPENWEATHERMAP_API_KEY is not set. Weather updates are disabled.');
    }

    const snapshotPublisher = new SnapshotPublisher({
      workerBaseUrl: new URL(options.snapshotPublishBaseUrl),
      authKey: options.snapshotPublishAuthKey,
    });
    const agentHistoryManager = new AgentHistoryManager({
      workerBaseUrl: new URL(options.snapshotPublishBaseUrl),
      authKey: options.snapshotPublishAuthKey,
    });
    const engine = new WorldEngine(config, discordBot, {
      initialRegistrations,
      onRegistrationChanged: (agents) => saveAgents(agentsFilePath, agents),
      weatherService: weatherService ?? undefined,
      onError: reportError,
      snapshotPublisher,
      agentHistoryManager,
    });
    snapshotPublisher.setBuildSnapshot(() => engine.getSnapshot());
    // Ensure the spectator relay has a current snapshot right after a restart,
    // even if no world event fires for a while.
    snapshotPublisher.requestPublish();
    const adminRoleId = discordBot.getAdminRoleId();
    const worldAdminChannelId = discordBot.getWorldAdminChannelId();
    adminCommandHandler = new AdminCommandHandler(engine, options.publicBaseUrl, adminRoleId, worldAdminChannelId);
    await adminCommandHandler.register(discordBot);
    discordEventHandler = new DiscordEventHandler(engine, discordBot);
    const statusBoardChannel = await discordBot.getStatusBoardChannel();
    let mapImage: Buffer | null = null;
    try {
      mapImage = await renderMapImage(config.map);
    } catch (error) {
      console.error('Failed to render status board map image.', error);
    }
    statusBoard = new StatusBoard(engine, statusBoardChannel, {
      debounceMs: options.statusBoardDebounceMs,
      mapImage,
      onError: reportError,
    });
    const { app } = createApp(engine, {
      adminKey: options.adminKey,
      publicBaseUrl: options.publicBaseUrl,
      isShuttingDown: () => shutdownState.active,
    });
    mcpServerManager = new McpServerManager(engine);
    const requestListener = getRequestListener(app.fetch);

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (shutdownState.active && !isRequestAllowedDuringShutdown(req.method ?? 'GET', url.pathname)) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(getShutdownErrorResponse()));
        return;
      }

      if (url.pathname === '/mcp') {
        void mcpServerManager!.handleRequest(req, res);
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

    discordEventHandler.register();

    await new Promise<void>((resolve, reject) => {
      const handleListening = (): void => {
        server!.off('error', handleError);
        resolve();
      };
      const handleError = (listenError: Error): void => {
        server!.off('listening', handleListening);
        reject(listenError);
      };

      server!.once('listening', handleListening);
      server!.once('error', handleError);
      server!.listen(options.port);
    });

    statusBoard.register();

    const activeServer = server!;
    const activeDiscordEventHandler = discordEventHandler!;
    const activeMcpServerManager = mcpServerManager!;
    const activeWeatherService = weatherService;

    return {
      engine,
      server: activeServer,
      discordBot,
      mcpServerManager: activeMcpServerManager,
      async stop() {
        if (stopPromise) {
          await stopPromise;
          return;
        }

        shutdownState.active = true;
        stopPromise = (async () => {
          await new Promise<void>((resolve, reject) => {
            activeServer.close((error) => {
              if (error) {
                reject(error);
                return;
              }

              resolve();
            });
          });
          await engine.dispose();
          activeWeatherService?.stop();
          await statusBoard?.dispose();
          adminCommandHandler?.dispose();
          activeDiscordEventHandler.dispose();
          await activeMcpServerManager.close();
          await discordBot.close();
        })();

        await stopPromise;
      },
    };
  } catch (error) {
    weatherService?.stop();
    if (statusBoard) {
      await statusBoard.dispose({ postStoppedMessage: false }).catch((disposeError) => {
        console.error('Failed to dispose status board after startup error.', disposeError);
      });
    }
    adminCommandHandler?.dispose();
    discordEventHandler?.dispose();
    if (mcpServerManager) {
      await mcpServerManager.close().catch((closeError) => {
        console.error('Failed to close MCP server manager after startup error.', closeError);
      });
    }
    if (server?.listening) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      }).catch((closeError) => {
        console.error('Failed to close HTTP server after startup error.', closeError);
      });
    }
    await discordBot.close().catch((closeError) => {
      console.error('Failed to close Discord bot after startup error.', closeError);
    });
    throw error;
  }
}

export async function main(): Promise<void> {
  const options = resolveRuntimeOptions();
  const runtime = await startRuntime(options);

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down...`);
    try {
      await runtime.stop();
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  console.log(`Karakuri World listening on port ${options.port}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
