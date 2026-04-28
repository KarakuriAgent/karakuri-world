import type { AgentItem } from '../types/agent.js';
import type { ItemConfig, ItemRequirement } from '../types/data-model.js';

export interface InventoryGrantResult {
  granted: AgentItem[];
  dropped: AgentItem[];
  items: AgentItem[];
}

export function mergeItems(items: AgentItem[]): AgentItem[] {
  const quantities = new Map<string, number>();
  for (const item of items) {
    quantities.set(item.item_id, (quantities.get(item.item_id) ?? 0) + item.quantity);
  }
  return [...quantities.entries()]
    .map(([item_id, quantity]) => ({ item_id, quantity }))
    .sort((left, right) => left.item_id.localeCompare(right.item_id));
}

export function countInventorySlots(items: AgentItem[], itemConfigs: ReadonlyArray<ItemConfig>): number {
  const configMap = new Map(itemConfigs.map((item) => [item.item_id, item]));
  let slots = 0;
  for (const item of items) {
    const config = configMap.get(item.item_id);
    const stackable = config?.stackable ?? true;
    slots += stackable ? 1 : item.quantity;
  }
  return slots;
}

export function hasRequiredItems(items: AgentItem[], requiredItems: ReadonlyArray<ItemRequirement> | undefined): boolean {
  if (!requiredItems || requiredItems.length === 0) {
    return true;
  }

  const quantities = new Map(items.map((item) => [item.item_id, item.quantity]));
  return requiredItems.every((requirement) => (quantities.get(requirement.item_id) ?? 0) >= requirement.quantity);
}

export function consumeItems(items: AgentItem[], requiredItems: ReadonlyArray<ItemRequirement> | undefined): AgentItem[] {
  if (!requiredItems || requiredItems.length === 0) {
    return mergeItems(items);
  }

  const quantities = new Map(items.map((item) => [item.item_id, item.quantity]));
  for (const requirement of requiredItems) {
    const remaining = (quantities.get(requirement.item_id) ?? 0) - requirement.quantity;
    if (remaining <= 0) {
      quantities.delete(requirement.item_id);
    } else {
      quantities.set(requirement.item_id, remaining);
    }
  }

  return mergeItems([...quantities.entries()].map(([item_id, quantity]) => ({ item_id, quantity })));
}

export function grantItems(
  currentItems: AgentItem[],
  rewardItems: ReadonlyArray<ItemRequirement> | undefined,
  itemConfigs: ReadonlyArray<ItemConfig>,
  maxInventorySlots?: number,
): InventoryGrantResult {
  if (!rewardItems || rewardItems.length === 0) {
    return { granted: [], dropped: [], items: mergeItems(currentItems) };
  }

  const configMap = new Map(itemConfigs.map((item) => [item.item_id, item]));
  const granted: AgentItem[] = [];
  const dropped: AgentItem[] = [];
  const working = mergeItems(currentItems);

  const addSingle = (itemId: string): void => {
    const config = configMap.get(itemId);
    const stackable = config?.stackable ?? true;
    const maxStack = stackable ? config?.max_stack ?? Number.POSITIVE_INFINITY : 1;
    const existing = working.find((item) => item.item_id === itemId);

    if (stackable && existing) {
      if (existing.quantity >= maxStack) {
        dropped.push({ item_id: itemId, quantity: 1 });
        return;
      }

      existing.quantity += 1;
      granted.push({ item_id: itemId, quantity: 1 });
      return;
    }

    const tentative = mergeItems([...working, { item_id: itemId, quantity: 1 }]);
    if (maxInventorySlots !== undefined && countInventorySlots(tentative, itemConfigs) > maxInventorySlots) {
      dropped.push({ item_id: itemId, quantity: 1 });
      return;
    }

    working.push({ item_id: itemId, quantity: 1 });
    granted.push({ item_id: itemId, quantity: 1 });
  };

  for (const reward of rewardItems) {
    for (let index = 0; index < reward.quantity; index += 1) {
      addSingle(reward.item_id);
    }
  }

  return {
    granted: mergeItems(granted),
    dropped: mergeItems(dropped),
    items: mergeItems(working),
  };
}
