import { ToolLoopAgent, stepCountIs } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

import { buildInstructions, getConfig } from './config.js';
import { createKarakuriWorldTools } from './karakuri-world-tools.js';
import { createLogger } from './logger.js';
import { createDiaryTools } from './memory/diary.js';
import { createImportantMemoryTools } from './memory/important.js';
import { appendMemoryPromptContext } from './memory/prompt-context.js';
import { createReadSkillTool } from './skills.js';

interface AgentCallOptions {
  memoryPromptContext?: string;
}

interface AgentRuntime {
  agent: ToolLoopAgent<AgentCallOptions, any, any>;
  close: () => Promise<void>;
}

let runtime: AgentRuntime | undefined;
let runtimePromise: Promise<AgentRuntime> | undefined;
const logger = createLogger('agent');

async function createAgentRuntime(): Promise<AgentRuntime> {
  const config = getConfig();
  logger.info('Creating agent runtime', {
    model: config.openai.model,
    skillCount: config.agent.skills.length,
  });
  const openai = createOpenAI({
    apiKey: config.openai.apiKey,
    baseURL: config.openai.baseURL,
  });
  const instructions = buildInstructions(config.agent.personality, config.agent.skills);
  const diaryTools = createDiaryTools({ dataDir: config.dataDir });
  const importantMemoryTools = createImportantMemoryTools({ dataDir: config.dataDir });
  const karakuriWorldTools = createKarakuriWorldTools({
    apiBaseUrl: config.karakuri.apiBaseUrl,
    apiKey: config.karakuri.apiKey,
  });
  const skillTools = createReadSkillTool(config.agent.skills);
  const tools = {
    ...karakuriWorldTools,
    ...diaryTools,
    ...importantMemoryTools,
    ...skillTools,
  };
  logger.debug('Agent runtime created', {
    toolNames: Object.keys(tools),
  });

  return {
    agent: new ToolLoopAgent({
      model: openai.chat(config.openai.model),
      instructions,
      prepareCall: async (call) => {
        const { options, ...callWithoutOptions } = call;
        return {
          ...callWithoutOptions,
          instructions: appendMemoryPromptContext(instructions, options?.memoryPromptContext),
        };
      },
      tools,
      stopWhen: [stepCountIs(10)],
    }),
    close: async () => undefined,
  };
}

export async function initializeAgent(): Promise<ToolLoopAgent<AgentCallOptions, any, any>> {
  if (runtimePromise) {
    logger.debug('Returning cached agent');
    return (await runtimePromise).agent;
  }

  runtimePromise = createAgentRuntime()
    .then((createdRuntime) => {
      runtime = createdRuntime;
      return createdRuntime;
    })
    .catch((error) => {
      runtimePromise = undefined;
      throw error;
    });

  return (await runtimePromise).agent;
}

export function getAgent(): ToolLoopAgent<AgentCallOptions, any, any> | undefined {
  return runtime?.agent;
}

export async function closeAgentResources(): Promise<void> {
  const activeRuntime = runtime ?? (runtimePromise ? await runtimePromise.catch(() => undefined) : undefined);

  runtime = undefined;
  runtimePromise = undefined;

  if (activeRuntime) {
    logger.info('Closing agent resources');
    await activeRuntime.close();
  }
}
