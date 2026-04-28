import type { LoggedInAgent } from '../types/agent.js';
import type { InfoCommandChoice } from '../types/choices.js';
import type { WorldEngine } from '../engine/world-engine.js';
import { WorldError } from '../types/api.js';
import { isInTransfer } from './transfer.js';

export function requireActionableAgent(
  engine: WorldEngine,
  agentId: string,
  options: { activityLabel?: string } = {},
): LoggedInAgent {
  const agent = engine.state.getLoggedIn(agentId);
  if (!agent) {
    throw new WorldError(403, 'not_logged_in', `Agent is not logged in: ${agentId}`);
  }

  if (agent.active_server_event_id !== null) {
    return agent;
  }

  if (agent.state !== 'idle' || agent.pending_conversation_id || isInTransfer(agent)) {
    throw new WorldError(
      409,
      'state_conflict',
      `Agent cannot ${options.activityLabel ?? 'execute the requested action'} in the current state.`,
    );
  }

  return agent;
}

export function requireInfoCommandReadyAgent(
  engine: WorldEngine,
  agentId: string,
  command: InfoCommandChoice,
): LoggedInAgent {
  const agent = requireActionableAgent(engine, agentId, { activityLabel: `request ${command}` });
  if (engine.state.getExcludedInfoCommands(agentId).has(command)) {
    throw new WorldError(
      409,
      'info_already_consumed',
      `Info command ${command} is already excluded from current choices. Run an executable command first.`,
    );
  }

  return agent;
}
