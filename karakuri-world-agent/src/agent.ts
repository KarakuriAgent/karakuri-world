import { ToolLoopAgent, stepCountIs } from 'ai';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { createOpenAI } from '@ai-sdk/openai';

import { buildInstructions, getConfig } from './config.js';
import { createLazyMcpRuntime } from './lazy-mcp.js';
import { createDiaryTools } from './memory/diary.js';
import { createMcpProxyTools } from './mcp-tools.js';
import { createImportantMemoryTools } from './memory/important.js';
import { createSkillTools } from './skills.js';

interface AgentRuntime {
  agent: ToolLoopAgent<never, any, any>;
  close: () => Promise<void>;
}

let runtime: AgentRuntime | undefined;
let runtimePromise: Promise<AgentRuntime> | undefined;

async function createAgentRuntime(): Promise<AgentRuntime> {
  const config = getConfig();
  const openai = createOpenAI({
    apiKey: config.openai.apiKey,
    baseURL: config.openai.baseURL,
  });
  const instructions = buildInstructions(config.agent.personality, config.agent.skillTools.length > 0);
  const diaryTools = createDiaryTools({ dataDir: config.dataDir });
  const importantMemoryTools = createImportantMemoryTools({ dataDir: config.dataDir });
  const lazyMcp = createLazyMcpRuntime({
    createClient: async (): Promise<MCPClient> =>
      createMCPClient({
        transport: {
          type: 'http',
          url: config.karakuri.mcpUrl,
          headers: {
            Authorization: `Bearer ${config.karakuri.apiKey}`,
          },
        },
      }),
  });
  const mcpTools = createMcpProxyTools({
    getRuntimeTools: () => lazyMcp.getTools(),
    resetRuntime: () => lazyMcp.reset(),
  });
  const skillTools = createSkillTools(config.agent.skillTools);
  const tools = {
    ...mcpTools,
    ...diaryTools,
    ...importantMemoryTools,
    ...skillTools,
  };

  return {
    agent: new ToolLoopAgent({
      model: openai.chat(config.openai.model),
      instructions,
      tools,
      stopWhen: [stepCountIs(10)],
    }),
    close: async () => {
      await lazyMcp.close();
    },
  };
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
    await activeRuntime.close();
  }
}
