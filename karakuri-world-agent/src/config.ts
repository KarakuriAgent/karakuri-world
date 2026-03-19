import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadAgentSkills, type AgentSkill } from './skills.js';

export interface Config {
  discord: {
    token: string;
    publicKey: string;
    applicationId: string;
    mentionRoleIds?: string[];
  };
  server: {
    port: number;
  };
  openai: {
    apiKey: string;
    baseURL?: string;
    model: string;
  };
  karakuri: {
    apiBaseUrl: string;
    apiKey: string;
  };
  agent: {
    dir: string;
    personality: string;
    skillTools: AgentSkill[];
    botName: string;
  };
  dataDir: string;
}

const DEFAULT_PERSONALITY = 'You are a helpful agent living in a virtual world.';
const DEFAULT_BOT_NAME = 'karakuri-agent';
const DEFAULT_DATA_DIR = './data';
const DEFAULT_OPENAI_MODEL = 'gpt-4o';
const DEFAULT_SERVER_PORT = 3000;

let configCache: Config | undefined;

function optionalNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireNonEmpty(value: string | undefined, name: string): string {
  const trimmed = optionalNonEmpty(value);
  if (!trimmed) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return trimmed;
}

function parsePort(value: string | undefined): number {
  const raw = optionalNonEmpty(value);
  if (!raw) {
    return DEFAULT_SERVER_PORT;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid PORT value: ${raw}`);
  }

  return parsed;
}

function normalizeApiBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export function readAgentFile(agentDir: string, fileName: string): string | undefined {
  const filePath = join(agentDir, fileName);
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : undefined;
}

export function parseMentionRoleIds(value: string | undefined): string[] | undefined {
  const parts = value
    ?.split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts && parts.length > 0 ? parts : undefined;
}

const CALLABLE_SKILL_HINT =
  'Additional agent skill guides are available as callable tools. Call them when you need more detailed, world-specific guidance before acting.';

export function buildInstructions(personality: string, hasSkillTools = false): string {
  const sections = [personality];

  if (hasSkillTools) {
    sections.push(CALLABLE_SKILL_HINT);
  }

  return sections.join('\n\n---\n\n');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const agentDir = resolve(requireNonEmpty(env.AGENT_DIR, 'AGENT_DIR'));
  const loadedSkills = loadAgentSkills(agentDir);
  const discordToken = optionalNonEmpty(env.DISCORD_TOKEN) ?? optionalNonEmpty(env.DISCORD_BOT_TOKEN);

  if (!discordToken) {
    throw new Error('Missing required environment variable: DISCORD_TOKEN or DISCORD_BOT_TOKEN');
  }

  return {
    discord: {
      token: discordToken,
      publicKey: requireNonEmpty(env.DISCORD_PUBLIC_KEY, 'DISCORD_PUBLIC_KEY'),
      applicationId: requireNonEmpty(env.DISCORD_APPLICATION_ID, 'DISCORD_APPLICATION_ID'),
      mentionRoleIds: parseMentionRoleIds(env.DISCORD_MENTION_ROLE_IDS),
    },
    server: {
      port: parsePort(env.PORT),
    },
    openai: {
      apiKey: requireNonEmpty(env.OPENAI_API_KEY, 'OPENAI_API_KEY'),
      baseURL: optionalNonEmpty(env.OPENAI_BASE_URL),
      model: optionalNonEmpty(env.OPENAI_MODEL) ?? DEFAULT_OPENAI_MODEL,
    },
    karakuri: {
      apiBaseUrl: normalizeApiBaseUrl(
        requireNonEmpty(env.KARAKURI_API_BASE_URL, 'KARAKURI_API_BASE_URL'),
      ),
      apiKey: requireNonEmpty(env.KARAKURI_API_KEY, 'KARAKURI_API_KEY'),
    },
    agent: {
      dir: agentDir,
      personality: readAgentFile(agentDir, 'personality.md') ?? DEFAULT_PERSONALITY,
      skillTools: loadedSkills,
      botName: optionalNonEmpty(env.BOT_NAME) ?? DEFAULT_BOT_NAME,
    },
    dataDir: resolve(optionalNonEmpty(env.DATA_DIR) ?? DEFAULT_DATA_DIR),
  };
}

export function getConfig(): Config {
  configCache ??= loadConfig();
  return configCache;
}

export function resetConfigCache(): void {
  configCache = undefined;
}

export const config = new Proxy({} as Config, {
  get(_target, property) {
    return Reflect.get(getConfig(), property);
  },
});
