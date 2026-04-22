import { describe, expect, it } from 'vitest';

import type { SpectatorSnapshot } from '../../worker/src/contracts/spectator-snapshot.js';
import {
  MAX_ACTION_PARTICLES_PER_AGENT,
  MAX_ACTION_PARTICLES_TOTAL,
  buildMotionEffectsModel,
  hasActiveInterpolatedMotion,
  resolvePhase3MotionEffectFlags,
} from '../components/map/motion-effects.js';
import { createFixtureSnapshot } from './fixtures/snapshot.js';

function createMovingSnapshot(overrides?: Partial<SpectatorSnapshot>): SpectatorSnapshot {
  const snapshot = createFixtureSnapshot();

  return {
    ...snapshot,
    ...overrides,
    map: {
      ...snapshot.map,
      ...overrides?.map,
    },
    map_render_theme: {
      ...snapshot.map_render_theme,
      ...overrides?.map_render_theme,
    },
    agents: overrides?.agents ?? snapshot.agents,
  };
}

describe('motion effects model', () => {
  it('interpolates movement over contract-valid paths that exclude the source node', () => {
    const snapshot = createMovingSnapshot({
      generated_at: 2_000,
      agents: [
        {
          ...createFixtureSnapshot().agents[0]!,
          node_id: '1-1',
          state: 'moving',
          movement: {
            from_node_id: '1-1',
            to_node_id: '2-2',
            path: ['1-2', '2-2'],
            arrives_at: 3_000,
          },
        },
      ],
    });

    const model = buildMotionEffectsModel(
      snapshot,
      resolvePhase3MotionEffectFlags(true, {
        motion: true,
      }),
      2_250,
    );

    expect(model.agentPositions.alice).toMatchObject({
      centerX: 96,
      centerY: 48,
      mode: 'interpolated',
    });
  });

  it('continues interpolating from the current snapshot node when it is already inside the published path', () => {
    const snapshot = createMovingSnapshot({
      generated_at: 2_500,
      agents: [
        {
          ...createFixtureSnapshot().agents[0]!,
          node_id: '1-2',
          state: 'moving',
          movement: {
            from_node_id: '1-1',
            to_node_id: '2-2',
            path: ['1-2', '2-2'],
            arrives_at: 3_000,
          },
        },
      ],
    });

    const model = buildMotionEffectsModel(
      snapshot,
      resolvePhase3MotionEffectFlags(true, {
        motion: true,
      }),
      2_750,
    );

    expect(model.agentPositions.alice).toMatchObject({
      centerX: 144,
      centerY: 96,
      mode: 'interpolated',
    });
  });

  it('falls back to the static node center when interpolation inputs are unusable', () => {
    const snapshot = createMovingSnapshot({
      generated_at: 2_000,
      agents: [
        {
          ...createFixtureSnapshot().agents[0]!,
          node_id: '1-1',
          state: 'moving',
          movement: {
            from_node_id: '1-1',
            to_node_id: '2-2',
            path: ['1-2', '2-2'],
            arrives_at: 1_900,
          },
        },
      ],
    });

    const model = buildMotionEffectsModel(
      snapshot,
      resolvePhase3MotionEffectFlags(true, {
        motion: true,
      }),
      2_250,
    );

    expect(model.agentPositions.alice).toMatchObject({
      centerX: 48,
      centerY: 48,
      mode: 'static',
    });
  });

  it('falls back to the static node center when the current node is outside the contract path', () => {
    const snapshot = createMovingSnapshot({
      generated_at: 2_000,
      agents: [
        {
          ...createFixtureSnapshot().agents[0]!,
          node_id: '2-1',
          state: 'moving',
          movement: {
            from_node_id: '1-1',
            to_node_id: '2-2',
            path: ['1-2', '2-2'],
            arrives_at: 3_000,
          },
        },
      ],
    });

    const model = buildMotionEffectsModel(
      snapshot,
      resolvePhase3MotionEffectFlags(true, {
        motion: true,
      }),
      2_250,
    );

    expect(model.agentPositions.alice).toMatchObject({
      centerX: 48,
      centerY: 144,
      mode: 'static',
    });
  });

  it('falls back to the static node center when the published route contains non-adjacent hops', () => {
    const snapshot = createMovingSnapshot({
      generated_at: 2_000,
      agents: [
        {
          ...createFixtureSnapshot().agents[0]!,
          node_id: '1-1',
          state: 'moving',
          movement: {
            from_node_id: '1-1',
            to_node_id: '2-2',
            path: ['2-2'],
            arrives_at: 3_000,
          },
        },
      ],
    });

    const model = buildMotionEffectsModel(
      snapshot,
      resolvePhase3MotionEffectFlags(true, {
        motion: true,
      }),
      2_250,
    );

    expect(model.agentPositions.alice).toMatchObject({
      centerX: 48,
      centerY: 48,
      mode: 'static',
    });
  });

  it('only reports active interpolation when a movement can actually animate', () => {
    const flags = resolvePhase3MotionEffectFlags(true, {
      motion: true,
    });
    const validSnapshot = createMovingSnapshot({
      generated_at: 2_000,
      agents: [
        {
          ...createFixtureSnapshot().agents[0]!,
          node_id: '1-1',
          state: 'moving',
          movement: {
            from_node_id: '1-1',
            to_node_id: '2-2',
            path: ['1-2', '2-2'],
            arrives_at: 3_000,
          },
        },
      ],
    });
    const invalidSnapshot = createMovingSnapshot({
      generated_at: 2_000,
      agents: [
        {
          ...createFixtureSnapshot().agents[0]!,
          node_id: '1-1',
          state: 'moving',
          movement: {
            from_node_id: '1-1',
            to_node_id: '2-2',
            path: ['2-2'],
            arrives_at: 3_000,
          },
        },
      ],
    });

    expect(hasActiveInterpolatedMotion(validSnapshot, flags, 2_250)).toBe(true);
    expect(hasActiveInterpolatedMotion(validSnapshot, flags, 4_000)).toBe(false);
    expect(hasActiveInterpolatedMotion(invalidSnapshot, flags, 2_250)).toBe(false);
  });

  it('builds lightweight action particles from current_activity.emoji', () => {
    const snapshot = createMovingSnapshot();
    const model = buildMotionEffectsModel(
      snapshot,
      resolvePhase3MotionEffectFlags(true, {
        actionParticles: true,
      }),
      snapshot.generated_at + 400,
    );

    expect(model.actionParticles).toHaveLength(MAX_ACTION_PARTICLES_PER_AGENT);
    expect(model.actionParticles.map((particle) => particle.emoji)).toEqual(['🛠️', '🛠️']);
    expect(model.actionParticles.every((particle) => particle.agentId === 'alice')).toBe(true);
  });

  it('reuses static agent positions while only action particles animate', () => {
    const snapshot = createMovingSnapshot();
    const flags = resolvePhase3MotionEffectFlags(true, {
      actionParticles: true,
    });

    const firstModel = buildMotionEffectsModel(snapshot, flags, snapshot.generated_at + 100);
    const secondModel = buildMotionEffectsModel(snapshot, flags, snapshot.generated_at + 500);

    expect(firstModel.agentPositions).toBe(secondModel.agentPositions);
    expect(firstModel.actionParticles).not.toEqual(secondModel.actionParticles);
  });

  it('reuses static agent positions when every movement falls back to the phase1 static path', () => {
    const snapshot = createMovingSnapshot({
      generated_at: 2_000,
      agents: [
        {
          ...createFixtureSnapshot().agents[0]!,
          node_id: '1-1',
          state: 'moving',
          movement: {
            from_node_id: '1-1',
            to_node_id: '2-2',
            path: ['2-2'],
            arrives_at: 3_000,
          },
        },
      ],
    });
    const flags = resolvePhase3MotionEffectFlags(true, {
      motion: true,
    });

    const firstModel = buildMotionEffectsModel(snapshot, flags, 2_250);
    const secondModel = buildMotionEffectsModel(snapshot, flags, 2_750);

    expect(firstModel.agentPositions).toBe(secondModel.agentPositions);
    expect(firstModel.agentPositions.alice).toMatchObject({
      centerX: 48,
      centerY: 48,
      mode: 'static',
    });
  });

  it('caps action particle generation for dense snapshots', () => {
    const agents = Array.from({ length: 60 }, (_, index) => ({
      agent_id: `agent-${index}`,
      agent_name: `Agent ${index}`,
      node_id: index % 2 === 0 ? ('1-1' as const) : ('1-2' as const),
      state: 'in_action' as const,
      status_emoji: '✨',
      current_activity: {
        type: 'action' as const,
        label: 'Craft',
        emoji: '✨',
        duration_ms: 1_000,
        completes_at: 9_999,
      },
    }));
    const snapshot = createMovingSnapshot({
      agents,
    });

    const model = buildMotionEffectsModel(
      snapshot,
      resolvePhase3MotionEffectFlags(true, {
        actionParticles: true,
      }),
      snapshot.generated_at + 500,
    );

    expect(model.actionParticles.length).toBeLessThanOrEqual(MAX_ACTION_PARTICLES_TOTAL);
  });
});
