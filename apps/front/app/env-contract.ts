import { z } from 'zod';

export const requiredEnvKeys = ['VITE_SNAPSHOT_URL', 'VITE_AUTH_MODE'] as const;

const booleanFlagSchema = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '' ? undefined : normalized;
}, z.enum(['true', 'false']).optional());

function isHttpUrlProtocol(value: string): boolean {
  return value === 'http:' || value === 'https:';
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function rejectSecretBearingUrlParts(value: URL, ctx: z.RefinementCtx): void {
  if (value.username !== '' || value.password !== '') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'must not include embedded credentials',
    });
  }

  if (value.search !== '' || value.hash !== '') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'must not include query parameters or fragments',
    });
  }
}

const publicHttpUrlSchema = z.string().trim().url().superRefine((value, ctx) => {
  const url = parseUrl(value);
  if (!url) {
    return;
  }

  if (!isHttpUrlProtocol(url.protocol)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'must use http or https',
    });
  }

  rejectSecretBearingUrlParts(url, ctx);
});

const SNAPSHOT_ALIAS_PATH = '/snapshot/latest.json';

const snapshotUrlSchema = publicHttpUrlSchema.superRefine((value, ctx) => {
  const url = parseUrl(value);
  if (!url) {
    return;
  }

  if (url.pathname !== SNAPSHOT_ALIAS_PATH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `must point to the public snapshot alias URL (${SNAPSHOT_ALIAS_PATH})`,
    });
  }
});

const runtimeEnvSchema = z.object({
  VITE_SNAPSHOT_URL: snapshotUrlSchema,
  VITE_AUTH_MODE: z.enum(['public', 'access']),
  VITE_PHASE3_EFFECTS_ENABLED: booleanFlagSchema,
  VITE_PHASE3_EFFECT_RAIN_ENABLED: booleanFlagSchema,
  VITE_PHASE3_EFFECT_SNOW_ENABLED: booleanFlagSchema,
  VITE_PHASE3_EFFECT_FOG_ENABLED: booleanFlagSchema,
  VITE_PHASE3_EFFECT_DAY_NIGHT_ENABLED: booleanFlagSchema,
  VITE_PHASE3_EFFECT_MOTION_ENABLED: booleanFlagSchema,
  VITE_PHASE3_EFFECT_ACTION_PARTICLES_ENABLED: booleanFlagSchema,
});

export interface AppEnv {
  snapshotUrl: string;
  authMode: 'public' | 'access';
  phase3EffectsEnabled?: boolean;
  phase3EnvironmentEffects?: {
    rain: boolean;
    snow: boolean;
    fog: boolean;
    dayNight: boolean;
  };
  phase3MotionEffects?: {
    motion: boolean;
    actionParticles: boolean;
  };
}

function formatEnvError(rawEnv: Record<string, string | undefined>, error: z.ZodError): string {
  const missingKeys = requiredEnvKeys.filter((key) => {
    const value = rawEnv[key];
    return value === undefined || value.trim() === '';
  });

  if (missingKeys.length > 0) {
    return `missing ${missingKeys.join(', ')}`;
  }

  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

export function readEnv(rawEnv: Record<string, string | undefined>): AppEnv {
  const parsed = runtimeEnvSchema.safeParse(rawEnv);

  if (!parsed.success) {
    throw new Error(`Invalid spectator UI environment: ${formatEnvError(rawEnv, parsed.error)}`);
  }

  const phase3EffectsEnabled = parsed.data.VITE_PHASE3_EFFECTS_ENABLED === 'true';

  return {
    snapshotUrl: parsed.data.VITE_SNAPSHOT_URL,
    authMode: parsed.data.VITE_AUTH_MODE,
    phase3EffectsEnabled,
    phase3EnvironmentEffects: {
      rain: phase3EffectsEnabled && parsed.data.VITE_PHASE3_EFFECT_RAIN_ENABLED === 'true',
      snow: phase3EffectsEnabled && parsed.data.VITE_PHASE3_EFFECT_SNOW_ENABLED === 'true',
      fog: phase3EffectsEnabled && parsed.data.VITE_PHASE3_EFFECT_FOG_ENABLED === 'true',
      dayNight: phase3EffectsEnabled && parsed.data.VITE_PHASE3_EFFECT_DAY_NIGHT_ENABLED === 'true',
    },
    phase3MotionEffects: {
      motion: phase3EffectsEnabled && parsed.data.VITE_PHASE3_EFFECT_MOTION_ENABLED === 'true',
      actionParticles: phase3EffectsEnabled && parsed.data.VITE_PHASE3_EFFECT_ACTION_PARTICLES_ENABLED === 'true',
    },
  };
}

export function validateEnv(rawEnv: Record<string, string | undefined>): void {
  readEnv(rawEnv);
}
