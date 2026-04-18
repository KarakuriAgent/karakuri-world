import { describe, expect, it } from 'vitest';

import { readEnv } from '../env-contract.js';

describe('spectator UI env contract', () => {
  it('reads the required Vite variables with typed auth mode', () => {
    expect(
      readEnv({
        VITE_SNAPSHOT_URL: 'https://snapshot.example.com/snapshot/latest.json',
        VITE_AUTH_MODE: 'access',
        VITE_API_BASE_URL: 'https://relay.example.com/api/history',
        VITE_PHASE3_EFFECTS_ENABLED: 'true',
        VITE_PHASE3_EFFECT_RAIN_ENABLED: 'true',
        VITE_PHASE3_EFFECT_SNOW_ENABLED: 'false',
        VITE_PHASE3_EFFECT_FOG_ENABLED: 'true',
        VITE_PHASE3_EFFECT_DAY_NIGHT_ENABLED: 'true',
        VITE_PHASE3_EFFECT_MOTION_ENABLED: 'true',
        VITE_PHASE3_EFFECT_ACTION_PARTICLES_ENABLED: 'true',
      }),
    ).toEqual({
      snapshotUrl: 'https://snapshot.example.com/snapshot/latest.json',
      authMode: 'access',
      apiBaseUrl: 'https://relay.example.com/api/history',
      phase3EffectsEnabled: true,
      phase3EnvironmentEffects: {
        rain: true,
        snow: false,
        fog: true,
        dayNight: true,
      },
      phase3MotionEffects: {
        motion: true,
        actionParticles: true,
      },
    });
  });

  it('defaults the Phase 3 effects flag off when omitted', () => {
    expect(
      readEnv({
        VITE_SNAPSHOT_URL: 'https://snapshot.example.com/snapshot/latest.json',
        VITE_AUTH_MODE: 'public',
        VITE_API_BASE_URL: 'https://relay.example.com/api/history',
      }),
    ).toEqual({
      snapshotUrl: 'https://snapshot.example.com/snapshot/latest.json',
      authMode: 'public',
      apiBaseUrl: 'https://relay.example.com/api/history',
      phase3EffectsEnabled: false,
      phase3EnvironmentEffects: {
        rain: false,
        snow: false,
        fog: false,
        dayNight: false,
      },
      phase3MotionEffects: {
        motion: false,
        actionParticles: false,
      },
    });
  });

  it('keeps individual environment flags rolled back unless the Phase 3 master flag is enabled', () => {
    expect(
      readEnv({
        VITE_SNAPSHOT_URL: 'https://snapshot.example.com/snapshot/latest.json',
        VITE_AUTH_MODE: 'public',
        VITE_API_BASE_URL: 'https://relay.example.com/api/history',
        VITE_PHASE3_EFFECT_RAIN_ENABLED: 'true',
        VITE_PHASE3_EFFECT_DAY_NIGHT_ENABLED: 'true',
        VITE_PHASE3_EFFECT_MOTION_ENABLED: 'true',
        VITE_PHASE3_EFFECT_ACTION_PARTICLES_ENABLED: 'true',
      }),
    ).toEqual({
      snapshotUrl: 'https://snapshot.example.com/snapshot/latest.json',
      authMode: 'public',
      apiBaseUrl: 'https://relay.example.com/api/history',
      phase3EffectsEnabled: false,
      phase3EnvironmentEffects: {
        rain: false,
        snow: false,
        fog: false,
        dayNight: false,
      },
      phase3MotionEffects: {
        motion: false,
        actionParticles: false,
      },
    });
  });

  it('throws when required variables are missing', () => {
    expect(() =>
      readEnv({
        VITE_SNAPSHOT_URL: '',
        VITE_AUTH_MODE: 'public',
        VITE_API_BASE_URL: undefined,
      }),
    ).toThrow(/VITE_SNAPSHOT_URL/);
  });

  it('throws when variables are present but malformed', () => {
    expect(() =>
      readEnv({
        VITE_SNAPSHOT_URL: 'not-a-url',
        VITE_AUTH_MODE: 'private',
        VITE_API_BASE_URL: 'also-not-a-url',
        VITE_PHASE3_EFFECTS_ENABLED: 'maybe',
        VITE_PHASE3_EFFECT_RAIN_ENABLED: 'sometimes',
        VITE_PHASE3_EFFECT_MOTION_ENABLED: 'later',
      } as Record<string, string | undefined>),
    ).toThrow(
      /VITE_SNAPSHOT_URL|VITE_AUTH_MODE|VITE_API_BASE_URL|VITE_PHASE3_EFFECTS_ENABLED|VITE_PHASE3_EFFECT_RAIN_ENABLED|VITE_PHASE3_EFFECT_MOTION_ENABLED/,
    );
  });

  it('formats malformed URL errors without crashing safeParse', () => {
    const readMalformedEnv = () =>
      readEnv({
        VITE_SNAPSHOT_URL: 'not-a-url',
        VITE_AUTH_MODE: 'public',
        VITE_API_BASE_URL: 'https://relay.example.com/api/history',
      });

    expect(readMalformedEnv).toThrow(/Invalid spectator UI environment:/);
    expect(readMalformedEnv).toThrow(/VITE_SNAPSHOT_URL/);
  });

  it('throws when VITE_API_BASE_URL does not point to the Worker history endpoint', () => {
    expect(() =>
      readEnv({
        VITE_SNAPSHOT_URL: 'https://snapshot.example.com/snapshot/latest.json',
        VITE_AUTH_MODE: 'public',
        VITE_API_BASE_URL: 'https://relay.example.com/api',
      }),
    ).toThrow(/VITE_API_BASE_URL: must point to the Worker \/api\/history endpoint/);
  });

  it('throws when VITE_API_BASE_URL includes query parameters or fragments', () => {
    expect(() =>
      readEnv({
        VITE_SNAPSHOT_URL: 'https://snapshot.example.com/snapshot/latest.json',
        VITE_AUTH_MODE: 'public',
        VITE_API_BASE_URL: 'https://relay.example.com/api/history?agent_id=alice#latest',
      }),
    ).toThrow(/VITE_API_BASE_URL: must not include query parameters or fragments/);
  });

  it('throws when browser-exposed URLs include embedded credentials', () => {
    expect(() =>
      readEnv({
        VITE_SNAPSHOT_URL: 'https://token:s3cr3t@snapshot.example.com/snapshot/latest.json',
        VITE_AUTH_MODE: 'public',
        VITE_API_BASE_URL: 'https://relay.example.com/api/history',
      }),
    ).toThrow(/VITE_SNAPSHOT_URL: must not include embedded credentials/);

    expect(() =>
      readEnv({
        VITE_SNAPSHOT_URL: 'https://snapshot.example.com/snapshot/latest.json',
        VITE_AUTH_MODE: 'public',
        VITE_API_BASE_URL: 'https://token:s3cr3t@relay.example.com/api/history',
      }),
    ).toThrow(/VITE_API_BASE_URL: must not include embedded credentials/);
  });

  it('throws when VITE_SNAPSHOT_URL includes query parameters or fragments', () => {
    expect(() =>
      readEnv({
        VITE_SNAPSHOT_URL: 'https://snapshot.example.com/snapshot/latest.json?token=s3cr3t#current',
        VITE_AUTH_MODE: 'public',
        VITE_API_BASE_URL: 'https://relay.example.com/api/history',
      }),
    ).toThrow(/VITE_SNAPSHOT_URL: must not include query parameters or fragments/);
  });

  it('throws when VITE_SNAPSHOT_URL points to same-origin /api/snapshot instead of the direct snapshot object', () => {
    expect(() =>
      readEnv({
        VITE_SNAPSHOT_URL: 'https://relay.example.com/api/snapshot',
        VITE_AUTH_MODE: 'public',
        VITE_API_BASE_URL: 'https://relay.example.com/api/history',
      }),
    ).toThrow(/VITE_SNAPSHOT_URL: must point to the direct snapshot object URL, not the same-origin \/api\/snapshot admin endpoint/);
  });

  it('allows direct snapshot object URLs whose object key happens to be api/snapshot on a different origin', () => {
    expect(
      readEnv({
        VITE_SNAPSHOT_URL: 'https://snapshot.example.com/api/snapshot',
        VITE_AUTH_MODE: 'public',
        VITE_API_BASE_URL: 'https://relay.example.com/api/history',
      }),
    ).toEqual({
      snapshotUrl: 'https://snapshot.example.com/api/snapshot',
      authMode: 'public',
      apiBaseUrl: 'https://relay.example.com/api/history',
      phase3EffectsEnabled: false,
      phase3EnvironmentEffects: {
        rain: false,
        snow: false,
        fog: false,
        dayNight: false,
      },
      phase3MotionEffects: {
        motion: false,
        actionParticles: false,
      },
    });
  });
});
