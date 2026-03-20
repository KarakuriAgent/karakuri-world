import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CURRENT_VERSION, loadAgents, saveAgents } from '../../../src/storage/agent-storage.js';
import type { AgentRegistration } from '../../../src/types/agent.js';

function createRegistration(overrides: Partial<AgentRegistration> = {}): AgentRegistration {
  const agentName = overrides.agent_name ?? 'alice';
  const discordBotId = overrides.discord_bot_id ?? `bot-${agentName}`;
  return {
    agent_id: 'agent-1',
    agent_name: agentName,
    agent_label: overrides.agent_label ?? agentName,
    api_key: 'karakuri_deadbeef',
    discord_bot_id: discordBotId,
    created_at: 1,
    ...overrides,
  };
}

const tempDirs: string[] = [];

function createTempPath(...segments: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'karakuri-world-storage-'));
  tempDirs.push(dir);
  return join(dir, ...segments);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('agent storage', () => {
  it('creates an initial agents file when none exists', () => {
    const filePath = createTempPath('nested', 'agents.json');

    expect(loadAgents(filePath)).toEqual([]);
    expect(existsSync(filePath)).toBe(true);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      version: CURRENT_VERSION,
      agents: [],
    });
  });

  it('loads existing registrations from disk', () => {
    const filePath = createTempPath('agents.json');
    const alice = createRegistration();

    saveAgents(filePath, [alice]);

    expect(loadAgents(filePath)).toEqual([alice]);
  });

  it('rejects unsupported file versions', () => {
    const filePath = createTempPath('agents.json');

    writeFileSync(
      filePath,
      JSON.stringify({
        version: CURRENT_VERSION + 1,
        agents: [],
      }),
      'utf8',
    );

    expect(() => loadAgents(filePath)).toThrowError(`Unsupported agents file version: ${CURRENT_VERSION + 1}`);
  });

  it('rejects invalid persisted registrations', () => {
    const filePath = createTempPath('agents.json');

    writeFileSync(
      filePath,
      JSON.stringify({
        version: CURRENT_VERSION,
        agents: [createRegistration({ api_key: 'invalid-key' })],
      }),
      'utf8',
    );

    expect(() => loadAgents(filePath)).toThrowError();
  });

  it('rejects duplicate unique fields', () => {
    const filePath = createTempPath('agents.json');

    writeFileSync(
      filePath,
      JSON.stringify({
        version: CURRENT_VERSION,
        agents: [
          createRegistration(),
          createRegistration({
            agent_id: 'agent-2',
            api_key: 'karakuri_feedface',
          }),
        ],
      }),
      'utf8',
    );

    expect(() => loadAgents(filePath)).toThrowError('Duplicate agent_name: alice');
  });

  it('persists and loads optional discord_channel_id and last_node_id', () => {
    const filePath = createTempPath('agents.json');
    const alice = createRegistration({ discord_channel_id: 'ch-123', last_node_id: '3-1' });

    saveAgents(filePath, [alice]);

    const loaded = loadAgents(filePath);
    expect(loaded[0].discord_channel_id).toBe('ch-123');
    expect(loaded[0].last_node_id).toBe('3-1');
  });

  it('migrates v1 data to v2 automatically', () => {
    const filePath = createTempPath('agents.json');

    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        agents: [
          {
            agent_id: 'agent-1',
            agent_name: 'alice',
            api_key: 'karakuri_deadbeef',
            discord_bot_id: 'bot-alice',
            created_at: 1,
          },
        ],
      }),
      'utf8',
    );

    const loaded = loadAgents(filePath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].agent_label).toBe('alice');
    expect(loaded[0].discord_channel_id).toBeUndefined();
    expect(loaded[0].last_node_id).toBeUndefined();

    const persisted = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(persisted.version).toBe(CURRENT_VERSION);
    expect(persisted.agents[0].agent_label).toBe('alice');
  });

  it('writes sorted JSON without leaving a tmp file behind', () => {
    const filePath = createTempPath('agents.json');
    const bob = createRegistration({
      agent_id: 'agent-2',
      agent_name: 'bob',
      api_key: 'karakuri_feedface',
      created_at: 2,
    });
    const alice = createRegistration();

    saveAgents(filePath, [bob, alice]);

    expect(existsSync(`${filePath}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      version: CURRENT_VERSION,
      agents: [alice, bob],
    });
  });
});
