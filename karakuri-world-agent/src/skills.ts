import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import { createLogger } from './logger.js';

const FRONT_MATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const GENERIC_SKILL_HEADINGS = new Set(['skill', 'skills']);
const DEFAULT_SKILL_DESCRIPTION = 'Load additional world-specific guidance before acting.';
const logger = createLogger('skills');

export interface AgentSkill {
  id: string;
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

function isMissingOrNonDirectoryError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function toFileSystemError(action: string, filePath: string, error: unknown): Error {
  const details = error instanceof Error && error.message ? error.message : 'Unknown error';

  return new Error(`Failed to ${action} at ${filePath}: ${details}`, { cause: error });
}

function readOptionalFile(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isMissingOrNonDirectoryError(error)) {
      return undefined;
    }

    throw toFileSystemError('read skill file', filePath, error);
  }
}

function readOptionalDirectoryEntries(directoryPath: string) {
  try {
    return readdirSync(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingOrNonDirectoryError(error)) {
      return [];
    }

    throw toFileSystemError('read skills directory', directoryPath, error);
  }
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
  const skillsDir = join(agentDir, 'skills');

  const skills: AgentSkill[] = [];
  const seenIds = new Set<string>();

  for (const entry of readOptionalDirectoryEntries(skillsDir)
    .filter((candidate) => candidate.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const skillDocument = readOptionalFile(join(skillsDir, entry.name, 'SKILL.md'));
    if (!skillDocument) {
      continue;
    }

    const parsed = parseSkillDocument(skillDocument, entry.name);
    const id = toToolIdentifier(entry.name);
    if (seenIds.has(id)) {
      logger.error('Duplicate skill id', { id });
      throw new Error(`Duplicate skill id: ${id}`);
    }

    seenIds.add(id);
    skills.push({
      id,
      name: parsed.name,
      description: parsed.description,
      instructions: parsed.instructions,
      allowedTools: parsed.allowedTools,
    });
  }

  logger.info('Skills loaded', {
    count: skills.length,
    names: skills.map((skill) => skill.name),
  });
  return skills;
}

export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;');
}

export function buildAvailableSkillsXml(skills: AgentSkill[]): string {
  if (skills.length === 0) {
    return '';
  }

  const skillEntries = skills
    .map((skill) => [
      '  <skill>',
      `    <id>${escapeXml(skill.id)}</id>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      '  </skill>',
    ].join('\n'))
    .join('\n');

  return `<available_skills>\n${skillEntries}\n</available_skills>`;
}

export function createReadSkillTool(skills: AgentSkill[]): ToolSet {
  if (skills.length === 0) {
    return {};
  }

  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));

  return {
    read_skill: tool({
      description: 'Load an available skill guide by skill id before acting on matching tasks.',
      inputSchema: z.object({
        skill_id: z.enum(
          [...skillsById.keys()] as [string, ...string[]],
        ).describe('The skill identifier to load.'),
      }),
      execute: async ({ skill_id }) => {
        const skill = skillsById.get(skill_id);

        if (!skill) {
          logger.debug('Unknown skill requested', { skillId: skill_id });
          return {
            error: `Unknown skill: ${skill_id}`,
          };
        }

        logger.debug('Skill tool invoked', { skillId: skill.id });
        return {
          name: skill.name,
          description: skill.description,
          allowedTools: skill.allowedTools,
          instructions: skill.instructions,
        };
      },
    }),
  };
}
