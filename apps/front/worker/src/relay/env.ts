import { z } from 'zod';

export type RelayAuthMode = 'public' | 'access';

export interface RelayConfig {
  snapshotPublishAuthKey?: string;
  snapshotObjectKey: string;
  snapshotCacheMaxAgeSec: number;
  authMode: RelayAuthMode;
}

const DEFAULT_SNAPSHOT_OBJECT_KEY = 'snapshot/latest.json';
const DEFAULT_SNAPSHOT_CACHE_MAX_AGE_SEC = 5;

const authModeSchema = z.enum(['public', 'access']);

function parseAuthMode(value: unknown): RelayAuthMode {
  const authModeResult = authModeSchema.safeParse(value ?? 'public');

  if (!authModeResult.success) {
    throw new Error('AUTH_MODE must be public or access');
  }

  return authModeResult.data;
}

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }

  return value;
}

function parsePositiveInteger(value: unknown, fieldName: string, defaultValue: number): number {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return parsed;
}

export function parseRelayEnv(env: Record<string, unknown>): RelayConfig {
  const authMode = parseAuthMode(env.AUTH_MODE);
  const snapshotPublishAuthKey =
    env.SNAPSHOT_PUBLISH_AUTH_KEY === undefined
      ? undefined
      : parseRequiredString(env.SNAPSHOT_PUBLISH_AUTH_KEY, 'SNAPSHOT_PUBLISH_AUTH_KEY');

  return {
    ...(snapshotPublishAuthKey ? { snapshotPublishAuthKey } : {}),
    snapshotObjectKey:
      env.SNAPSHOT_OBJECT_KEY === undefined
        ? DEFAULT_SNAPSHOT_OBJECT_KEY
        : parseRequiredString(env.SNAPSHOT_OBJECT_KEY, 'SNAPSHOT_OBJECT_KEY'),
    snapshotCacheMaxAgeSec: parsePositiveInteger(
      env.SNAPSHOT_CACHE_MAX_AGE_SEC,
      'SNAPSHOT_CACHE_MAX_AGE_SEC',
      DEFAULT_SNAPSHOT_CACHE_MAX_AGE_SEC,
    ),
    authMode,
  };
}
