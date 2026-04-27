import type { WorldEngine } from '../engine/world-engine.js';
import type { NotificationAcceptedResponse, UseItemRequest } from '../types/api.js';
import { WorldError, createNotificationAcceptedResponse } from '../types/api.js';
import type { ItemType } from '../types/data-model.js';
import type { ItemUseTimer } from '../types/timer.js';
import { requireActionableAgent } from './agent-guards.js';
import { cancelIdleReminder, startIdleReminder } from './idle-reminder.js';
import { consumeItems } from './inventory.js';

const DEFAULT_ITEM_USE_DURATION_MS = 600000;

function getItemUseDurationMs(engine: WorldEngine): number {
  return engine.config.economy?.item_use_duration_ms ?? DEFAULT_ITEM_USE_DURATION_MS;
}

export interface ValidatedUseItem {
  agent_id: string;
  agent_name: string;
  item_id: string;
  item_name: string;
  item_type: ItemType;
}

function summarizeConsumedItem(itemId: string): string {
  return `${itemId}x1`;
}

function resolveVenueHints(engine: WorldEngine, itemId: string): string[] {
  const hints: string[] = [];
  for (const building of engine.config.map.buildings) {
    for (const action of building.actions) {
      if (action.required_items?.some((item) => item.item_id === itemId)) {
        const doors = building.door_nodes.join(', ');
        hints.push(`${building.name}(入口: ${doors})`);
        break;
      }
    }
  }
  for (const npc of engine.config.map.npcs) {
    for (const action of npc.actions) {
      if (action.required_items?.some((item) => item.item_id === itemId)) {
        hints.push(`${npc.name}(${npc.node_id})`);
        break;
      }
    }
  }
  return hints;
}

export function validateUseItem(
  engine: WorldEngine,
  agentId: string,
  request: UseItemRequest,
): ValidatedUseItem {
  const agent = requireActionableAgent(engine, agentId, { activityLabel: 'use items' });

  const held = agent.items.find((item) => item.item_id === request.item_id && item.quantity > 0);
  if (!held) {
    throw new WorldError(400, 'invalid_request', `Agent does not have item: ${request.item_id}`);
  }

  const itemConfig = (engine.config.items ?? []).find((item) => item.item_id === request.item_id);
  if (!itemConfig) {
    console.warn(`[validateUseItem] Item config not found for "${request.item_id}", defaulting to type "general"`);
  }
  const itemName = itemConfig?.name ?? request.item_id;
  const itemType: ItemType = itemConfig?.type ?? 'general';

  return { agent_id: agentId, agent_name: agent.agent_name, item_id: request.item_id, item_name: itemName, item_type: itemType };
}

export function executeValidatedUseItem(
  engine: WorldEngine,
  validated: ValidatedUseItem,
): NotificationAcceptedResponse {
  if (validated.item_type === 'venue') {
    engine.state.clearExcludedInfoCommands(validated.agent_id);
    const venueHints = resolveVenueHints(engine, validated.item_id);
    engine.state.setLastUsedItem(validated.agent_id, validated.item_id);
    engine.emitEvent({
      type: 'item_use_venue_rejected',
      agent_id: validated.agent_id,
      agent_name: validated.agent_name,
      item_id: validated.item_id,
      item_name: validated.item_name,
      venue_hints: venueHints,
    });
    return createNotificationAcceptedResponse();
  }

  const durationMs = getItemUseDurationMs(engine);
  const completesAt = Date.now() + durationMs;

  cancelIdleReminder(engine, validated.agent_id);
  engine.timerManager.cancelByType(validated.agent_id, 'item_use');
  engine.state.setState(validated.agent_id, 'in_action');
  engine.timerManager.create({
    type: 'item_use',
    agent_ids: [validated.agent_id],
    agent_id: validated.agent_id,
    item_id: validated.item_id,
    item_name: validated.item_name,
    item_type: validated.item_type,
    fires_at: completesAt,
  });
  engine.state.clearExcludedInfoCommands(validated.agent_id);

  engine.emitEvent({
    type: 'item_use_started',
    agent_id: validated.agent_id,
    agent_name: validated.agent_name,
    item_id: validated.item_id,
    item_name: validated.item_name,
    completes_at: completesAt,
  });

  return createNotificationAcceptedResponse();
}

export function cancelActiveItemUse(engine: WorldEngine, agentId: string): ItemUseTimer | null {
  const timer = engine.timerManager.find(
    (candidate): candidate is ItemUseTimer => candidate.type === 'item_use' && candidate.agent_id === agentId,
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

export function handleItemUseCompleted(engine: WorldEngine, timer: ItemUseTimer): void {
  const agent = engine.state.getLoggedIn(timer.agent_id);
  if (!agent || agent.state !== 'in_action') {
    return;
  }

  engine.state.setItems(
    timer.agent_id,
    consumeItems(agent.items, [{ item_id: timer.item_id, quantity: 1 }]),
  );
  try {
    engine.persistLoggedInAgentState(timer.agent_id);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const summary = `エージェント状態の保存に失敗しました（agent_id=${timer.agent_id}, item_id=${timer.item_id}, items_consumed=${summarizeConsumedItem(timer.item_id)}）`;
    console.warn(`${summary}: ${errorMessage}`);
    engine.reportError(`${summary}。idle に復帰しました。原因: ${errorMessage}`);
  }

  engine.state.setState(timer.agent_id, 'idle');
  startIdleReminder(engine, timer.agent_id);
  engine.emitEvent({
    type: 'item_use_completed',
    agent_id: agent.agent_id,
    agent_name: agent.agent_name,
    item_id: timer.item_id,
    item_name: timer.item_name,
    item_type: timer.item_type,
  });
}
