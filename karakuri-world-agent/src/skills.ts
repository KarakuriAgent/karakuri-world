import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { tool } from 'ai';
import { z } from 'zod';

const FRONT_MATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const GENERIC_SKILL_HEADINGS = new Set(['skill', 'skills']);
const DEFAULT_SKILL_DESCRIPTION = 'Load additional world-specific guidance before acting.';

export interface AgentSkill {
  toolName: string;
  name: string;
  description: string;
  instructions: string;
  allowedTools?: string;
}

interface ParsedSkillDocument {
  name: string;
  description: string;
  instructions: string;
  allowedTools?: string;
}

function readOptionalFile(filePath: string): string | undefined {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : undefined;
}

function stripMatchingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith('\'') && value.endsWith('\''))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function parseFrontMatterAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex < 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = stripMatchingQuotes(trimmed.slice(separatorIndex + 1).trim());

    if (key && value) {
      attributes[key] = value;
    }
  }

  return attributes;
}

function parseFrontMatter(document: string): {
  attributes: Record<string, string>;
  body: string;
} {
  const match = document.match(FRONT_MATTER_PATTERN);
  if (!match) {
    return {
      attributes: {},
      body: document,
    };
  }

  return {
    attributes: parseFrontMatterAttributes(match[1]),
    body: match[2],
  };
}

function inferSkillName(body: string, fallbackName: string): string {
  const heading = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('# '))
    ?.replace(/^#\s+/, '')
    .trim();

  if (heading && !GENERIC_SKILL_HEADINGS.has(heading.toLowerCase())) {
    return heading;
  }

  return fallbackName;
}

function inferSkillDescription(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const normalized = trimmed.replace(/^[-*]\s+/, '').trim();
    if (!normalized) {
      continue;
    }

    return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
  }

  return DEFAULT_SKILL_DESCRIPTION;
}

function toToolIdentifier(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || 'agent';
}

export function parseSkillDocument(document: string, fallbackName: string): ParsedSkillDocument {
  const { attributes, body } = parseFrontMatter(document);
  const instructions = body.trim() ? body.trim() : document.trim();

  return {
    name: attributes.name?.trim() || inferSkillName(instructions, fallbackName),
    description: attributes.description?.trim() || inferSkillDescription(instructions),
    instructions,
    allowedTools: attributes['allowed-tools']?.trim(),
  };
}

export function loadAgentSkills(agentDir: string): AgentSkill[] {
  const skillDocument = readOptionalFile(join(agentDir, 'SKILL.md'));
  if (!skillDocument) {
    return [];
  }

  const fallbackName = basename(agentDir);
  const parsed = parseSkillDocument(skillDocument, fallbackName);

  return [
    {
      toolName: `load_skill_${toToolIdentifier(parsed.name)}`,
      name: parsed.name,
      description: parsed.description,
      instructions: parsed.instructions,
      allowedTools: parsed.allowedTools,
    },
  ];
}

export function createSkillTools(skills: AgentSkill[]) {
  return Object.fromEntries(
    skills.map((skill) => [
      skill.toolName,
      tool({
        description: `Load the "${skill.name}" skill guide when you need more detailed guidance. ${skill.description}`,
        inputSchema: z.object({}),
        execute: async () => ({
          name: skill.name,
          description: skill.description,
          allowedTools: skill.allowedTools,
          instructions: skill.instructions,
        }),
      }),
    ]),
  );
}
