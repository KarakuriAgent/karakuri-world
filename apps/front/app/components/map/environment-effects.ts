import type { SpectatorSnapshot } from '../../../worker/src/contracts/spectator-snapshot.js';

export interface Phase3EnvironmentEffectFlags {
  rain: boolean;
  snow: boolean;
  fog: boolean;
  dayNight: boolean;
}

export interface EnvironmentEffectDimensions {
  worldWidth: number;
  worldHeight: number;
  cellSize: number;
}

export interface RainParticleModel {
  x: number;
  y: number;
  dx: number;
  dy: number;
  alpha: number;
  width: number;
}

export interface SnowParticleModel {
  x: number;
  y: number;
  radius: number;
  alpha: number;
}

export interface FogBandModel {
  x: number;
  y: number;
  width: number;
  height: number;
  alpha: number;
}

export interface DayNightOverlayModel {
  phase: 'dawn' | 'dusk' | 'night';
  color: string;
  alpha: number;
}

export interface EnvironmentEffectsModel {
  dimensions: EnvironmentEffectDimensions;
  precipitation?:
    | {
        kind: 'rain';
        color: string;
        particles: RainParticleModel[];
      }
    | {
        kind: 'snow';
        color: string;
        particles: SnowParticleModel[];
      };
  fog?: {
    color: string;
    bands: FogBandModel[];
  };
  dayNight?: DayNightOverlayModel;
}

export const MAX_RAIN_PARTICLES = 120;
export const MAX_SNOW_PARTICLES = 84;
export const MAX_FOG_BANDS = 4;

const DISABLED_PHASE3_ENVIRONMENT_EFFECT_FLAGS: Phase3EnvironmentEffectFlags = Object.freeze({
  rain: false,
  snow: false,
  fog: false,
  dayNight: false,
});

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function includesAnyPattern(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern));
}

function getNormalizedWeatherCondition(snapshot: SpectatorSnapshot): string {
  return snapshot.weather?.condition.trim().toLowerCase() ?? '';
}

function parseLocalHour(localTime: string): number | undefined {
  const [hourRaw = '', minuteRaw = '0'] = localTime.split(':');
  const hours = Number.parseInt(hourRaw, 10);
  const minutes = Number.parseInt(minuteRaw, 10);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return undefined;
  }

  return hours + minutes / 60;
}

function getEffectDimensions(snapshot: SpectatorSnapshot): EnvironmentEffectDimensions {
  const cellSize = snapshot.map_render_theme.cell_size;

  return {
    worldWidth: snapshot.map.cols * cellSize,
    worldHeight: snapshot.map.rows * cellSize,
    cellSize,
  };
}

function buildRainParticles(dimensions: EnvironmentEffectDimensions): RainParticleModel[] {
  const mapCells = Math.max((dimensions.worldWidth / dimensions.cellSize) * (dimensions.worldHeight / dimensions.cellSize), 1);
  const count = clamp(Math.round(mapCells * 1.35), 28, MAX_RAIN_PARTICLES);
  const baseLength = Math.max(dimensions.cellSize * 0.32, 18);

  return Array.from({ length: count }, (_, index) => {
    const x = (((index * 73) % 997) / 997) * dimensions.worldWidth;
    const y = (((index * 151) % 991) / 991) * dimensions.worldHeight;
    const length = baseLength * (1 + (index % 3) * 0.18);

    return {
      x,
      y,
      dx: dimensions.cellSize * 0.08,
      dy: length,
      alpha: 0.16 + (index % 4) * 0.03,
      width: 1 + (index % 2) * 0.35,
    };
  });
}

function buildSnowParticles(dimensions: EnvironmentEffectDimensions): SnowParticleModel[] {
  const mapCells = Math.max((dimensions.worldWidth / dimensions.cellSize) * (dimensions.worldHeight / dimensions.cellSize), 1);
  const count = clamp(Math.round(mapCells * 0.92), 18, MAX_SNOW_PARTICLES);

  return Array.from({ length: count }, (_, index) => ({
    x: (((index * 61) % 983) / 983) * dimensions.worldWidth,
    y: (((index * 109) % 977) / 977) * dimensions.worldHeight,
    radius: Math.max(dimensions.cellSize * (0.026 + (index % 3) * 0.006), 1.5),
    alpha: 0.16 + (index % 5) * 0.025,
  }));
}

function buildFogBands(dimensions: EnvironmentEffectDimensions): FogBandModel[] {
  const topHeight = Math.max(dimensions.cellSize * 0.9, dimensions.worldHeight * 0.12);
  const sideWidth = Math.max(dimensions.cellSize * 0.72, dimensions.worldWidth * 0.08);

  return [
    {
      x: 0,
      y: 0,
      width: dimensions.worldWidth,
      height: topHeight,
      alpha: 0.09,
    },
    {
      x: 0,
      y: Math.max(dimensions.worldHeight - topHeight * 0.92, 0),
      width: dimensions.worldWidth,
      height: topHeight * 0.92,
      alpha: 0.08,
    },
    {
      x: 0,
      y: topHeight * 0.28,
      width: sideWidth,
      height: Math.max(dimensions.worldHeight - topHeight * 0.56, 0),
      alpha: 0.06,
    },
    {
      x: Math.max(dimensions.worldWidth - sideWidth, 0),
      y: topHeight * 0.2,
      width: sideWidth,
      height: Math.max(dimensions.worldHeight - topHeight * 0.4, 0),
      alpha: 0.06,
    },
  ];
}

function buildDayNightOverlay(localTime: string): DayNightOverlayModel | undefined {
  const localHour = parseLocalHour(localTime);

  if (localHour === undefined) {
    return undefined;
  }

  if (localHour >= 19 || localHour < 5) {
    return {
      phase: 'night',
      color: '#020617',
      alpha: localHour >= 22 || localHour < 4 ? 0.22 : 0.18,
    };
  }

  if (localHour >= 17 && localHour < 19) {
    return {
      phase: 'dusk',
      color: '#312e81',
      alpha: 0.1 + ((localHour - 17) / 2) * 0.06,
    };
  }

  if (localHour >= 5 && localHour < 7) {
    return {
      phase: 'dawn',
      color: '#1e1b4b',
      alpha: 0.14 - ((localHour - 5) / 2) * 0.05,
    };
  }

  return undefined;
}

export function resolvePhase3EnvironmentEffectFlags(
  enabled = false,
  flags?: Partial<Phase3EnvironmentEffectFlags>,
): Phase3EnvironmentEffectFlags {
  if (!enabled) {
    return DISABLED_PHASE3_ENVIRONMENT_EFFECT_FLAGS;
  }

  return {
    rain: flags?.rain === true,
    snow: flags?.snow === true,
    fog: flags?.fog === true,
    dayNight: flags?.dayNight === true,
  };
}

export function buildEnvironmentEffectsModel(
  snapshot: SpectatorSnapshot,
  flags: Phase3EnvironmentEffectFlags,
): EnvironmentEffectsModel {
  const dimensions = getEffectDimensions(snapshot);
  const condition = getNormalizedWeatherCondition(snapshot);
  const precipitation =
    flags.snow && includesAnyPattern(condition, ['snow', 'sleet', 'blizzard', '雪'])
      ? {
          kind: 'snow' as const,
          color: '#f8fafc',
          particles: buildSnowParticles(dimensions),
        }
      : flags.rain && includesAnyPattern(condition, ['rain', 'drizzle', 'storm', 'shower', '雨'])
        ? {
            kind: 'rain' as const,
            color: '#bae6fd',
            particles: buildRainParticles(dimensions),
          }
        : undefined;
  const fog =
    flags.fog && includesAnyPattern(condition, ['fog', 'mist', 'haze', '霧'])
      ? {
          color: '#e2e8f0',
          bands: buildFogBands(dimensions),
        }
      : undefined;
  const dayNight = flags.dayNight ? buildDayNightOverlay(snapshot.calendar.local_time) : undefined;

  return {
    dimensions,
    ...(precipitation ? { precipitation } : {}),
    ...(fog ? { fog } : {}),
    ...(dayNight ? { dayNight } : {}),
  };
}
