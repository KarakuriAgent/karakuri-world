import { TextStyle, type Graphics } from 'pixi.js';
import { memo, useMemo } from 'react';

import type { SpectatorSnapshot } from '../../../worker/src/contracts/spectator-snapshot.js';
import {
  buildEnvironmentEffectsModel,
  resolvePhase3EnvironmentEffectFlags,
  type DayNightOverlayModel,
  type FogBandModel,
  type Phase3EnvironmentEffectFlags,
  type RainParticleModel,
  type SnowParticleModel,
} from './environment-effects.js';
import { type ActionParticleModel as MotionActionParticleModel } from './motion-effects.js';

export interface EffectLayerProps {
  snapshot: SpectatorSnapshot;
  enabled?: boolean;
  flags?: Partial<Phase3EnvironmentEffectFlags>;
}

export interface ActionParticlesLayerProps {
  actionParticles?: MotionActionParticleModel[];
}

function drawRainEffect(graphics: Graphics, color: string, particles: RainParticleModel[]) {
  graphics.clear();

  for (const particle of particles) {
    graphics.moveTo(particle.x, particle.y);
    graphics.lineTo(particle.x + particle.dx, particle.y + particle.dy);
    graphics.stroke({
      color,
      width: particle.width,
      alpha: particle.alpha,
    });
  }
}

function drawSnowEffect(graphics: Graphics, color: string, particles: SnowParticleModel[]) {
  graphics.clear();

  for (const particle of particles) {
    graphics.circle(particle.x, particle.y, particle.radius);
    graphics.fill({
      color,
      alpha: particle.alpha,
    });
  }
}

function drawFogEffect(graphics: Graphics, color: string, bands: FogBandModel[]) {
  graphics.clear();

  for (const band of bands) {
    graphics.rect(band.x, band.y, band.width, band.height);
    graphics.fill({
      color,
      alpha: band.alpha,
    });
  }
}

function drawDayNightEffect(graphics: Graphics, overlay: DayNightOverlayModel, width: number, height: number) {
  graphics.clear();
  graphics.rect(0, 0, width, height);
  graphics.fill({
    color: overlay.color,
    alpha: overlay.alpha,
  });
}

function formatEffectMetric(value: number): string {
  return value.toFixed(2);
}

function getMaxAlpha(entries: ReadonlyArray<{ alpha: number }>): string | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  return formatEffectMetric(Math.max(...entries.map((entry) => entry.alpha)));
}

const ACTION_PARTICLE_FONT_FAMILY = 'Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif';

export const EffectLayer = memo(function EffectLayer({
  snapshot,
  enabled = false,
  flags,
}: EffectLayerProps) {
  const resolvedFlags = useMemo(
    () => resolvePhase3EnvironmentEffectFlags(enabled, flags),
    [enabled, flags?.dayNight, flags?.fog, flags?.rain, flags?.snow],
  );
  const effectsModel = useMemo(() => buildEnvironmentEffectsModel(snapshot, resolvedFlags), [resolvedFlags, snapshot]);
  const rainEffect = effectsModel.precipitation?.kind === 'rain' ? effectsModel.precipitation : undefined;
  const snowEffect = effectsModel.precipitation?.kind === 'snow' ? effectsModel.precipitation : undefined;

  if (!enabled) {
    return null;
  }

  return (
    <pixiContainer
      data-active-day-night={effectsModel.dayNight?.phase ?? 'none'}
      data-active-fog={effectsModel.fog ? 'true' : 'false'}
      data-active-precipitation={effectsModel.precipitation?.kind ?? 'none'}
      data-testid="map-effect-root"
    >
      {effectsModel.dayNight ? (
        <pixiGraphics
          data-alpha={formatEffectMetric(effectsModel.dayNight.alpha)}
          data-color={effectsModel.dayNight.color}
          data-phase={effectsModel.dayNight.phase}
          data-testid="map-effect-day-night"
          draw={(graphics) =>
            drawDayNightEffect(
              graphics,
              effectsModel.dayNight!,
              effectsModel.dimensions.worldWidth,
              effectsModel.dimensions.worldHeight,
            )
          }
        />
      ) : null}
      {effectsModel.fog ? (
        <pixiGraphics
          data-band-count={String(effectsModel.fog.bands.length)}
          data-color={effectsModel.fog.color}
          data-max-alpha={getMaxAlpha(effectsModel.fog.bands)}
          data-testid="map-effect-fog"
          draw={(graphics) => drawFogEffect(graphics, effectsModel.fog!.color, effectsModel.fog!.bands)}
        />
      ) : null}
      {rainEffect ? (
        <pixiGraphics
          data-color={rainEffect.color}
          data-max-alpha={getMaxAlpha(rainEffect.particles)}
          data-particle-count={String(rainEffect.particles.length)}
          data-testid="map-effect-rain"
          draw={(graphics) => drawRainEffect(graphics, rainEffect.color, rainEffect.particles)}
        />
      ) : null}
      {snowEffect ? (
        <pixiGraphics
          data-color={snowEffect.color}
          data-max-alpha={getMaxAlpha(snowEffect.particles)}
          data-particle-count={String(snowEffect.particles.length)}
          data-testid="map-effect-snow"
          draw={(graphics) => drawSnowEffect(graphics, snowEffect.color, snowEffect.particles)}
        />
      ) : null}
    </pixiContainer>
  );
});

export const ActionParticlesLayer = memo(function ActionParticlesLayer({
  actionParticles = [],
}: ActionParticlesLayerProps) {
  const actionParticleTextStyles = useMemo(
    () =>
      actionParticles.map((particle) =>
        new TextStyle({
          fontFamily: ACTION_PARTICLE_FONT_FAMILY,
          fontSize: particle.fontSize,
        }),
      ),
    [actionParticles],
  );

  if (actionParticles.length === 0) {
    return null;
  }

  return (
    <pixiContainer data-active-action-particles={String(actionParticles.length)} data-testid="map-effect-action-particles-root">
      {actionParticles.map((particle, index) => (
        <pixiText
          key={particle.key}
          alpha={particle.alpha}
          anchor={0.5}
          data-testid={`map-effect-action-particle-${particle.agentId}-${index}`}
          style={actionParticleTextStyles[index]}
          text={particle.emoji}
          x={particle.x}
          y={particle.y}
        />
      ))}
    </pixiContainer>
  );
});
