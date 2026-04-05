import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

import { agentNamePattern } from '../domain/agent-validation.js';
import type { AgentRegistration } from '../types/agent.js';
import type { NodeId } from '../types/data-model.js';

const apiKeyPattern = /^karakuri_[0-9a-f]+$/;
const nodeIdPattern = /^\d+-\d+$/;
const itemSchema = z.object({
  item_id: z.string().min(1),
  quantity: z.number().int().min(1),
});

export interface AgentsFileData {
  version: number;
  agents: AgentRegistration[];
}

export const CURRENT_VERSION = 3;

const agentRegistrationSchemaV1 = z.object({
  agent_id: z.string().min(1),
  agent_name: z.string().min(2).max(32).regex(agentNamePattern),
  api_key: z.string().regex(apiKeyPattern),
  discord_bot_id: z.string().min(1),
  created_at: z.number().int().nonnegative(),
});

const agentRegistrationSchemaV2 = agentRegistrationSchemaV1.extend({
  agent_label: z.string().min(1).max(100),
  discord_channel_id: z.string().min(1).optional(),
  last_node_id: z.string().regex(nodeIdPattern).optional().transform((v) => v as NodeId | undefined),
});

const agentRegistrationSchema = agentRegistrationSchemaV2.extend({
  money: z.number().int().min(0).optional(),
  items: z.array(itemSchema).optional(),
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
  const parsed = JSON.parse(raw);
  const fileData = validateAgentsFileData(parsed);

  if (parsed.version !== CURRENT_VERSION) {
    saveAgents(filePath, fileData.agents);
  }

  return fileData.agents;
}

export function saveAgents(filePath: string, agents: AgentRegistration[]): void {
  const fileData = validateAgentsFileData({ version: CURRENT_VERSION, agents });
  const tmpPath = `${filePath}.tmp`;

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(tmpPath, `${JSON.stringify(fileData, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

function validateAgentsFileData(value: unknown): AgentsFileData {
  const raw = z.object({ version: z.number().int() }).passthrough().parse(value);

  if (raw.version === 1) {
    const v1 = z.object({ version: z.literal(1), agents: z.array(agentRegistrationSchemaV1) }).parse(value);
    return validateAgentsFileData({
      ...v1,
      version: CURRENT_VERSION,
      agents: v1.agents.map((agent) => ({
        ...agent,
        agent_label: agent.agent_name,
        money: 0,
        items: [],
      })),
    });
  }

  if (raw.version === 2) {
    const v2 = z.object({ version: z.literal(2), agents: z.array(agentRegistrationSchemaV2) }).parse(value);
    return validateAgentsFileData({
      ...v2,
      version: CURRENT_VERSION,
      agents: v2.agents.map((agent) => ({
        ...agent,
        money: 0,
        items: [],
      })),
    });
  }

  const parsed = agentsFileSchema.parse(value);

  if (parsed.version !== CURRENT_VERSION) {
    throw new Error(`Unsupported agents file version: ${parsed.version}`);
  }

  validateUnique(parsed.agents, 'agent_id', (agent) => agent.agent_id);
  validateUnique(parsed.agents, 'agent_name', (agent) => agent.agent_name);
  validateUnique(parsed.agents, 'api_key', (agent) => agent.api_key);

  return {
    version: CURRENT_VERSION,
    agents: sortRegistrations(parsed.agents.map((agent) => ({ ...agent, items: [...(agent.items ?? [])] }))),
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
