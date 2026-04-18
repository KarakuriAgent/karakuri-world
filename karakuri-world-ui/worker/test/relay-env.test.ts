import { describe, expect, it } from 'vitest';

import { deriveRelayUrls, parseRelayEnv } from '../src/relay/env.js';
import { restoreRecentServerEvents } from '../src/relay/bridge.js';

describe('relay env parsing', () => {
  it('derives websocket and snapshot URLs from an http base URL', () => {
    const config = parseRelayEnv({
      KW_BASE_URL: 'http://127.0.0.1:3000',
      KW_ADMIN_KEY: 'admin-key',
    });

    expect(config.kwBaseUrl.toString()).toBe('http://127.0.0.1:3000/');
    expect(config.wsUrl.toString()).toBe('ws://127.0.0.1:3000/ws');
    expect(config.snapshotUrl.toString()).toBe('http://127.0.0.1:3000/api/snapshot');
    expect(config.snapshotObjectKey).toBe('snapshot/latest.json');
    expect(config.snapshotPublishIntervalMs).toBe(5_000);
    expect(config.snapshotHeartbeatIntervalMs).toBe(30_000);
    expect(config.snapshotCacheMaxAgeSec).toBe(5);
    expect(config.authMode).toBe('public');
    expect(config.historyRetentionDays).toBe(180);
  });

  it('derives a secure websocket URL from an https base URL', () => {
    expect(deriveRelayUrls('https://kw.example.com')).toMatchObject({
      wsUrl: new URL('wss://kw.example.com/ws'),
      snapshotUrl: new URL('https://kw.example.com/api/snapshot'),
    });
  });

  it('rejects base URLs with path, query, or fragment components', () => {
    expect(() =>
      parseRelayEnv({
        KW_BASE_URL: 'https://kw.example.com/world',
        KW_ADMIN_KEY: 'admin-key',
      }),
    ).toThrow(/path, query, or fragment/);

    expect(() =>
      parseRelayEnv({
        KW_BASE_URL: 'https://kw.example.com?foo=bar',
        KW_ADMIN_KEY: 'admin-key',
      }),
    ).toThrow(/path, query, or fragment/);

    expect(() =>
      parseRelayEnv({
        KW_BASE_URL: 'https://kw.example.com#frag',
        KW_ADMIN_KEY: 'admin-key',
      }),
    ).toThrow(/path, query, or fragment/);
  });
});

describe('cold-start recent server event restore', () => {
  it('queries the latest logical server events in descending order', async () => {
    let issuedQuery = '';

    const restored = await restoreRecentServerEvents({
      prepare: (query) => {
        issuedQuery = query;

        return {
          all: async () => ({
            results: [
              {
                server_event_id: 'event-3',
                description: 'Third',
                occurred_at: '300',
              },
              {
                server_event_id: 'event-2',
                description: 'Second',
                occurred_at: '200',
              },
              {
                server_event_id: 'event-1',
                description: 'First',
                occurred_at: '100',
              },
            ],
          }),
        };
      },
    });

    expect(issuedQuery).toContain('FROM server_event_instances');
    expect(issuedQuery).toContain('ORDER BY first_occurred_at DESC, server_event_id DESC');
    expect(issuedQuery).toContain('LIMIT 3');
    expect(restored).toEqual([
      {
        server_event_id: 'event-3',
        description: 'Third',
        occurred_at: 300,
        is_active: false,
      },
      {
        server_event_id: 'event-2',
        description: 'Second',
        occurred_at: 200,
        is_active: false,
      },
      {
        server_event_id: 'event-1',
        description: 'First',
        occurred_at: 100,
        is_active: false,
      },
    ]);
  });

  it('returns an empty list when the history schema is not initialized yet', async () => {
    await expect(
      restoreRecentServerEvents({
        prepare: () => ({
          all: async () => {
            throw new Error('D1_ERROR: no such table: server_event_instances: SQLITE_ERROR');
          },
        }),
      }),
    ).resolves.toEqual([]);
  });
});
