import type { ToolExecutionOptions } from '@ai-sdk/provider-utils';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createSkillTools, loadAgentSkills, parseSkillDocument } from '../../src/skills.js';

const tempDirs: string[] = [];
const permissionSensitiveIt = process.platform === 'win32'
  || (typeof process.getuid === 'function' && process.getuid() === 0)
  ? it.skip
  : it;

async function createAgentDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'karakuri-world-agent-skills-'));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });

  await Promise.all(
    Object.entries(files).map(async ([name, contents]) => {
      const filePath = join(dir, name);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, contents, 'utf8');
    }),
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
        'description: Operate inside Karakuri World through the karakuri-world tool.',
        'allowed-tools: karakuri-world',
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
      description: 'Operate inside Karakuri World through the karakuri-world tool.',
      allowedTools: 'karakuri-world',
      instructions: '# World Guide\n\nUse tools carefully.',
    });
  });

  it('falls back to the skill directory name when SKILL.md only has a generic heading', async () => {
    const agentDir = await createAgentDir({
      'skills/karakuri-world/SKILL.md': '# Skills\n\n- Explore unfamiliar places and describe them clearly.\n',
    });

    const loaded = loadAgentSkills(agentDir);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].toolName).toBe('load_skill_karakuri_world');
    expect(loaded[0]).toMatchObject({
      name: 'karakuri-world',
      description: 'Explore unfamiliar places and describe them clearly.',
      instructions: '# Skills\n\n- Explore unfamiliar places and describe them clearly.',
    });
  });

  it('ignores a legacy SKILL.md in the agent root when skills/ is missing', async () => {
    const agentDir = await createAgentDir({
      'SKILL.md': '# Skills\n- Legacy inline prompt',
    });

    const loaded = loadAgentSkills(agentDir);

    expect(loaded).toEqual([]);
  });

  it('ignores a non-directory skills path', async () => {
    const agentDir = await createAgentDir({
      skills: 'not a directory',
    });

    const loaded = loadAgentSkills(agentDir);

    expect(loaded).toEqual([]);
  });

  permissionSensitiveIt('surfaces unreadable skills directories instead of treating them as missing', async () => {
    const agentDir = await createAgentDir();
    const skillsDir = join(agentDir, 'skills');

    await mkdir(skillsDir, { recursive: true });
    await chmod(skillsDir, 0o000);

    try {
      expect(() => loadAgentSkills(agentDir)).toThrowError(/Failed to read skills directory at .*\/skills:/);
    } finally {
      await chmod(skillsDir, 0o755);
    }
  });

  it('loads multiple nested skills in alphabetical order and skips directories without SKILL.md', async () => {
    const agentDir = await createAgentDir({
      'skills/beta/SKILL.md': [
        '---',
        'name: Zebra',
        '---',
        '',
        '# World Guide',
        '',
        'Beta instructions.',
      ].join('\n'),
      'skills/alpha/SKILL.md': [
        '---',
        'name: Yak',
        '---',
        '',
        '# World Guide',
        '',
        'Alpha instructions.',
      ].join('\n'),
      'skills/gamma/SKILL.md': '# Skills\n\n- Gamma instructions.\n',
      'skills/without-skill/notes.md': 'This directory should be ignored.',
    });

    const loaded = loadAgentSkills(agentDir);

    expect(loaded).toHaveLength(3);
    expect(loaded.map((skill) => skill.name)).toEqual(['Yak', 'Zebra', 'gamma']);
    expect(loaded.map((skill) => skill.toolName)).toEqual([
      'load_skill_yak',
      'load_skill_zebra',
      'load_skill_gamma',
    ]);
  });

  it('throws when multiple skill directories resolve to the same tool name', async () => {
    const agentDir = await createAgentDir({
      'skills/alpha/SKILL.md': [
        '---',
        'name: duplicate skill',
        '---',
        '',
        '# Guide',
        '',
        'Alpha instructions.',
      ].join('\n'),
      'skills/beta/SKILL.md': [
        '---',
        'name: duplicate-skill',
        '---',
        '',
        '# Guide',
        '',
        'Beta instructions.',
      ].join('\n'),
    });

    expect(() => loadAgentSkills(agentDir)).toThrowError('Duplicate skill tool name: load_skill_duplicate_skill');
  });

  it('surfaces invalid SKILL.md filesystem entries with path context', async () => {
    const agentDir = await createAgentDir({
      'skills/karakuri-world/SKILL.md/note.txt': 'not a markdown file',
    });

    expect(() => loadAgentSkills(agentDir)).toThrowError(
      /Failed to read skill file at .*\/skills\/karakuri-world\/SKILL\.md:/,
    );
  });

  it('returns the skill body when the callable skill tool is executed', async () => {
    const tools = createSkillTools([
      {
        toolName: 'load_skill_karakuri_world',
        name: 'karakuri-world',
        description: 'Operate inside Karakuri World through the karakuri-world tool.',
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
      description: 'Operate inside Karakuri World through the karakuri-world tool.',
      allowedTools: undefined,
      instructions: '# World Guide\n\nUse tools carefully.',
    });
  });
});
