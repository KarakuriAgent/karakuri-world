import type { WorldEngine } from '../engine/world-engine.js';
import type { ActionRequest, ActionResponse, AvailableActionSummary } from '../types/api.js';
import { WorldError } from '../types/api.js';
import type { JoinedAgent } from '../types/agent.js';
import type { ActionConfig, BuildingConfig, NpcConfig } from '../types/data-model.js';
import type { ActionTimer } from '../types/timer.js';
import { cancelIdleReminder, startIdleReminder } from './idle-reminder.js';
import { findAdjacentNpcs, findBuildingByInteriorNode } from './map-utils.js';
import { getAgentCurrentNode } from './movement.js';

type ActionSource =
  | {
      type: 'building';
      id: string;
      name: string;
      action: ActionConfig;
    }
  | {
      type: 'npc';
      id: string;
      name: string;
      action: ActionConfig;
    };

function requireActionReadyAgent(engine: WorldEngine, agentId: string): JoinedAgent {
  const agent = engine.state.getJoined(agentId);
  if (!agent) {
    throw new WorldError(403, 'not_joined', `Agent is not joined: ${agentId}`);
  }

  if (agent.state !== 'idle' || agent.pending_conversation_id) {
    throw new WorldError(409, 'state_conflict', 'Agent cannot execute an action in the current state.');
  }

  return agent;
}

function mapActionSource(source: ActionSource): AvailableActionSummary {
  return {
    action_id: source.action.action_id,
    name: source.action.name,
    description: source.action.description,
    duration_ms: source.action.duration_ms,
    source: {
      type: source.type,
      id: source.id,
      name: source.name,
    },
  };
}

export function getAvailableActionSources(engine: WorldEngine, agentId: string): ActionSource[] {
  const agent = engine.state.getJoined(agentId);
  if (!agent) {
    throw new WorldError(403, 'not_joined', `Agent is not joined: ${agentId}`);
  }

  const sources: ActionSource[] = [];
  const currentNodeId = getAgentCurrentNode(engine, agent);
  const building = findBuildingByInteriorNode(currentNodeId, engine.config.map);
  if (building) {
    sources.push(
      ...building.actions.map((action) => ({
        type: 'building' as const,
        id: building.building_id,
        name: building.name,
        action,
      })),
    );
  }

  sources.push(
    ...findAdjacentNpcs(currentNodeId, engine.config.map).flatMap((npc) =>
      npc.actions.map((action) => ({
        type: 'npc' as const,
        id: npc.npc_id,
        name: npc.name,
        action,
      })),
    ),
  );

  return sources.sort((left, right) => left.action.action_id.localeCompare(right.action.action_id));
}

function lookupActionById(engine: WorldEngine, actionId: string): ActionSource | null {
  const buildingAction = engine.config.map.buildings
    .flatMap((building: BuildingConfig) =>
      building.actions.map((action) => ({
        type: 'building' as const,
        id: building.building_id,
        name: building.name,
        action,
      })),
    )
    .find((source) => source.action.action_id === actionId);
  if (buildingAction) {
    return buildingAction;
  }

  return (
    engine.config.map.npcs
      .flatMap((npc: NpcConfig) =>
        npc.actions.map((action) => ({
          type: 'npc' as const,
          id: npc.npc_id,
          name: npc.name,
          action,
        })),
      )
      .find((source) => source.action.action_id === actionId) ?? null
  );
}

export function getAvailableActions(engine: WorldEngine, agentId: string): { actions: AvailableActionSummary[] } {
  return {
    actions: getAvailableActionSources(engine, agentId).map(mapActionSource),
  };
}

export function validateAction(engine: WorldEngine, agentId: string, request: ActionRequest): {
  agent: JoinedAgent;
  source: ActionSource;
} {
  const agent = requireActionReadyAgent(engine, agentId);
  const action = lookupActionById(engine, request.action_id);
  if (!action) {
    throw new WorldError(400, 'action_not_found', `Unknown action: ${request.action_id}`);
  }

  const availableAction = getAvailableActionSources(engine, agentId).find(
    (candidate) => candidate.action.action_id === request.action_id,
  );
  if (!availableAction) {
    throw new WorldError(400, 'action_not_available', `Action is not currently available: ${request.action_id}`);
  }

  return {
    agent,
    source: availableAction,
  };
}

export function executeAction(engine: WorldEngine, agentId: string, request: ActionRequest): ActionResponse {
  const { agent, source } = validateAction(engine, agentId, request);
  const completesAt = Date.now() + source.action.duration_ms;

  cancelIdleReminder(engine, agentId);
  engine.timerManager.cancelByType(agentId, 'action');
  engine.state.setState(agentId, 'in_action');
  engine.timerManager.create({
    type: 'action',
    agent_ids: [agentId],
    agent_id: agentId,
    action_id: source.action.action_id,
    action_name: source.action.name,
    fires_at: completesAt,
  });

  engine.emitEvent({
    type: 'action_started',
    agent_id: agent.agent_id,
    agent_name: agent.agent_name,
    action_id: source.action.action_id,
    action_name: source.action.name,
    completes_at: completesAt,
  });

  return {
    action_id: source.action.action_id,
    action_name: source.action.name,
    completes_at: completesAt,
  };
}

export function cancelActiveAction(engine: WorldEngine, agentId: string): ActionTimer | null {
  const timer = engine.timerManager.find(
    (candidate): candidate is ActionTimer => candidate.type === 'action' && candidate.agent_id === agentId,
  );
  if (!timer) {
    return null;
  }

  engine.timerManager.cancel(timer.timer_id);
  const agent = engine.state.getJoined(agentId);
  if (agent && agent.state === 'in_action') {
    engine.state.setState(agentId, 'idle');
  }

  return timer;
}

export function handleActionCompleted(engine: WorldEngine, timer: ActionTimer): void {
  const agent = engine.state.getJoined(timer.agent_id);
  if (!agent) {
    return;
  }

  const source = lookupActionById(engine, timer.action_id);
  if (!source) {
    return;
  }

  engine.state.setState(timer.agent_id, 'idle');
  startIdleReminder(engine, timer.agent_id);
  engine.emitEvent({
    type: 'action_completed',
    agent_id: agent.agent_id,
    agent_name: agent.agent_name,
    action_id: source.action.action_id,
    action_name: source.action.name,
    result_description: source.action.result_description,
  });
}
