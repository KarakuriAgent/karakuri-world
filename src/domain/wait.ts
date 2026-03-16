import type { WorldEngine } from '../engine/world-engine.js';
import type { WaitRequest, WaitResponse } from '../types/api.js';
import { WorldError } from '../types/api.js';
import type { WaitTimer } from '../types/timer.js';
import { cancelIdleReminder, startIdleReminder } from './idle-reminder.js';

export const MAX_WAIT_DURATION_MS = 3600000;

export function executeWait(engine: WorldEngine, agentId: string, request: WaitRequest): WaitResponse {
  const agent = engine.state.getLoggedIn(agentId);
  if (!agent) {
    throw new WorldError(403, 'not_logged_in', `Agent is not logged in: ${agentId}`);
  }

  if (agent.state !== 'idle' || agent.pending_conversation_id) {
    throw new WorldError(409, 'state_conflict', 'Agent cannot wait in the current state.');
  }

  if (!Number.isInteger(request.duration_ms) || request.duration_ms < 1 || request.duration_ms > MAX_WAIT_DURATION_MS) {
    throw new WorldError(400, 'invalid_request', `duration_ms must be an integer between 1 and ${MAX_WAIT_DURATION_MS}.`);
  }

  const completesAt = Date.now() + request.duration_ms;

  cancelIdleReminder(engine, agentId);
  engine.timerManager.cancelByType(agentId, 'wait');
  engine.state.setState(agentId, 'in_action');
  engine.timerManager.create({
    type: 'wait',
    agent_ids: [agentId],
    agent_id: agentId,
    duration_ms: request.duration_ms,
    fires_at: completesAt,
  });

  engine.emitEvent({
    type: 'wait_started',
    agent_id: agent.agent_id,
    agent_name: agent.agent_name,
    duration_ms: request.duration_ms,
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
