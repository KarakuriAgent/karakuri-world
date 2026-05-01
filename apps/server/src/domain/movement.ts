import type { WorldEngine } from '../engine/world-engine.js';
import type { MoveRequest, MoveResponse } from '../types/api.js';
import { WorldError } from '../types/api.js';
import type { LoggedInAgent } from '../types/agent.js';
import type { NodeId } from '../types/data-model.js';
import type { MovementTimer } from '../types/timer.js';
import { requireActionableAgent } from './agent-guards.js';
import { cancelIdleReminder, startIdleReminder } from './idle-reminder.js';
import { findPath, getNodeConfig, isNodeWithinBounds, isPassable } from './map-utils.js';
import { handlePendingServerAnnouncements } from './server-announcements.js';

function requireMoveReadyAgent(engine: WorldEngine, agentId: string): LoggedInAgent {
  return requireActionableAgent(engine, agentId, { activityLabel: 'move' });
}

export function validateMove(engine: WorldEngine, agentId: string, request: MoveRequest): {
  agent: LoggedInAgent;
  to_node_id: NodeId;
  path: NodeId[];
} {
  const agent = requireMoveReadyAgent(engine, agentId);
  if (!isNodeWithinBounds(request.target_node_id, engine.config.map)) {
    throw new WorldError(400, 'out_of_bounds', 'Destination is outside the map.');
  }

  const destinationNode = getNodeConfig(request.target_node_id, engine.config.map);
  if (!isPassable(destinationNode.type)) {
    throw new WorldError(400, 'impassable_node', 'Destination node is not passable.');
  }

  if (request.target_node_id === agent.node_id) {
    throw new WorldError(400, 'same_node', 'Destination node must differ from the current node.');
  }

  const path = findPath(agent.node_id, request.target_node_id, engine.config.map);
  if (!path) {
    throw new WorldError(400, 'no_path', 'No path exists to the destination node.');
  }

  return {
    agent,
    to_node_id: request.target_node_id,
    path,
  };
}

export function executeMove(engine: WorldEngine, agentId: string, request: MoveRequest): MoveResponse {
  const { agent, to_node_id, path } = validateMove(engine, agentId, request);
  return executeValidatedMove(engine, agent, to_node_id, path);
}

export function executeValidatedMove(
  engine: WorldEngine,
  agent: LoggedInAgent,
  to_node_id: NodeId,
  path: NodeId[],
): MoveResponse {
  const arrivesAt = Date.now() + path.length * engine.config.movement.duration_ms;

  cancelIdleReminder(engine, agent.agent_id);
  engine.timerManager.cancelByType(agent.agent_id, 'movement');
  engine.state.setState(agent.agent_id, 'moving');
  engine.timerManager.create({
    type: 'movement',
    agent_ids: [agent.agent_id],
    agent_id: agent.agent_id,
    from_node_id: agent.node_id,
    to_node_id,
    path: [...path],
    fires_at: arrivesAt,
  });
  engine.state.clearExcludedInfoCommands(agent.agent_id);
  engine.state.setLastUsedItem(agent.agent_id, null);

  engine.emitEvent({
    type: 'movement_started',
    agent_id: agent.agent_id,
    agent_name: agent.agent_name,
    from_node_id: agent.node_id,
    to_node_id,
    path: [...path],
    arrives_at: arrivesAt,
  });

  return {
    from_node_id: agent.node_id,
    to_node_id,
    arrives_at: arrivesAt,
  };
}

export function getMovementTimer(engine: WorldEngine, agentId: string): MovementTimer | null {
  return (
    engine.timerManager.find(
      (candidate): candidate is MovementTimer => candidate.type === 'movement' && candidate.agent_id === agentId,
    ) ?? null
  );
}

export function getCurrentMovementPosition(timer: MovementTimer, durationMs: number, now: number): NodeId {
  if (durationMs <= 0 || timer.path.length === 0) {
    return timer.to_node_id;
  }

  const startedAt = timer.fires_at - timer.path.length * durationMs;
  const elapsed = Math.max(0, now - startedAt);
  const stepsCompleted = Math.floor(elapsed / durationMs);

  if (stepsCompleted <= 0) {
    return timer.from_node_id;
  }

  if (stepsCompleted >= timer.path.length) {
    return timer.to_node_id;
  }

  return timer.path[stepsCompleted - 1];
}

export function getAgentCurrentNode(
  engine: WorldEngine,
  agent: Pick<LoggedInAgent, 'agent_id' | 'node_id' | 'state'>,
  now = Date.now(),
): NodeId {
  if (agent.state !== 'moving') {
    return agent.node_id;
  }

  const movementTimer = getMovementTimer(engine, agent.agent_id);
  if (!movementTimer) {
    return agent.node_id;
  }

  return getCurrentMovementPosition(movementTimer, engine.config.movement.duration_ms, now);
}

export function handleMovementCompleted(engine: WorldEngine, timer: MovementTimer): void {
  const agent = engine.state.getLoggedIn(timer.agent_id);
  if (!agent) {
    return;
  }

  engine.state.setNode(timer.agent_id, timer.to_node_id);
  engine.state.setState(timer.agent_id, 'idle');
  startIdleReminder(engine, timer.agent_id);
  const deliveredServerAnnouncementIds = handlePendingServerAnnouncements(engine, timer.agent_id);

  engine.emitEvent({
    type: 'movement_completed',
    agent_id: agent.agent_id,
    agent_name: agent.agent_name,
    node_id: timer.to_node_id,
    delivered_server_announcement_ids: deliveredServerAnnouncementIds,
  });
}
