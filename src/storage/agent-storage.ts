import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

import type { AgentRegistration } from '../types/agent.js';

const agentNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/;
const apiKeyPattern = /^karakuri_[0-9a-f]+$/;

export interface AgentsFileData {
  version: number;
  agents: AgentRegistration[];
}

export const CURRENT_VERSION = 1;

const agentRegistrationSchema = z.object({
  agent_id: z.string().min(1),
  agent_name: z.string().min(2).max(32).regex(agentNamePattern),
  api_key: z.string().regex(apiKeyPattern),
  discord_bot_id: z.string().min(1),
  created_at: z.number().int().nonnegative(),
});

const agentsFileSchema = z.object({
  version: z.number().int(),
  agents: z.array(agentRegistrationSchema),
});

export function loadAgents(filePath: string): AgentRegistration[] {
  if (!existsSync(filePath)) {
    saveAgents(filePath, []);
    return [];
  }

  const raw = readFileSync(filePath, 'utf8');
  return validateAgentsFileData(JSON.parse(raw)).agents;
}

export function saveAgents(filePath: string, agents: AgentRegistration[]): void {
  const fileData = validateAgentsFileData({ version: CURRENT_VERSION, agents });
  const tmpPath = `${filePath}.tmp`;

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(tmpPath, `${JSON.stringify(fileData, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

function validateAgentsFileData(value: unknown): AgentsFileData {
  const parsed = agentsFileSchema.parse(value);

  if (parsed.version !== CURRENT_VERSION) {
    throw new Error(`Unsupported agents file version: ${parsed.version}`);
  }

  validateUnique(parsed.agents, 'agent_id', (agent) => agent.agent_id);
  validateUnique(parsed.agents, 'agent_name', (agent) => agent.agent_name);
  validateUnique(parsed.agents, 'api_key', (agent) => agent.api_key);

  return {
    version: CURRENT_VERSION,
    agents: sortRegistrations(parsed.agents),
  };
}

function validateUnique(
  agents: AgentRegistration[],
  fieldName: 'agent_id' | 'agent_name' | 'api_key',
  getValue: (agent: AgentRegistration) => string,
): void {
  const seen = new Set<string>();

  for (const agent of agents) {
    const value = getValue(agent);
    if (seen.has(value)) {
      throw new Error(`Duplicate ${fieldName}: ${value}`);
    }
    seen.add(value);
  }
}

function sortRegistrations(agents: AgentRegistration[]): AgentRegistration[] {
  return [...agents].sort(
    (left, right) => left.agent_name.localeCompare(right.agent_name) || left.agent_id.localeCompare(right.agent_id),
  );
}
