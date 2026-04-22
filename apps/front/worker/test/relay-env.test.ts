import { describe, expect, it } from 'vitest';

import { parseRelayEnv } from '../src/relay/env.js';

describe('relay env parsing', () => {
  it('defaults snapshot object key and cache max-age when only minimal env is provided', () => {
    const config = parseRelayEnv({});

    expect(config.snapshotObjectKey).toBe('snapshot/latest.json');
    expect(config.snapshotCacheMaxAgeSec).toBe(5);
    expect(config.authMode).toBe('public');
    expect(config.snapshotPublishAuthKey).toBeUndefined();
  });

  it('accepts a non-empty snapshot publish auth key', () => {
    const config = parseRelayEnv({
      SNAPSHOT_PUBLISH_AUTH_KEY: 'publish-key',
    });

    expect(config.snapshotPublishAuthKey).toBe('publish-key');
  });

  it('rejects a blank snapshot publish auth key when provided', () => {
    expect(() =>
      parseRelayEnv({
        SNAPSHOT_PUBLISH_AUTH_KEY: '   ',
      }),
    ).toThrow('SNAPSHOT_PUBLISH_AUTH_KEY is required');
  });

  it('honors explicit snapshot object key and cache max-age overrides', () => {
    const config = parseRelayEnv({
      SNAPSHOT_OBJECT_KEY: 'custom/key.json',
      SNAPSHOT_CACHE_MAX_AGE_SEC: '30',
    });

    expect(config.snapshotObjectKey).toBe('custom/key.json');
    expect(config.snapshotCacheMaxAgeSec).toBe(30);
  });

  it('rejects an invalid snapshot cache max-age', () => {
    expect(() => parseRelayEnv({ SNAPSHOT_CACHE_MAX_AGE_SEC: '0' })).toThrow(
      /SNAPSHOT_CACHE_MAX_AGE_SEC/,
    );
  });
});
