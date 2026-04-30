import type { WorldEngine } from '../engine/world-engine.js';
import type { ActionRequest, NotificationAcceptedResponse } from '../types/api.js';
import { WorldError, createNotificationAcceptedResponse } from '../types/api.js';
import type { AgentItem, LoggedInAgent } from '../types/agent.js';
import type { ActionConfig, BuildingConfig, ItemConfig, NpcConfig } from '../types/data-model.js';
import type { ActionTimer } from '../types/timer.js';
import { requireActionableAgent } from './agent-guards.js';
import { cancelIdleReminder, startIdleReminder } from './idle-reminder.js';
import { consumeItems, grantItems, hasRequiredItems } from './inventory.js';
import { findAdjacentNpcs, findBuildingByInteriorNode } from './map-utils.js';
import { getAgentCurrentNode } from './movement.js';
import { isWithinHours } from './time-utils.js';

export type ActionSource =
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

function summarizeAgentItems(items: ReadonlyArray<AgentItem> | undefined): string {
  if (!items || items.length === 0) {
    return 'none';
  }
  return items.map((item) => `${item.item_id}x${item.quantity}`).join(',');
}

function requireActionReadyAgent(engine: WorldEngine, agentId: string): LoggedInAgent {
  return requireActionableAgent(engine, agentId, { activityLabel: 'execute an action' });
}

function toAgentItems(items: ActionConfig['required_items'] | undefined): AgentItem[] | undefined {
  return items?.map((item) => ({ item_id: item.item_id, quantity: item.quantity }));
}

function resolveDurationMs(action: ActionConfig, durationMinutes?: number): number {
  if (action.duration_ms !== undefined) {
    return action.duration_ms;
  }

  if (durationMinutes === undefined || !Number.isInteger(durationMinutes)) {
    throw new WorldError(
      400,
      'invalid_request',
      `duration_minutes is required for action "${action.action_id}" and must be an integer.`,
    );
  }

  if (durationMinutes < action.min_duration_minutes || durationMinutes > action.max_duration_minutes) {
    throw new WorldError(
      400,
      'invalid_request',
      `duration_minutes must be between ${action.min_duration_minutes} and ${action.max_duration_minutes}.`,
    );
  }

  return durationMinutes * 60_000;
}

function formatRequiredItems(items: ReadonlyArray<AgentItem> | undefined, itemConfigs: ReadonlyArray<ItemConfig>): string {
  if (!items || items.length === 0) {
    return '';
  }

  const itemNames = new Map(itemConfigs.map((item) => [item.item_id, item.name]));
  return items
    .map((item) => `${itemNames.get(item.item_id) ?? item.item_id}×${item.quantity}`)
    .join(', ');
}

export function formatActionSourceLine(source: ActionSource, itemConfigs: ReadonlyArray<ItemConfig> = []): string {
  const durationText =
    source.action.duration_ms !== undefined
      ? `${Math.floor(source.action.duration_ms / 1000)}秒`
      : `${source.action.min_duration_minutes}〜${source.action.max_duration_minutes}分, duration_minutes: 分数を指定`;
  const details = [`action_id: ${source.action.action_id}`, durationText];
  if (source.action.cost_money !== undefined) {
    details.push(`${source.action.cost_money.toLocaleString('ja-JP')}円`);
  }
  if (source.action.reward_money !== undefined) {
    details.push(`報酬: ${source.action.reward_money.toLocaleString('ja-JP')}円`);
  }
  const requiredItems = formatRequiredItems(toAgentItems(source.action.required_items), itemConfigs);
  if (requiredItems) {
    details.push(`必要: ${requiredItems}`);
  }
  return `${source.action.name} (${details.join(', ')}) - ${source.name}`;
}

function isActionSourceAvailable(engine: WorldEngine, source: ActionSource, now: Date): boolean {
  return isWithinHours(source.action.hours, now, engine.config.timezone);
}

function isBuildingAvailable(engine: WorldEngine, building: BuildingConfig, now: Date): boolean {
  return isWithinHours(building.hours, now, engine.config.timezone);
}

function isNpcAvailable(engine: WorldEngine, npc: NpcConfig, now: Date): boolean {
  return isWithinHours(npc.hours, now, engine.config.timezone);
}

export function getAvailableActionSources(engine: WorldEngine, agentId: string): ActionSource[] {
  return getAvailableActionSourcesWithOptions(engine, agentId);
}

export interface GetAvailableActionSourcesOptions {
  excluded_action_ids?: readonly string[];
}

export function getAvailableActionSourcesWithOptions(
  engine: WorldEngine,
  agentId: string,
  options: GetAvailableActionSourcesOptions = {},
): ActionSource[] {
  const agent = engine.state.getLoggedIn(agentId);
  if (!agent) {
    throw new WorldError(403, 'not_logged_in', `Agent is not logged in: ${agentId}`);
  }

  const now = new Date();
  const sources: ActionSource[] = [];
  const currentNodeId = getAgentCurrentNode(engine, agent);
  const building = findBuildingByInteriorNode(currentNodeId, engine.config.map);
  if (building && isBuildingAvailable(engine, building, now)) {
    sources.push(
      ...building.actions
        .map((action) => ({
          type: 'building' as const,
          id: building.building_id,
          name: building.name,
          action,
        }))
        .filter((source) => isActionSourceAvailable(engine, source, now)),
    );
  }

  sources.push(
    ...findAdjacentNpcs(currentNodeId, engine.config.map)
      .filter((npc) => isNpcAvailable(engine, npc, now))
      .flatMap((npc) =>
        npc.actions
          .map((action) => ({
            type: 'npc' as const,
            id: npc.npc_id,
            name: npc.name,
            action,
          }))
          .filter((source) => isActionSourceAvailable(engine, source, now)),
      ),
  );

  const excludedActionIds = new Set(options.excluded_action_ids ?? []);
  return sources
    .filter(
      (source) =>
        source.action.action_id !== agent.last_action_id
        && !excludedActionIds.has(source.action.action_id),
    )
    .sort((left, right) => left.action.action_id.localeCompare(right.action.action_id));
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

export function validateAction(
  engine: WorldEngine,
  agentId: string,
  request: ActionRequest,
):
  | {
      agent: LoggedInAgent;
      source: ActionSource;
      duration_ms: number;
      rejected?: false;
    }
  | {
      agent: LoggedInAgent;
      source: ActionSource;
      rejected: true;
      rejection_reason: string;
    } {
  const agent = requireActionReadyAgent(engine, agentId);
  const action = lookupActionById(engine, request.action_id);
  if (!action) {
    throw new WorldError(400, 'action_not_found', `Unknown action: ${request.action_id}`);
  }

  const availableAction = getAvailableActionSourcesWithOptions(engine, agentId).find(
    (candidate) => candidate.action.action_id === request.action_id,
  );
  if (!availableAction) {
    throw new WorldError(400, 'action_not_available', `Action is not currently available: ${request.action_id}`);
  }

  const durationMs = resolveDurationMs(availableAction.action, request.duration_minutes);

  if ((availableAction.action.cost_money ?? 0) > agent.money) {
    return {
      agent,
      source: availableAction,
      rejected: true,
      rejection_reason: `所持金が足りません（必要: ${(availableAction.action.cost_money ?? 0).toLocaleString('ja-JP')}円、所持金: ${agent.money.toLocaleString('ja-JP')}円）`,
    };
  }

  if (!hasRequiredItems(agent.items, availableAction.action.required_items)) {
    const requiredItems = formatRequiredItems(toAgentItems(availableAction.action.required_items), engine.config.items ?? []);
    return {
      agent,
      source: availableAction,
      rejected: true,
      rejection_reason: `必要なアイテムが足りません（必要: ${requiredItems}）`,
    };
  }

  return {
    agent,
    source: availableAction,
    duration_ms: durationMs,
  };
}

export function executeValidatedAction(
  engine: WorldEngine,
  agent: LoggedInAgent,
  source: ActionSource,
  durationMs: number,
): NotificationAcceptedResponse {
  const completesAt = Date.now() + durationMs;
  const costMoney = source.action.cost_money ?? 0;
  const itemsConsumed = toAgentItems(source.action.required_items) ?? [];

  if (costMoney > 0) {
    engine.state.addMoney(agent.agent_id, -costMoney);
  }
  if (itemsConsumed.length > 0) {
    engine.state.setItems(agent.agent_id, consumeItems(agent.items, source.action.required_items));
  }
  if (costMoney > 0 || itemsConsumed.length > 0) {
    try {
      engine.persistLoggedInAgentState(agent.agent_id);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const summary = `エージェント状態の保存に失敗しました（agent_id=${agent.agent_id}, action_id=${source.action.action_id}, cost_money=${costMoney}, items_consumed=${summarizeAgentItems(itemsConsumed)}）`;
      console.warn(`${summary}: ${errorMessage}`);
      engine.reportError(`${summary}。アクションは続行します。原因: ${errorMessage}`);
    }
  }

  cancelIdleReminder(engine, agent.agent_id);
  engine.timerManager.cancelByType(agent.agent_id, 'action');
  engine.state.setState(agent.agent_id, 'in_action');
  engine.timerManager.create({
    type: 'action',
    agent_ids: [agent.agent_id],
    agent_id: agent.agent_id,
    action_id: source.action.action_id,
    action_name: source.action.name,
    duration_ms: durationMs,
    fires_at: completesAt,
  });
  engine.state.clearExcludedInfoCommands(agent.agent_id);
  engine.state.setLastAction(agent.agent_id, source.action.action_id);
  engine.state.setLastUsedItem(agent.agent_id, null);

  engine.emitEvent({
    type: 'action_started',
    agent_id: agent.agent_id,
    agent_name: agent.agent_name,
    action_id: source.action.action_id,
    action_name: source.action.name,
    duration_ms: durationMs,
    completes_at: completesAt,
    ...(costMoney > 0 ? { cost_money: costMoney } : {}),
    ...(itemsConsumed.length > 0 ? { items_consumed: itemsConsumed } : {}),
  });

  return createNotificationAcceptedResponse();
}

export function cancelActiveAction(engine: WorldEngine, agentId: string): ActionTimer | null {
  const timer = engine.timerManager.find(
    (candidate): candidate is ActionTimer => candidate.type === 'action' && candidate.agent_id === agentId,
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

export function handleActionCompleted(engine: WorldEngine, timer: ActionTimer): void {
  const agent = engine.state.getLoggedIn(timer.agent_id);
  if (!agent) {
    return;
  }

  const source = lookupActionById(engine, timer.action_id);
  if (!source) {
    const message = `Action config not found for completed action: ${timer.action_id} (agent: ${timer.agent_id}). Recovering to idle.`;
    console.warn(message);
    engine.reportError(`アクション設定が見つかりません: ${timer.action_id} (agent: ${timer.agent_id})。idle に復帰しました。`);
    engine.state.setState(timer.agent_id, 'idle');
    startIdleReminder(engine, timer.agent_id);
    return;
  }

  const rewardMoney = source.action.reward_money ?? 0;
  if (rewardMoney > 0) {
    engine.state.addMoney(timer.agent_id, rewardMoney);
  }

  const granted = grantItems(
    agent.items,
    source.action.reward_items,
    engine.config.items ?? [],
    engine.config.economy?.max_inventory_slots,
  );
  if ((source.action.reward_items?.length ?? 0) > 0) {
    engine.state.setItems(timer.agent_id, granted.items);
  }
  if (rewardMoney > 0 || (source.action.reward_items?.length ?? 0) > 0) {
    try {
      engine.persistLoggedInAgentState(timer.agent_id);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const summary = `エージェント状態の保存に失敗しました（agent_id=${timer.agent_id}, action_id=${timer.action_id}, reward_money=${rewardMoney}, items_granted=${summarizeAgentItems(granted.granted)}, items_dropped=${summarizeAgentItems(granted.dropped)}）`;
      console.warn(`${summary}: ${errorMessage}`);
      engine.reportError(`${summary}。idle に復帰しました。原因: ${errorMessage}`);
    }
  }

  const updatedAgent = engine.state.getLoggedIn(timer.agent_id);
  if (!updatedAgent) {
    return;
  }

  engine.state.setState(timer.agent_id, 'idle');
  startIdleReminder(engine, timer.agent_id);
  engine.emitEvent({
    type: 'action_completed',
    agent_id: updatedAgent.agent_id,
    agent_name: updatedAgent.agent_name,
    action_id: source.action.action_id,
    action_name: source.action.name,
    ...(source.action.cost_money !== undefined || rewardMoney > 0
      ? {
          ...(source.action.cost_money !== undefined ? { cost_money: source.action.cost_money } : {}),
          ...(rewardMoney > 0 ? { reward_money: rewardMoney } : {}),
          money_balance: updatedAgent.money,
        }
      : {}),
    ...(granted.granted.length > 0 ? { items_granted: granted.granted } : {}),
    ...(granted.dropped.length > 0 ? { items_dropped: granted.dropped } : {}),
  });
}
