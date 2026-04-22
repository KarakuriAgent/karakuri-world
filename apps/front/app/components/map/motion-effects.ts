import type { SpectatorAgentSnapshot, SpectatorSnapshot } from '../../../worker/src/contracts/spectator-snapshot.js';
import { getNodeCenter } from './map-render-model.js';

export interface Phase3MotionEffectFlags {
  motion: boolean;
  actionParticles: boolean;
}

export interface AgentVisualPosition {
  centerX: number;
  centerY: number;
  mode: 'static' | 'interpolated';
}

export interface ActionParticleModel {
  key: string;
  agentId: string;
  emoji: string;
  x: number;
  y: number;
  alpha: number;
  fontSize: number;
}

export interface MotionEffectsModel {
  agentPositions: Record<string, AgentVisualPosition>;
  actionParticles: ActionParticleModel[];
}

export const MAX_ACTION_PARTICLES_PER_AGENT = 2;
export const MAX_ACTION_PARTICLES_TOTAL = 80;

const DISABLED_PHASE3_MOTION_EFFECT_FLAGS: Phase3MotionEffectFlags = Object.freeze({
  motion: false,
  actionParticles: false,
});
const STATIC_AGENT_POSITIONS_CACHE = new WeakMap<object, Record<string, AgentVisualPosition>>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function hashString(value: string): number {
  let hash = 0;

  for (const char of value) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }

  return Math.abs(hash);
}

function parseNodeCoordinate(nodeId: string): { row: number; col: number } | undefined {
  const match = /^(\d+)-(\d+)$/.exec(nodeId);

  if (!match) {
    return undefined;
  }

  return {
    row: Number(match[1]),
    col: Number(match[2]),
  };
}

function areAdjacentNodeIds(left: string, right: string): boolean {
  const leftCoordinate = parseNodeCoordinate(left);
  const rightCoordinate = parseNodeCoordinate(right);

  if (!leftCoordinate || !rightCoordinate) {
    return false;
  }

  return Math.abs(leftCoordinate.row - rightCoordinate.row) + Math.abs(leftCoordinate.col - rightCoordinate.col) === 1;
}

function getStaticAgentPosition(
  snapshot: Pick<SpectatorSnapshot, 'map' | 'map_render_theme'>,
  agent: Pick<SpectatorAgentSnapshot, 'node_id'>,
): AgentVisualPosition | undefined {
  const center = getNodeCenter(snapshot, agent.node_id);

  if (!center) {
    return undefined;
  }

  return {
    centerX: center.centerX,
    centerY: center.centerY,
    mode: 'static',
  };
}

function buildStaticAgentPositions(
  snapshot: Pick<SpectatorSnapshot, 'agents' | 'map' | 'map_render_theme'>,
): Record<string, AgentVisualPosition> {
  const cachedPositions = STATIC_AGENT_POSITIONS_CACHE.get(snapshot);
  if (cachedPositions) {
    return cachedPositions;
  }

  const staticAgentPositions: Record<string, AgentVisualPosition> = {};

  for (const agent of snapshot.agents) {
    const staticPosition = getStaticAgentPosition(snapshot, agent);

    if (staticPosition) {
      staticAgentPositions[agent.agent_id] = staticPosition;
    }
  }

  STATIC_AGENT_POSITIONS_CACHE.set(snapshot, staticAgentPositions);
  return staticAgentPositions;
}

function getInterpolatedAgentPosition(
  snapshot: Pick<SpectatorSnapshot, 'generated_at' | 'map' | 'map_render_theme'>,
  agent: SpectatorAgentSnapshot,
  nowMs: number,
): AgentVisualPosition | undefined {
  if (!agent.movement || agent.movement.path.length < 1) {
    return undefined;
  }

  if (agent.movement.path.at(-1) !== agent.movement.to_node_id) {
    return undefined;
  }

  const fullPublishedRoute = [agent.movement.from_node_id, ...agent.movement.path];

  for (let index = 1; index < fullPublishedRoute.length; index += 1) {
    if (!areAdjacentNodeIds(fullPublishedRoute[index - 1]!, fullPublishedRoute[index]!)) {
      return undefined;
    }
  }

  const currentNodeIndex = fullPublishedRoute.indexOf(agent.node_id);

  if (currentNodeIndex === -1) {
    return undefined;
  }

  const interpolationRoute = fullPublishedRoute.slice(currentNodeIndex);

  if (interpolationRoute.length < 2) {
    return undefined;
  }

  const interpolationStartMs = snapshot.generated_at;
  const interpolationEndMs = agent.movement.arrives_at;

  if (!Number.isFinite(interpolationStartMs) || !Number.isFinite(interpolationEndMs) || interpolationEndMs <= interpolationStartMs) {
    return undefined;
  }

  const nodeCenters = interpolationRoute
    .map((nodeId) => getNodeCenter(snapshot, nodeId))
    .filter((center): center is NonNullable<typeof center> => center !== undefined);

  if (nodeCenters.length !== interpolationRoute.length) {
    return undefined;
  }

  const normalizedProgress = clamp((nowMs - interpolationStartMs) / (interpolationEndMs - interpolationStartMs), 0, 1);
  const segmentCount = nodeCenters.length - 1;

  if (segmentCount <= 0) {
    return undefined;
  }

  const rawSegmentProgress = normalizedProgress * segmentCount;
  const segmentIndex = Math.min(Math.floor(rawSegmentProgress), segmentCount - 1);
  const segmentProgress = normalizedProgress >= 1 ? 1 : rawSegmentProgress - segmentIndex;
  const fromCenter = nodeCenters[segmentIndex]!;
  const toCenter = nodeCenters[Math.min(segmentIndex + 1, nodeCenters.length - 1)]!;

  return {
    centerX: fromCenter.centerX + (toCenter.centerX - fromCenter.centerX) * segmentProgress,
    centerY: fromCenter.centerY + (toCenter.centerY - fromCenter.centerY) * segmentProgress,
    mode: 'interpolated',
  };
}

function buildActionParticles(
  snapshot: Pick<SpectatorSnapshot, 'generated_at' | 'map_render_theme'>,
  agents: SpectatorAgentSnapshot[],
  positions: Record<string, AgentVisualPosition>,
  nowMs: number,
): ActionParticleModel[] {
  const particleAgents = agents.filter((agent) => agent.current_activity?.emoji.trim());
  const particleBudget = Math.min(particleAgents.length * MAX_ACTION_PARTICLES_PER_AGENT, MAX_ACTION_PARTICLES_TOTAL);
  const particles: ActionParticleModel[] = [];
  const baseFontSize = Math.max(snapshot.map_render_theme.cell_size * 0.2, 14);

  for (const agent of particleAgents) {
    if (particles.length >= particleBudget) {
      break;
    }

    const position = positions[agent.agent_id];
    const emoji = agent.current_activity?.emoji.trim();

    if (!position || !emoji) {
      continue;
    }

    const agentSeed = hashString(agent.agent_id + ':' + emoji);

    for (let index = 0; index < MAX_ACTION_PARTICLES_PER_AGENT; index += 1) {
      if (particles.length >= particleBudget) {
        break;
      }

      const phase = (((nowMs - snapshot.generated_at) + agentSeed * 37 + index * 173) % 1600 + 1600) % 1600 / 1600;
      const lift = (1 - phase) * snapshot.map_render_theme.cell_size * 0.2;
      const sway = (index === 0 ? -1 : 1) * snapshot.map_render_theme.cell_size * 0.09;

      particles.push({
        key: `${agent.agent_id}:${index}`,
        agentId: agent.agent_id,
        emoji,
        x: position.centerX + sway,
        y: position.centerY - snapshot.map_render_theme.cell_size * 0.34 - lift,
        alpha: 0.28 + (1 - phase) * 0.34,
        fontSize: baseFontSize + (1 - phase) * 3,
      });
    }
  }

  return particles;
}

function buildInterpolatedAgentPositions(
  snapshot: Pick<SpectatorSnapshot, 'agents' | 'generated_at' | 'map' | 'map_render_theme'>,
  staticAgentPositions: Record<string, AgentVisualPosition>,
  nowMs: number,
): Record<string, AgentVisualPosition> {
  let agentPositions: Record<string, AgentVisualPosition> | undefined;

  for (const agent of snapshot.agents) {
    const staticPosition = staticAgentPositions[agent.agent_id];

    if (!staticPosition || !agent.movement) {
      continue;
    }

    const interpolatedPosition = getInterpolatedAgentPosition(snapshot, agent, nowMs);

    if (!interpolatedPosition) {
      continue;
    }

    if (!agentPositions) {
      agentPositions = { ...staticAgentPositions };
    }

    agentPositions[agent.agent_id] = interpolatedPosition;
  }

  return agentPositions ?? staticAgentPositions;
}

export function resolvePhase3MotionEffectFlags(
  enabled = false,
  flags?: Partial<Phase3MotionEffectFlags>,
): Phase3MotionEffectFlags {
  if (!enabled) {
    return DISABLED_PHASE3_MOTION_EFFECT_FLAGS;
  }

  return {
    motion: flags?.motion === true,
    actionParticles: flags?.actionParticles === true,
  };
}

export function hasActiveInterpolatedMotion(
  snapshot: Pick<SpectatorSnapshot, 'agents' | 'generated_at' | 'map' | 'map_render_theme'>,
  flags: Pick<Phase3MotionEffectFlags, 'motion'>,
  nowMs: number,
): boolean {
  if (!flags.motion) {
    return false;
  }

  return snapshot.agents.some((agent) => {
    if (!agent.movement || nowMs >= agent.movement.arrives_at) {
      return false;
    }

    return Boolean(getInterpolatedAgentPosition(snapshot, agent, nowMs));
  });
}

export function buildMotionEffectsModel(
  snapshot: Pick<SpectatorSnapshot, 'agents' | 'generated_at' | 'map' | 'map_render_theme'>,
  flags: Phase3MotionEffectFlags,
  nowMs: number,
): MotionEffectsModel {
  const staticAgentPositions = buildStaticAgentPositions(snapshot);
  const agentPositions = flags.motion
    ? buildInterpolatedAgentPositions(snapshot, staticAgentPositions, nowMs)
    : staticAgentPositions;

  return {
    agentPositions,
    actionParticles: flags.actionParticles ? buildActionParticles(snapshot, snapshot.agents, agentPositions, nowMs) : [],
  };
}
