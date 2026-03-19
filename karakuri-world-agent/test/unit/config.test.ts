import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildInstructions, loadConfig } from '../../src/config.js';

const tempDirs: string[] = [];

async function createAgentDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'karakuri-world-agent-config-'));
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

describe('config helpers', () => {
  it('loads personality and callable skill metadata from the agent directory', async () => {
    const agentDir = await createAgentDir({
      'personality.md': '# Explorer\nYou are curious.',
      'skills/karakuri-world/SKILL.md': [
        '---',
        'name: karakuri-world',
        'description: Operate inside Karakuri World through the karakuri-world tool.',
        '---',
        '',
        '# World Guide',
        '',
        'Use tools carefully.',
      ].join('\n'),
    });
    const dataDir = await createAgentDir();

    const loaded = loadConfig({
      AGENT_DIR: agentDir,
      DATA_DIR: dataDir,
      DISCORD_TOKEN: 'discord-token',
      DISCORD_PUBLIC_KEY: 'a'.repeat(64),
      DISCORD_APPLICATION_ID: 'application-id',
      OPENAI_API_KEY: 'openai-token',
      KARAKURI_API_BASE_URL: 'https://example.com/api/',
      KARAKURI_API_KEY: 'karakuri-token',
    });

    expect(loaded.agent.dir).toBe(resolve(agentDir));
    expect(loaded.agent.personality).toBe('# Explorer\nYou are curious.');
    expect(loaded.agent.skillTools).toEqual([
      {
        toolName: 'load_skill_karakuri_world',
        name: 'karakuri-world',
        description: 'Operate inside Karakuri World through the karakuri-world tool.',
        instructions: '# World Guide\n\nUse tools carefully.',
        allowedTools: undefined,
      },
    ]);
    expect(loaded.dataDir).toBe(resolve(dataDir));
    expect(loaded.agent.botName).toBe('karakuri-agent');
    expect(loaded.openai.model).toBe('gpt-4o');
    expect(loaded.server.port).toBe(3000);
    expect(loaded.karakuri.apiBaseUrl).toBe('https://example.com/api');
  });

  it('falls back to DISCORD_BOT_TOKEN and default prompts when files are missing', async () => {
    const agentDir = await createAgentDir();

    const loaded = loadConfig({
      AGENT_DIR: agentDir,
      DISCORD_BOT_TOKEN: 'discord-bot-token',
      DISCORD_PUBLIC_KEY: 'b'.repeat(64),
      DISCORD_APPLICATION_ID: 'application-id',
      OPENAI_API_KEY: 'openai-token',
      KARAKURI_API_BASE_URL: 'https://example.com/api',
      KARAKURI_API_KEY: 'karakuri-token',
      DISCORD_MENTION_ROLE_IDS: '123, 456 ,,789',
    });

    expect(loaded.discord.token).toBe('discord-bot-token');
    expect(loaded.discord.mentionRoleIds).toEqual(['123', '456', '789']);
    expect(loaded.agent.personality).toBe('You are a helpful agent living in a virtual world.');
    expect(loaded.agent.skillTools).toEqual([]);
  });

  it('builds instructions by appending callable skill hints when present', () => {
    expect(buildInstructions('personality')).toBe('personality');
    expect(buildInstructions('personality', true)).toBe(
      'personality\n\n---\n\nAdditional agent skill guides are available as callable tools. '
      + 'Call them when you need more detailed, world-specific guidance before acting.',
    );
  });

  it('parses PORT when provided', async () => {
    const agentDir = await createAgentDir();

    const loaded = loadConfig({
      AGENT_DIR: agentDir,
      DISCORD_BOT_TOKEN: 'discord-bot-token',
      DISCORD_PUBLIC_KEY: 'b'.repeat(64),
      DISCORD_APPLICATION_ID: 'application-id',
      OPENAI_API_KEY: 'openai-token',
      KARAKURI_API_BASE_URL: 'https://example.com/api',
      KARAKURI_API_KEY: 'karakuri-token',
      PORT: '4312',
    });

    expect(loaded.server.port).toBe(4312);
  });

  it('throws when required environment variables are missing', () => {
    expect(() => loadConfig({})).toThrowError('Missing required environment variable: AGENT_DIR');
  });

  it('throws when PORT is invalid', async () => {
    const agentDir = await createAgentDir();

    expect(() =>
      loadConfig({
        AGENT_DIR: agentDir,
        DISCORD_BOT_TOKEN: 'discord-bot-token',
        DISCORD_PUBLIC_KEY: 'b'.repeat(64),
        DISCORD_APPLICATION_ID: 'application-id',
        OPENAI_API_KEY: 'openai-token',
        KARAKURI_API_BASE_URL: 'https://example.com/api',
        KARAKURI_API_KEY: 'karakuri-token',
        PORT: '0',
      }),
    ).toThrowError('Invalid PORT value: 0');
  });
});
