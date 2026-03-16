import { closeAgentResources } from './agent.js';
import { shutdownBot, startBot } from './bot.js';
import { config } from './config.js';
import { DISCORD_WEBHOOK_PATH, startServer, type AgentServer } from './server.js';

let shuttingDown = false;
let server: AgentServer | undefined;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Shutting down agent "${config.agent.botName}" (${signal})...`);

  let exitCode = 0;

  try {
    await shutdownBot();
  } catch (error) {
    exitCode = 1;
    console.error('Failed to shut down bot cleanly.', error);
  }

  try {
    await server?.close();
  } catch (error) {
    exitCode = 1;
    console.error('Failed to shut down HTTP server cleanly.', error);
  }

  try {
    await closeAgentResources();
  } catch (error) {
    exitCode = 1;
    console.error('Failed to close MCP client cleanly.', error);
  }

  process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  server = await startServer();
  await startBot(server.localWebhookUrl);
  console.log(
    `Agent "${config.agent.botName}" started on port ${server.port} (${DISCORD_WEBHOOK_PATH}).`,
  );
} catch (error) {
  console.error('Failed to start karakuri-world-agent.', error);

  try {
    await shutdownBot();
  } catch {
    // Ignore shutdown cleanup failures after startup failure.
  }

  try {
    await closeAgentResources();
  } catch {
    // Ignore cleanup failures after startup failure.
  }

  try {
    await server?.close();
  } catch {
    // Ignore cleanup failures after startup failure.
  }

  process.exit(1);
}
