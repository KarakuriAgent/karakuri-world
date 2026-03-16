import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildInstructions, loadConfig } from '../../src/config.js';

const tempDirs: string[] = [];

async function createAgentDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'karakuri-world-agent-config-'));
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

describe('config helpers', () => {
  it('loads personality and skills from the agent directory', async () => {
    const agentDir = await createAgentDir({
      'personality.md': '# Explorer\nYou are curious.',
      'skills.md': '# Skills\n- Fishing',
    });
    const dataDir = await createAgentDir();

    const loaded = loadConfig({
      AGENT_DIR: agentDir,
      DATA_DIR: dataDir,
      DISCORD_TOKEN: 'discord-token',
      DISCORD_PUBLIC_KEY: 'a'.repeat(64),
      DISCORD_APPLICATION_ID: 'application-id',
      OPENAI_API_KEY: 'openai-token',
      KARAKURI_MCP_URL: 'https://example.com/mcp',
      KARAKURI_API_KEY: 'karakuri-token',
    });

    expect(loaded.agent.dir).toBe(resolve(agentDir));
    expect(loaded.agent.personality).toBe('# Explorer\nYou are curious.');
    expect(loaded.agent.skills).toBe('# Skills\n- Fishing');
    expect(loaded.dataDir).toBe(resolve(dataDir));
    expect(loaded.agent.botName).toBe('karakuri-agent');
    expect(loaded.openai.model).toBe('gpt-4o');
    expect(loaded.server.port).toBe(3000);
  });

  it('falls back to DISCORD_BOT_TOKEN and default prompts when files are missing', async () => {
    const agentDir = await createAgentDir();

    const loaded = loadConfig({
      AGENT_DIR: agentDir,
      DISCORD_BOT_TOKEN: 'discord-bot-token',
      DISCORD_PUBLIC_KEY: 'b'.repeat(64),
      DISCORD_APPLICATION_ID: 'application-id',
      OPENAI_API_KEY: 'openai-token',
      KARAKURI_MCP_URL: 'https://example.com/mcp',
      KARAKURI_API_KEY: 'karakuri-token',
      DISCORD_MENTION_ROLE_IDS: '123, 456 ,,789',
    });

    expect(loaded.discord.token).toBe('discord-bot-token');
    expect(loaded.discord.mentionRoleIds).toEqual(['123', '456', '789']);
    expect(loaded.agent.personality).toBe('You are a helpful agent living in a virtual world.');
    expect(loaded.agent.skills).toBe('');
  });

  it('builds instructions by appending skills only when present', () => {
    expect(buildInstructions('personality', 'skills')).toBe('personality\n\n---\n\nskills');
    expect(buildInstructions('personality', '')).toBe('personality');
  });

  it('parses PORT when provided', async () => {
    const agentDir = await createAgentDir();

    const loaded = loadConfig({
      AGENT_DIR: agentDir,
      DISCORD_BOT_TOKEN: 'discord-bot-token',
      DISCORD_PUBLIC_KEY: 'b'.repeat(64),
      DISCORD_APPLICATION_ID: 'application-id',
      OPENAI_API_KEY: 'openai-token',
      KARAKURI_MCP_URL: 'https://example.com/mcp',
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
        KARAKURI_MCP_URL: 'https://example.com/mcp',
        KARAKURI_API_KEY: 'karakuri-token',
        PORT: '0',
      }),
    ).toThrowError('Invalid PORT value: 0');
  });
});
