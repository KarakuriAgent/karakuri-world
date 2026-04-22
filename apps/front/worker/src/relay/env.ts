import { z } from 'zod';

export type RelayAuthMode = 'public' | 'access';

export interface RelayConfig {
  snapshotPublishAuthKey?: string;
  snapshotObjectKey: string;
  snapshotCacheMaxAgeSec: number;
  authMode: RelayAuthMode;
}

export interface HistoryCorsConfig {
  authMode: RelayAuthMode;
  allowedOrigins: string[];
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

function normalizeCorsOrigin(origin: string): string {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(origin);
  } catch {
    throw new Error('HISTORY_CORS_ALLOWED_ORIGINS must contain absolute origins');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('HISTORY_CORS_ALLOWED_ORIGINS must use http or https');
  }

  if (parsedUrl.origin !== origin || parsedUrl.pathname !== '/' || parsedUrl.search !== '' || parsedUrl.hash !== '') {
    throw new Error('HISTORY_CORS_ALLOWED_ORIGINS entries must be bare origins without path, query, or fragment');
  }

  return parsedUrl.origin;
}

function coerceCorsOrigin(origin: string): string | undefined {
  try {
    const parsedUrl = new URL(origin);

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return undefined;
    }

    return parsedUrl.origin;
  } catch {
    return undefined;
  }
}

export function parseHistoryCorsConfig(env: Record<string, unknown>): HistoryCorsConfig {
  const allowedOriginsRaw = env.HISTORY_CORS_ALLOWED_ORIGINS;

  if (allowedOriginsRaw !== undefined && typeof allowedOriginsRaw !== 'string') {
    throw new Error('HISTORY_CORS_ALLOWED_ORIGINS must be a comma-separated string');
  }

  const allowedOrigins = allowedOriginsRaw
    ?.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .map(normalizeCorsOrigin);

  return {
    authMode: parseAuthMode(env.AUTH_MODE),
    allowedOrigins: allowedOrigins ? [...new Set(allowedOrigins)] : [],
  };
}

export function parseHistoryCorsConfigFallback(env: Record<string, unknown>): HistoryCorsConfig {
  const allowedOrigins =
    typeof env.HISTORY_CORS_ALLOWED_ORIGINS === 'string'
      ? [
          ...new Set(
            env.HISTORY_CORS_ALLOWED_ORIGINS.split(',')
              .map((origin) => origin.trim())
              .filter((origin) => origin.length > 0)
              .map((origin) => {
                try {
                  return normalizeCorsOrigin(origin);
                } catch {
                  return coerceCorsOrigin(origin);
                }
              })
              .filter((origin): origin is string => origin !== undefined),
          ),
        ]
      : [];

  return {
    authMode: env.AUTH_MODE === 'access' ? 'access' : 'public',
    allowedOrigins,
  };
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
