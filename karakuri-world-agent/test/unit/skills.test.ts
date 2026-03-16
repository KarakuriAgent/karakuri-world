import type { ToolExecutionOptions } from '@ai-sdk/provider-utils';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createSkillTools, loadAgentSkills, parseSkillDocument } from '../../src/skills.js';

const tempDirs: string[] = [];

async function createAgentDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'karakuri-world-agent-skills-'));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });

  await Promise.all(
    Object.entries(files).map(([name, contents]) => writeFile(join(dir, name), contents, 'utf8')),
  );

  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('skill loading', () => {
  it('parses skill metadata from SKILL.md front matter', () => {
    const parsed = parseSkillDocument(
      [
        '---',
        'name: karakuri-world',
        'description: Operate inside Karakuri World through MCP tools.',
        'allowed-tools: move, action',
        '---',
        '',
        '# World Guide',
        '',
        'Use tools carefully.',
      ].join('\n'),
      'fallback-skill',
    );

    expect(parsed).toEqual({
      name: 'karakuri-world',
      description: 'Operate inside Karakuri World through MCP tools.',
      allowedTools: 'move, action',
      instructions: '# World Guide\n\nUse tools carefully.',
    });
  });

  it('falls back to the agent directory name when SKILL.md only has a generic heading', async () => {
    const agentDir = await createAgentDir({
      'SKILL.md': '# Skills\n\n- Explore unfamiliar places and describe them clearly.\n',
    });

    const loaded = loadAgentSkills(agentDir);
    const agentName = basename(agentDir);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].toolName).toBe(`load_skill_${agentName.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`);
    expect(loaded[0]).toMatchObject({
      name: agentName,
      description: 'Explore unfamiliar places and describe them clearly.',
      instructions: '# Skills\n\n- Explore unfamiliar places and describe them clearly.',
    });
  });

  it('ignores legacy skills.md when SKILL.md is missing', async () => {
    const agentDir = await createAgentDir({
      'skills.md': '# Skills\n- Legacy inline prompt',
    });

    const loaded = loadAgentSkills(agentDir);

    expect(loaded).toEqual([]);
  });

  it('returns the skill body when the callable skill tool is executed', async () => {
    const tools = createSkillTools([
      {
        toolName: 'load_skill_karakuri_world',
        name: 'karakuri-world',
        description: 'Operate inside Karakuri World through MCP tools.',
        instructions: '# World Guide\n\nUse tools carefully.',
      },
    ]);
    const execute = tools.load_skill_karakuri_world.execute;
    const options: ToolExecutionOptions = {
      toolCallId: 'tool-1',
      messages: [],
    };

    expect(execute).toBeDefined();

    if (!execute) {
      throw new Error('Missing skill tool execute handler.');
    }

    const result = await execute({}, options);

    expect(result).toEqual({
      name: 'karakuri-world',
      description: 'Operate inside Karakuri World through MCP tools.',
      allowedTools: undefined,
      instructions: '# World Guide\n\nUse tools carefully.',
    });
  });
});
