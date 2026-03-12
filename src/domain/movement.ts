import type { WorldEngine } from '../engine/world-engine.js';
import type { MoveRequest, MoveResponse } from '../types/api.js';
import { WorldError } from '../types/api.js';
import type { JoinedAgent } from '../types/agent.js';
import type { MovementTimer } from '../types/timer.js';
import { getAdjacentNodeId, getNodeConfig, isPassable } from './map-utils.js';
import { handlePendingServerEvents } from './server-events.js';

function requireMoveReadyAgent(engine: WorldEngine, agentId: string): JoinedAgent {
  const agent = engine.state.getJoined(agentId);
  if (!agent) {
    throw new WorldError(403, 'not_joined', `Agent is not joined: ${agentId}`);
  }

  if (agent.state !== 'idle' || agent.pending_conversation_id) {
    throw new WorldError(409, 'state_conflict', 'Agent cannot move in the current state.');
  }

  return agent;
}

export function validateMove(engine: WorldEngine, agentId: string, request: MoveRequest): {
  agent: JoinedAgent;
  to_node_id: `${number}-${number}`;
} {
  const agent = requireMoveReadyAgent(engine, agentId);
  const destinationNodeId = getAdjacentNodeId(agent.node_id, request.direction, engine.config.map);
  if (!destinationNodeId) {
    throw new WorldError(400, 'out_of_bounds', 'Destination is outside the map.');
  }

  const destinationNode = getNodeConfig(destinationNodeId, engine.config.map);
  if (!isPassable(destinationNode.type)) {
    throw new WorldError(400, 'impassable_node', 'Destination node is not passable.');
  }

  return {
    agent,
    to_node_id: destinationNodeId,
  };
}

export function executeMove(engine: WorldEngine, agentId: string, request: MoveRequest): MoveResponse {
  const { agent, to_node_id } = validateMove(engine, agentId, request);
  const arrivesAt = Date.now() + engine.config.movement.duration_ms;

  engine.timerManager.cancelByType(agentId, 'movement');
  engine.state.setState(agentId, 'moving');
  engine.timerManager.create({
    type: 'movement',
    agent_ids: [agentId],
    agent_id: agentId,
    direction: request.direction,
    from_node_id: agent.node_id,
    to_node_id,
    fires_at: arrivesAt,
  });

  engine.emitEvent({
    type: 'movement_started',
    agent_id: agent.agent_id,
    agent_name: agent.agent_name,
    direction: request.direction,
    from_node_id: agent.node_id,
    to_node_id,
    arrives_at: arrivesAt,
  });

  return {
    from_node_id: agent.node_id,
    to_node_id,
    arrives_at: arrivesAt,
  };
}

export function handleMovementCompleted(engine: WorldEngine, timer: MovementTimer): void {
  const agent = engine.state.getJoined(timer.agent_id);
  if (!agent) {
    return;
  }

  engine.state.setNode(timer.agent_id, timer.to_node_id);
  engine.state.setState(timer.agent_id, 'idle');
  const deliveredServerEventIds = handlePendingServerEvents(engine, timer.agent_id);

  engine.emitEvent({
    type: 'movement_completed',
    agent_id: agent.agent_id,
    agent_name: agent.agent_name,
    direction: timer.direction,
    from_node_id: timer.from_node_id,
    to_node_id: timer.to_node_id,
    delivered_server_event_ids: deliveredServerEventIds,
  });
}
