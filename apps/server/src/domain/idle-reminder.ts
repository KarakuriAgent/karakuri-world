import type { WorldEngine } from '../engine/world-engine.js';
import type { IdleReminderTimer } from '../types/timer.js';

export function startIdleReminder(engine: WorldEngine, agentId: string): void {
  const config = engine.config.idle_reminder;
  if (!config) {
    return;
  }

  cancelIdleReminder(engine, agentId);
  const now = Date.now();
  engine.timerManager.create({
    type: 'idle_reminder',
    agent_ids: [agentId],
    agent_id: agentId,
    idle_since: now,
    fires_at: now + config.interval_ms,
  });
}

export function cancelIdleReminder(engine: WorldEngine, agentId: string): void {
  engine.timerManager.cancelByType(agentId, 'idle_reminder');
}

export function handleIdleReminderFired(engine: WorldEngine, timer: IdleReminderTimer): void {
  const config = engine.config.idle_reminder;
  if (!config) {
    return;
  }

  const agent = engine.state.getLoggedIn(timer.agent_id);
  if (!agent) {
    return;
  }

  // pending_conversation_id がある場合は通知せずタイマーだけ再登録する。
  // reject/timeout後にタイマーが消失しないようにするため。
  engine.timerManager.create({
    type: 'idle_reminder',
    agent_ids: [timer.agent_id],
    agent_id: timer.agent_id,
    idle_since: timer.idle_since,
    fires_at: Date.now() + config.interval_ms,
  });

  if (agent.pending_conversation_id) {
    return;
  }

  engine.emitEvent({
    type: 'idle_reminder_fired',
    agent_id: timer.agent_id,
    agent_name: agent.agent_name,
    idle_since: timer.idle_since,
  });
}
