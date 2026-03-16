import { ToolLoopAgent, stepCountIs } from 'ai';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { createOpenAI } from '@ai-sdk/openai';

import { buildInstructions, getConfig } from './config.js';
import { createDiaryTools } from './memory/diary.js';
import { createImportantMemoryTools } from './memory/important.js';

interface AgentRuntime {
  agent: ToolLoopAgent<never, any, any>;
  mcpClient: MCPClient;
}

let runtime: AgentRuntime | undefined;
let runtimePromise: Promise<AgentRuntime> | undefined;

async function createAgentRuntime(): Promise<AgentRuntime> {
  const config = getConfig();
  const openai = createOpenAI({
    apiKey: config.openai.apiKey,
    baseURL: config.openai.baseURL,
  });
  const instructions = buildInstructions(config.agent.personality, config.agent.skills);
  const diaryTools = createDiaryTools({ dataDir: config.dataDir });
  const importantMemoryTools = createImportantMemoryTools({ dataDir: config.dataDir });
  const mcpClient = await createMCPClient({
    transport: {
      type: 'http',
      url: config.karakuri.mcpUrl,
      headers: {
        Authorization: `Bearer ${config.karakuri.apiKey}`,
      },
    },
  });

  try {
    const mcpTools = await mcpClient.tools();

    return {
      agent: new ToolLoopAgent({
        model: openai.chat(config.openai.model),
        instructions,
        tools: {
          ...mcpTools,
          ...diaryTools,
          ...importantMemoryTools,
        },
        stopWhen: [stepCountIs(10)],
      }),
      mcpClient,
    };
  } catch (error) {
    await mcpClient.close().catch(() => undefined);
    throw error;
  }
}

export async function initializeAgent(): Promise<ToolLoopAgent<never, any, any>> {
  if (!runtimePromise) {
    runtimePromise = createAgentRuntime()
      .then((createdRuntime) => {
        runtime = createdRuntime;
        return createdRuntime;
      })
      .catch((error) => {
        runtimePromise = undefined;
        throw error;
      });
  }

  return (await runtimePromise).agent;
}

export function getAgent(): ToolLoopAgent<never, any, any> | undefined {
  return runtime?.agent;
}

export async function closeAgentResources(): Promise<void> {
  const activeRuntime = runtime ?? (runtimePromise ? await runtimePromise.catch(() => undefined) : undefined);

  runtime = undefined;
  runtimePromise = undefined;

  if (activeRuntime) {
    await activeRuntime.mcpClient.close();
  }
}
