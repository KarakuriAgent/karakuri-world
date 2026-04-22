import { readFile } from 'node:fs/promises';

import type { ZodIssue } from 'zod';
import yaml from 'js-yaml';

import type { ServerConfig } from '../types/data-model.js';
import { serverConfigSchema } from './schema.js';
import { collectValidationIssues, ConfigValidationError, type ConfigValidationIssue } from './validation.js';

export type ConfigValidationResult =
  | { success: true; config: ServerConfig }
  | { success: false; issues: ConfigValidationIssue[] };

function formatIssuePath(path: Array<string | number>): string {
  if (path.length === 0) {
    return 'root';
  }

  return path.reduce<string>((result, segment) => {
    if (typeof segment === 'number') {
      return `${result}[${segment}]`;
    }

    return result ? `${result}.${segment}` : segment;
  }, '');
}

function normalizeZodIssues(zodIssues: ZodIssue[]): ConfigValidationIssue[] {
  return zodIssues.map((issue) => ({
    path: formatIssuePath(issue.path),
    message: issue.message,
  }));
}

export function validateConfig(rawConfig: unknown): ConfigValidationResult {
  const parsed = serverConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    return {
      success: false,
      issues: normalizeZodIssues(parsed.error.issues),
    };
  }

  const issues = collectValidationIssues(parsed.data as ServerConfig);
  if (issues.length > 0) {
    return {
      success: false,
      issues,
    };
  }

  return {
    success: true,
    config: parsed.data as ServerConfig,
  };
}

export function parseConfig(rawConfig: unknown): ServerConfig {
  const result = validateConfig(rawConfig);
  if (!result.success) {
    throw new ConfigValidationError(result.issues);
  }

  return result.config;
}

export async function loadConfigFromFile(configPath: string): Promise<ServerConfig> {
  const configText = await readFile(configPath, 'utf8');
  return parseConfig(yaml.load(configText));
}

export const loadConfig = loadConfigFromFile;
