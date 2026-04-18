// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EffectLayer } from '../components/map/EffectLayer.js';
import {
  MAX_FOG_BANDS,
  MAX_RAIN_PARTICLES,
  MAX_SNOW_PARTICLES,
  buildEnvironmentEffectsModel,
  resolvePhase3EnvironmentEffectFlags,
} from '../components/map/environment-effects.js';
import type { SpectatorSnapshot } from '../../worker/src/contracts/spectator-snapshot.js';
import { createFixtureSnapshot } from './fixtures/snapshot.js';

function createEnvironmentSnapshot(overrides?: Partial<SpectatorSnapshot>): SpectatorSnapshot {
  return {
    ...createFixtureSnapshot(),
    ...overrides,
    calendar: {
      ...createFixtureSnapshot().calendar,
      ...overrides?.calendar,
    },
    map: {
      ...createFixtureSnapshot().map,
      ...overrides?.map,
    },
    map_render_theme: {
      ...createFixtureSnapshot().map_render_theme,
      ...overrides?.map_render_theme,
    },
    weather: overrides?.weather ?? createFixtureSnapshot().weather,
  };
}

function createLargeMapSnapshot(): SpectatorSnapshot {
  const rows = 40;
  const cols = 40;
  const nodes: SpectatorSnapshot['map']['nodes'] = {};

  for (let row = 1; row <= rows; row += 1) {
    for (let col = 1; col <= cols; col += 1) {
      nodes[`${row}-${col}`] = { type: 'normal' };
    }
  }

  return createEnvironmentSnapshot({
    calendar: {
      ...createFixtureSnapshot().calendar,
      local_time: '23:10:00',
    },
    map: {
      rows,
      cols,
      nodes,
      buildings: [],
      npcs: [],
    },
    map_render_theme: {
      ...createFixtureSnapshot().map_render_theme,
      cell_size: 48,
    },
    weather: {
      condition: '大雪と霧',
      temperature_celsius: -4,
    },
  });
}

describe('EffectLayer environment staging', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('keeps the phase3 effect anchor fully disabled by default', () => {
    const { container } = render(<EffectLayer enabled={false} snapshot={createFixtureSnapshot()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders rain and day-night overlays without hiding the layer contract when both staged flags are on', () => {
    render(
      <EffectLayer
        enabled
        flags={{ rain: true, dayNight: true }}
        snapshot={createEnvironmentSnapshot({
          calendar: {
            ...createFixtureSnapshot().calendar,
            local_time: '22:15:00',
          },
          weather: {
            condition: '霧雨',
            temperature_celsius: 15,
          },
        })}
      />,
    );

    expect(screen.getByTestId('map-effect-root')).toHaveAttribute('data-active-precipitation', 'rain');
    expect(screen.getByTestId('map-effect-root')).toHaveAttribute('data-active-day-night', 'night');
    expect(screen.getByTestId('map-effect-rain')).toHaveAttribute('data-particle-count');
    expect(screen.getByTestId('map-effect-day-night')).toBeInTheDocument();
  });

  it('lets fog stay enabled while rain and day-night are rolled back individually', () => {
    render(
      <EffectLayer
        enabled
        flags={{ rain: false, fog: true, dayNight: false }}
        snapshot={createEnvironmentSnapshot({
          weather: {
            condition: '霧雨',
            temperature_celsius: 15,
          },
        })}
      />,
    );

    expect(screen.getByTestId('map-effect-root')).toHaveAttribute('data-active-precipitation', 'none');
    expect(screen.getByTestId('map-effect-root')).toHaveAttribute('data-active-fog', 'true');
    expect(screen.getByTestId('map-effect-root')).toHaveAttribute('data-active-day-night', 'none');
    expect(screen.queryByTestId('map-effect-rain')).not.toBeInTheDocument();
    expect(screen.getByTestId('map-effect-fog')).toBeInTheDocument();
    expect(screen.queryByTestId('map-effect-day-night')).not.toBeInTheDocument();
  });

  it('caps generated drawables for the performance smoke budget on large maps', () => {
    const model = buildEnvironmentEffectsModel(
      createLargeMapSnapshot(),
      resolvePhase3EnvironmentEffectFlags(true, {
        snow: true,
        fog: true,
        dayNight: true,
      }),
    );

    expect(model.precipitation?.kind).toBe('snow');
    expect(model.precipitation?.particles.length ?? 0).toBeLessThanOrEqual(MAX_SNOW_PARTICLES);
    expect(model.fog?.bands.length ?? 0).toBeLessThanOrEqual(MAX_FOG_BANDS);
    expect(model.dayNight?.alpha ?? 0).toBeLessThanOrEqual(0.22);
  });

  it('caps rain particle counts for structure tests that exercise dense weather overlays', () => {
    const model = buildEnvironmentEffectsModel(
      createEnvironmentSnapshot({
        calendar: {
          ...createFixtureSnapshot().calendar,
          local_time: '18:45:00',
        },
        weather: {
          condition: '豪雨',
          temperature_celsius: 12,
        },
      }),
      resolvePhase3EnvironmentEffectFlags(true, {
        rain: true,
        dayNight: true,
      }),
    );

    expect(model.precipitation?.kind).toBe('rain');
    expect(model.precipitation?.particles.length ?? 0).toBeLessThanOrEqual(MAX_RAIN_PARTICLES);
    expect(model.dayNight?.phase).toBe('dusk');
  });
});
