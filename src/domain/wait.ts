import type { WorldEngine } from '../engine/world-engine.js';
import type { WaitRequest, WaitResponse } from '../types/api.js';
import { WorldError } from '../types/api.js';
import type { LoggedInAgent } from '../types/agent.js';
import type { WaitTimer } from '../types/timer.js';
import { cancelIdleReminder, startIdleReminder } from './idle-reminder.js';

export const WAIT_UNIT_MS = 600000;
export const MAX_WAIT_DURATION = 6;

export function validateWait(engine: WorldEngine, agentId: string, request: WaitRequest): {
  agent: LoggedInAgent;
  duration_ms: number;
} {
  const agent = engine.state.getLoggedIn(agentId);
  if (!agent) {
    throw new WorldError(403, 'not_logged_in', `Agent is not logged in: ${agentId}`);
  }

  if (agent.active_server_event_id === null && (agent.state !== 'idle' || agent.pending_conversation_id)) {
    throw new WorldError(409, 'state_conflict', 'Agent cannot wait in the current state.');
  }

  if (!Number.isInteger(request.duration) || request.duration < 1 || request.duration > MAX_WAIT_DURATION) {
    throw new WorldError(400, 'invalid_request', `duration must be an integer between 1 and ${MAX_WAIT_DURATION}.`);
  }

  return {
    agent,
    duration_ms: request.duration * WAIT_UNIT_MS,
  };
}

export function executeWait(engine: WorldEngine, agentId: string, request: WaitRequest): WaitResponse {
  const { agent, duration_ms } = validateWait(engine, agentId, request);
  return executeValidatedWait(engine, agent, duration_ms);
}

export function executeValidatedWait(engine: WorldEngine, agent: LoggedInAgent, durationMs: number): WaitResponse {
  const completesAt = Date.now() + durationMs;

  cancelIdleReminder(engine, agent.agent_id);
  engine.timerManager.cancelByType(agent.agent_id, 'wait');
  engine.state.setState(agent.agent_id, 'in_action');
  engine.timerManager.create({
    type: 'wait',
    agent_ids: [agent.agent_id],
    agent_id: agent.agent_id,
    duration_ms: durationMs,
    fires_at: completesAt,
  });

  engine.emitEvent({
    type: 'wait_started',
    agent_id: agent.agent_id,
    agent_name: agent.agent_name,
    duration_ms: durationMs,
    completes_at: completesAt,
  });

  return { completes_at: completesAt };
}

export function cancelActiveWait(engine: WorldEngine, agentId: string): WaitTimer | null {
  const timer = engine.timerManager.find(
    (candidate): candidate is WaitTimer => candidate.type === 'wait' && candidate.agent_id === agentId,
  );
  if (!timer) {
    return null;
  }

  engine.timerManager.cancel(timer.timer_id);
  const agent = engine.state.getLoggedIn(agentId);
  if (agent && agent.state === 'in_action') {
    engine.state.setState(agentId, 'idle');
  }

  return timer;
}

export function handleWaitCompleted(engine: WorldEngine, timer: WaitTimer): void {
  const agent = engine.state.getLoggedIn(timer.agent_id);
  if (!agent) {
    return;
  }

  engine.state.setState(timer.agent_id, 'idle');
  startIdleReminder(engine, timer.agent_id);
  engine.emitEvent({
    type: 'wait_completed',
    agent_id: agent.agent_id,
    agent_name: agent.agent_name,
    duration_ms: timer.duration_ms,
  });
}
