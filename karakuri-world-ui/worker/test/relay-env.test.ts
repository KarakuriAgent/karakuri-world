import { describe, expect, it } from 'vitest';

import { deriveRelayUrls, parseRelayEnv } from '../src/relay/env.js';

describe('relay env parsing', () => {
  it('derives snapshot URLs from an http base URL', () => {
    const config = parseRelayEnv({
      KW_BASE_URL: 'http://127.0.0.1:3000',
      KW_ADMIN_KEY: 'admin-key',
    });

    expect(config.kwBaseUrl.toString()).toBe('http://127.0.0.1:3000/');
    expect(config.snapshotUrl.toString()).toBe('http://127.0.0.1:3000/api/snapshot');
    expect(config.snapshotObjectKey).toBe('snapshot/latest.json');
    expect(config.snapshotCacheMaxAgeSec).toBe(5);
    expect(config.authMode).toBe('public');
  });

  it('accepts a non-empty snapshot publish auth key', () => {
    const config = parseRelayEnv({
      KW_BASE_URL: 'http://127.0.0.1:3000',
      KW_ADMIN_KEY: 'admin-key',
      SNAPSHOT_PUBLISH_AUTH_KEY: 'publish-key',
    });

    expect(config.snapshotPublishAuthKey).toBe('publish-key');
  });

  it('derives a snapshot URL from an https base URL', () => {
    expect(deriveRelayUrls('https://kw.example.com')).toMatchObject({
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

  it('rejects a blank snapshot publish auth key when provided', () => {
    expect(() =>
      parseRelayEnv({
        KW_BASE_URL: 'https://kw.example.com',
        KW_ADMIN_KEY: 'admin-key',
        SNAPSHOT_PUBLISH_AUTH_KEY: '   ',
      }),
    ).toThrow('SNAPSHOT_PUBLISH_AUTH_KEY is required');
  });
});
