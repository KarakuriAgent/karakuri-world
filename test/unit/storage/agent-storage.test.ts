import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CURRENT_VERSION, loadAgents, saveAgents } from '../../../src/storage/agent-storage.js';
import type { AgentRegistration } from '../../../src/types/agent.js';

function createRegistration(overrides: Partial<AgentRegistration> = {}): AgentRegistration {
  return {
    agent_id: 'agent-1',
    agent_name: 'alice',
    api_key: 'karakuri_deadbeef',
    discord_bot_id: 'bot-alice',
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
