import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CURRENT_SERVER_EVENTS_VERSION,
  loadServerEvents,
  saveServerEvents,
} from '../../../src/storage/server-events.js';
import type { ServerEvent } from '../../../src/types/server-event.js';

const tempDirs: string[] = [];

function createTempPath(fileName = 'server-events.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'karakuri-world-server-events-'));
  tempDirs.push(dir);
  return join(dir, fileName);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeEvent(overrides: Partial<ServerEvent> = {}): ServerEvent {
  return {
    server_event_id: 'server-event-1',
    description: 'Festival',
    created_at: 100,
    cleared_at: null,
    ...overrides,
  };
}

describe('storage/server-events', () => {
  it('returns an empty list and creates the file when it does not exist', () => {
    const filePath = createTempPath();

    const result = loadServerEvents(filePath);

    expect(result).toEqual([]);
    expect(existsSync(filePath)).toBe(true);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      version: CURRENT_SERVER_EVENTS_VERSION,
      events: [],
    });
  });

  it('persists via a tmp file then renames atomically', () => {
    const filePath = createTempPath();
    const event = makeEvent();

    saveServerEvents(filePath, [event]);

    expect(existsSync(`${filePath}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      version: CURRENT_SERVER_EVENTS_VERSION,
      events: [event],
    });
  });

  it('round-trips active and cleared events through save/load with stable sort', () => {
    const filePath = createTempPath();
    const events: ServerEvent[] = [
      makeEvent({ server_event_id: 'server-event-b', description: 'b', created_at: 200 }),
      makeEvent({ server_event_id: 'server-event-a', description: 'a', created_at: 100, cleared_at: 150 }),
    ];

    saveServerEvents(filePath, events);
    const loaded = loadServerEvents(filePath);

    expect(loaded.map((event) => event.server_event_id)).toEqual([
      'server-event-a',
      'server-event-b',
    ]);
  });

  it('rejects unsupported version numbers', () => {
    const filePath = createTempPath();
    writeFileSync(filePath, JSON.stringify({ version: 99, events: [] }), 'utf8');

    expect(() => loadServerEvents(filePath)).toThrow(/Unsupported server events file version: 99/);
  });

  it('rejects duplicate server_event_id entries', () => {
    const filePath = createTempPath();
    const event = makeEvent();
    writeFileSync(
      filePath,
      JSON.stringify({ version: CURRENT_SERVER_EVENTS_VERSION, events: [event, event] }),
      'utf8',
    );

    expect(() => loadServerEvents(filePath)).toThrow(/Duplicate server_event_id/);
  });

  it('rejects events whose cleared_at precedes created_at', () => {
    const filePath = createTempPath();
    expect(() =>
      saveServerEvents(filePath, [
        makeEvent({ created_at: 200, cleared_at: 100 }),
      ]),
    ).toThrow();
  });

  it('rejects malformed JSON', () => {
    const filePath = createTempPath();
    writeFileSync(filePath, '{ this is not json', 'utf8');

    expect(() => loadServerEvents(filePath)).toThrow();
  });
});
