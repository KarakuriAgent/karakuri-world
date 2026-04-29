import { randomUUID } from 'node:crypto';

import type { WorldEngine } from '../engine/world-engine.js';
import type { AgentItem, LoggedInAgent } from '../types/agent.js';
import { WorldError, type TransferRoleConflictReason } from '../types/api.js';
import type { ItemRequirement } from '../types/data-model.js';
import type { TransferTimer } from '../types/timer.js';
import type { TransferCancelReason, TransferMode, TransferOffer, TransferOfferStatus, TransferRejectReason } from '../types/transfer.js';
import { cancelActiveAction } from './actions.js';
import { cancelIdleReminder, startIdleReminder } from './idle-reminder.js';
import { consumeItems, grantItems, hasRequiredItems } from './inventory.js';
import { manhattanDistance } from './map-utils.js';
import { getAgentCurrentNode } from './movement.js';
import { cancelActiveItemUse } from './use-item.js';
import { cancelActiveWait } from './wait.js';

/** transfer の payload を「アイテム1種類」または「金額」のどちらかに正規化した内部表現。 */
export type TransferPayload =
  | { kind: 'item'; item: ItemRequirement }
  | { kind: 'money'; money: number };

/**
 * API 層の `{ item?, money? }` 形（schema validation 済み）を domain 層の `TransferPayload` に変換する。
 * schema が排他を保証している前提で、両方未指定／両方指定はランタイム例外。
 */
export function toTransferPayload(input: { item?: { item_id: string; quantity: number }; money?: number }): TransferPayload {
  if (input.item !== undefined && input.money !== undefined) {
    throw new WorldError(400, 'invalid_request', 'item と money は同時に指定できません。');
  }
  if (input.item !== undefined) {
    return { kind: 'item', item: { item_id: input.item.item_id, quantity: input.item.quantity } };
  }
  if (input.money !== undefined) {
    return { kind: 'money', money: input.money };
  }
  throw new WorldError(400, 'invalid_request', 'item または money のいずれかを指定してください。');
}

function requireLoggedInAgent(engine: WorldEngine, agentId: string): LoggedInAgent {
  const agent = engine.state.getLoggedIn(agentId);
  if (!agent) {
    throw new WorldError(403, 'not_logged_in', `Agent is not logged in: ${agentId}`);
  }
  return agent;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

export function isInTransfer(agent: Pick<LoggedInAgent, 'active_transfer_id' | 'pending_transfer_id'>): boolean {
  return agent.active_transfer_id !== null || agent.pending_transfer_id !== null;
}

function offerItemRequirements(offer: TransferOffer): ItemRequirement[] {
  return offer.item ? [{ item_id: offer.item.item_id, quantity: offer.item.quantity }] : [];
}

function findTransferTimer(engine: WorldEngine, transferId: string): TransferTimer | null {
  return engine.timerManager.find((timer): timer is TransferTimer => timer.type === 'transfer' && timer.transfer_id === transferId) ?? null;
}

export function transitionTransferStatus(
  engine: WorldEngine,
  transferId: string,
  from: TransferOfferStatus,
  to: TransferOfferStatus,
): TransferOffer {
  const offer = engine.state.transfers.get(transferId);
  if (!offer || offer.status !== from) {
    throw new WorldError(409, 'state_conflict', 'Transfer is no longer available.');
  }
  offer.status = to;
  return offer;
}

function ensureTransferParticipantsAvailable(agent: LoggedInAgent, label: string): void {
  if (isInTransfer(agent)) {
    throw new WorldError(409, 'state_conflict', `Agent cannot ${label} while another transfer is pending.`);
  }
}

function validateTransferState(engine: WorldEngine, agent: LoggedInAgent, mode: TransferMode, conversationId?: string): void {
  if (mode === 'standalone') {
    const allowedStates: ReadonlyArray<LoggedInAgent['state']> = ['idle', 'in_action'];
    if (!allowedStates.includes(agent.state) || agent.pending_conversation_id !== null) {
      throw new WorldError(409, 'state_conflict', 'Agent cannot start a transfer right now.');
    }
    return;
  }

  if (agent.state !== 'in_conversation' || agent.current_conversation_id !== conversationId) {
    throw new WorldError(409, 'state_conflict', 'Agent is not in the expected conversation.');
  }
  const conversation = conversationId ? engine.state.conversations.get(conversationId) : null;
  if (!conversation) {
    throw new WorldError(400, 'conversation_not_found', 'Conversation not found.');
  }
  if (conversation.status === 'closing') {
    throw new WorldError(409, 'conversation_closing', 'Conversation is already closing.');
  }
}

export function validateTransfer(
  engine: WorldEngine,
  fromId: string,
  toId: string,
  payload: TransferPayload,
  mode: TransferMode,
  conversationId?: string,
): { from: LoggedInAgent; to: LoggedInAgent; item: ItemRequirement | null; money: number } {
  const from = requireLoggedInAgent(engine, fromId);
  ensureTransferParticipantsAvailable(from, 'start a transfer');
  validateTransferState(engine, from, mode, conversationId);

  let item: ItemRequirement | null = null;
  let money = 0;
  if (payload.kind === 'item') {
    if (!Number.isFinite(payload.item.quantity) || payload.item.quantity <= 0) {
      throw new WorldError(400, 'invalid_request', `Item quantity must be positive: ${payload.item.item_id}`);
    }
    const itemConfigs = new Set((engine.config.items ?? []).map((cfg) => cfg.item_id));
    if (!itemConfigs.has(payload.item.item_id)) {
      throw new WorldError(400, 'invalid_request', `Unknown item_id: ${payload.item.item_id}`);
    }
    item = { item_id: payload.item.item_id, quantity: payload.item.quantity };
  } else {
    if (!Number.isInteger(payload.money) || payload.money <= 0) {
      throw new WorldError(400, 'invalid_request', 'Money must be a positive integer.');
    }
    money = payload.money;
  }

  if (toId === fromId) {
    throw new WorldError(400, 'invalid_request', 'Cannot transfer to self.');
  }
  const to = requireLoggedInAgent(engine, toId);
  ensureTransferParticipantsAvailable(to, 'receive a transfer');
  validateTransferState(engine, to, mode, conversationId);

  if (manhattanDistance(getAgentCurrentNode(engine, from), getAgentCurrentNode(engine, to)) > 1) {
    throw new WorldError(400, 'out_of_range', 'Target agent is out of range.');
  }
  if (money > 0 && from.money < money) {
    throw new WorldError(409, 'state_conflict', '所持金が足りません。');
  }
  if (item && !hasRequiredItems(from.items, [item])) {
    throw new WorldError(409, 'state_conflict', '必要なアイテムが足りません。');
  }
  if (money > 0 && to.money + money > Number.MAX_SAFE_INTEGER) {
    throw new WorldError(409, 'state_conflict', 'Target money would overflow.');
  }

  return { from, to, item, money };
}

function detectRoleConflict(from: LoggedInAgent, to: LoggedInAgent): TransferRoleConflictReason | null {
  if (from.active_transfer_id !== null) return 'sender_active_transfer_id_set';
  if (from.pending_transfer_id !== null) return 'sender_pending_transfer_id_set';
  if (to.active_transfer_id !== null) return 'receiver_active_transfer_id_set';
  if (to.pending_transfer_id !== null) return 'receiver_pending_transfer_id_set';
  return null;
}

function safeReleaseSenderRole(engine: WorldEngine, fromId: string): void {
  try {
    engine.state.setActiveTransfer(fromId, null);
  } catch (rollbackError) {
    engine.reportError(`acquireTransferRolesPair の sender rollback に失敗しました（agent_id=${fromId}）。原因: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
  }
}

export function acquireTransferRolesPair(
  engine: WorldEngine,
  fromId: string,
  toId: string,
  transferId: string,
  mode: TransferMode,
): void {
  const from = requireLoggedInAgent(engine, fromId);
  const to = requireLoggedInAgent(engine, toId);
  const conflict = detectRoleConflict(from, to);
  if (conflict !== null) {
    throw new WorldError(409, 'transfer_role_conflict', 'Transfer role conflict.', { conflict_reason: conflict });
  }

  engine.state.setActiveTransfer(fromId, transferId);
  try {
    engine.state.setPendingTransfer(toId, transferId);
  } catch (error) {
    safeReleaseSenderRole(engine, fromId);
    throw error;
  }

  if (mode === 'standalone') {
    // setState や cancel が途中で失敗したときに巻き戻すため、ここで触る前の state を保存しておく。
    const prevFromState = from.state;
    const prevToState = to.state;
    let setFromInTransfer = false;
    let setToInTransfer = false;
    try {
      engine.state.setState(fromId, 'in_transfer');
      setFromInTransfer = true;
      engine.state.setState(toId, 'in_transfer');
      setToInTransfer = true;
      cancelIdleReminder(engine, fromId);
      cancelIdleReminder(engine, toId);
      // in_action（wait/action/use-item）から transfer に引き込まれた側は進行中の活動を中断する。
      // setState を先に済ませてあるため、cancelActive* は timer のみ解除し、state を idle に戻さない。
      cancelActiveWait(engine, fromId);
      cancelActiveAction(engine, fromId);
      cancelActiveItemUse(engine, fromId);
      cancelActiveWait(engine, toId);
      cancelActiveAction(engine, toId);
      cancelActiveItemUse(engine, toId);
    } catch (error) {
      // setState を進めた分だけ巻き戻す。cancelActive* が走った後に失敗した場合、進行中だった timer は
      // すでに解除されているため再開はしない（conversation accept フローと同じ割り切り）。
      if (setFromInTransfer) {
        try {
          engine.state.setState(fromId, prevFromState);
          if (prevFromState === 'idle') {
            startIdleReminder(engine, fromId);
          }
        } catch (rollbackError) {
          engine.reportError(`acquireTransferRolesPair の sender state rollback に失敗しました（agent_id=${fromId}）。原因: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      if (setToInTransfer) {
        try {
          engine.state.setState(toId, prevToState);
          if (prevToState === 'idle') {
            startIdleReminder(engine, toId);
          }
        } catch (rollbackError) {
          engine.reportError(`acquireTransferRolesPair の receiver state rollback に失敗しました（agent_id=${toId}）。原因: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      safeReleaseSenderRole(engine, fromId);
      try {
        engine.state.setPendingTransfer(toId, null);
      } catch (rollbackError) {
        engine.reportError(`acquireTransferRolesPair の receiver rollback に失敗しました（agent_id=${toId}）。原因: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      throw error;
    }
  }
}

export function clearTransferState(engine: WorldEngine, offer: TransferOffer): void {
  switch (offer.mode) {
    case 'standalone': {
      const sender = engine.state.getLoggedIn(offer.from_agent_id);
      if (sender?.active_transfer_id === offer.transfer_id) {
        engine.state.setActiveTransfer(sender.agent_id, null);
        if (sender.state === 'in_transfer') {
          engine.state.setState(sender.agent_id, 'idle');
          startIdleReminder(engine, sender.agent_id);
        }
      }
      const receiver = engine.state.getLoggedIn(offer.to_agent_id);
      if (receiver?.pending_transfer_id === offer.transfer_id) {
        engine.state.setPendingTransfer(receiver.agent_id, null);
        if (receiver.state === 'in_transfer') {
          engine.state.setState(receiver.agent_id, 'idle');
          startIdleReminder(engine, receiver.agent_id);
        }
      }
      return;
    }
    case 'in_conversation': {
      const sender = engine.state.getLoggedIn(offer.from_agent_id);
      if (sender?.active_transfer_id === offer.transfer_id) {
        engine.state.setActiveTransfer(sender.agent_id, null);
      }
      const receiver = engine.state.getLoggedIn(offer.to_agent_id);
      if (receiver?.pending_transfer_id === offer.transfer_id) {
        engine.state.setPendingTransfer(receiver.agent_id, null);
      }
      return;
    }
    default:
      assertNever(offer);
  }
}

export function releaseTransferRoles(engine: WorldEngine, offer: TransferOffer): void {
  clearTransferState(engine, offer);
}

export function consumeMoneyExact(engine: WorldEngine, agentId: string, amount: number): void {
  const agent = requireLoggedInAgent(engine, agentId);
  if (agent.money < amount) {
    throw new WorldError(409, 'state_conflict', '所持金が足りません。');
  }
  engine.state.setMoney(agentId, agent.money - amount);
}

function cloneItem(item: ItemRequirement | null): AgentItem | null {
  return item ? { item_id: item.item_id, quantity: item.quantity } : null;
}

export function startTransfer(
  engine: WorldEngine,
  fromId: string,
  toId: string,
  payload: TransferPayload,
  mode: TransferMode,
  conversationId?: string,
): { transfer_id: string } {
  const { from, to, item, money } = validateTransfer(engine, fromId, toId, payload, mode, conversationId);
  const transfer_id = `transfer-${randomUUID()}`;
  acquireTransferRolesPair(engine, from.agent_id, to.agent_id, transfer_id, mode);
  const expires_at = Date.now() + (mode === 'in_conversation'
    ? engine.config.transfer.in_conversation_response_timeout_ms
    : engine.config.transfer.response_timeout_ms);
  const offer: TransferOffer = mode === 'in_conversation'
    ? {
        transfer_id,
        from_agent_id: from.agent_id,
        to_agent_id: to.agent_id,
        item: cloneItem(item),
        money,
        status: 'open',
        started_at: Date.now(),
        expires_at,
        mode,
        conversation_id: conversationId!,
      }
    : {
        transfer_id,
        from_agent_id: from.agent_id,
        to_agent_id: to.agent_id,
        item: cloneItem(item),
        money,
        status: 'open',
        started_at: Date.now(),
        expires_at,
        mode,
      };
  engine.state.transfers.set(offer);

  const prevItems = from.items.map((entry) => ({ ...entry }));
  const prevMoney = from.money;
  let senderPersisted = false;
  try {
    if (item) {
      engine.state.setItems(from.agent_id, consumeItems(from.items, [item]));
    }
    if (money > 0) {
      consumeMoneyExact(engine, from.agent_id, money);
    }
    engine.persistLoggedInAgentState(from.agent_id);
    senderPersisted = true;
    engine.timerManager.create({
      type: 'transfer',
      transfer_id,
      from_agent_id: from.agent_id,
      to_agent_id: to.agent_id,
      agent_ids: [from.agent_id, to.agent_id],
      fires_at: expires_at,
    });
  } catch (error) {
    try {
      engine.state.setItems(from.agent_id, prevItems);
      engine.state.setMoney(from.agent_id, prevMoney);
    } catch (rollbackError) {
      engine.reportError(`startTransfer rollback の memory 復元に失敗しました（agent_id=${from.agent_id}）。原因: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
    if (senderPersisted) {
      try {
        engine.persistLoggedInAgentState(from.agent_id);
      } catch (rollbackError) {
        engine.reportError(`startTransfer rollback の persist 復元に失敗しました（agent_id=${from.agent_id}）。原因: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    engine.state.transfers.delete(transfer_id);
    try {
      releaseTransferRoles(engine, offer);
    } catch (rollbackError) {
      engine.reportError(`startTransfer rollback の role release に失敗しました（transfer_id=${transfer_id}）。原因: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
    throw error;
  }

  engine.emitEvent({
    type: 'transfer_requested',
    transfer_id,
    from_agent_id: from.agent_id,
    from_agent_name: from.agent_name,
    to_agent_id: to.agent_id,
    to_agent_name: to.agent_name,
    item: cloneItem(item),
    money,
    mode,
    expires_at,
    ...(mode === 'in_conversation' ? { conversation_id: conversationId! } : {}),
  });
  if (mode === 'standalone') {
    engine.state.clearExcludedInfoCommands(from.agent_id);
  }
  return { transfer_id };
}

export function grantToReceiver(engine: WorldEngine, offer: TransferOffer) {
  return grantItems(
    requireLoggedInAgent(engine, offer.to_agent_id).items,
    offerItemRequirements(offer),
    engine.config.items ?? [],
    engine.config.economy?.max_inventory_slots,
  );
}

export function refundEscrow(
  engine: WorldEngine,
  offer: TransferOffer,
):
  | { ok: true; dropped: ReadonlyArray<{ item_id: string; quantity: number }> }
  | { ok: false; reason: 'registration_writeback_failed' } {
  const sender = engine.state.getLoggedIn(offer.from_agent_id);
  if (sender) {
    const prevItems = sender.items.map((entry) => ({ ...entry }));
    const prevMoney = sender.money;
    const grant = grantItems(
      sender.items,
      offerItemRequirements(offer),
      engine.config.items ?? [],
      engine.config.economy?.max_inventory_slots,
    );
    engine.state.addMoney(sender.agent_id, offer.money);
    engine.state.setItems(sender.agent_id, grant.items);
    try {
      engine.persistLoggedInAgentState(sender.agent_id);
      return { ok: true, dropped: grant.dropped };
    } catch (error) {
      engine.state.setItems(sender.agent_id, prevItems);
      engine.state.setMoney(sender.agent_id, prevMoney);
      engine.reportError(`refundEscrow persist 失敗（transfer_id=${offer.transfer_id}, agent_id=${sender.agent_id}）。原因: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, reason: 'registration_writeback_failed' };
    }
  }

  try {
    engine.mergePersistedAgentInventory(offer.from_agent_id, offerItemRequirements(offer), offer.money);
    return { ok: true, dropped: [] };
  } catch (error) {
    engine.reportError(`refundEscrow registration writeback 失敗（transfer_id=${offer.transfer_id}, logged_out_sender=${offer.from_agent_id}）。原因: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, reason: 'registration_writeback_failed' };
  }
}

function transitionToSettlingRefund(engine: WorldEngine, transferId: string): TransferOffer | null {
  const current = engine.state.transfers.get(transferId);
  if (!current) return null;
  if (current.status === 'refund_failed') return null;
  if (current.status === 'settling_refund') return null;
  if (current.status === 'open' || current.status === 'settling_accept') {
    return transitionTransferStatus(engine, transferId, current.status, 'settling_refund');
  }
  return null;
}

function emitTransferEscrowLost(
  engine: WorldEngine,
  offer: TransferOffer,
  reason: 'registration_writeback_failed' | 'inventory_overflow_on_refund',
  droppedItem?: { item_id: string; quantity: number } | null,
): void {
  engine.emitEvent({
    type: 'transfer_escrow_lost',
    transfer_id: offer.transfer_id,
    from_agent_id: offer.from_agent_id,
    from_agent_name: engine.getAgentById(offer.from_agent_id)?.agent_name ?? offer.from_agent_id,
    to_agent_id: offer.to_agent_id,
    to_agent_name: engine.getAgentById(offer.to_agent_id)?.agent_name ?? offer.to_agent_id,
    item: cloneItem(offer.item),
    money: offer.money,
    mode: offer.mode,
    reason,
    ...(droppedItem ? { dropped_item: { ...droppedItem } } : {}),
    ...(offer.mode === 'in_conversation' ? { conversation_id: offer.conversation_id } : {}),
  });
}

function finalizeRefund(
  engine: WorldEngine,
  offer: TransferOffer,
  refunded:
    | { ok: true; dropped: ReadonlyArray<{ item_id: string; quantity: number }> }
    | { ok: false; reason: 'registration_writeback_failed' },
): boolean {
  const timer = findTransferTimer(engine, offer.transfer_id);
  if (timer) {
    engine.timerManager.cancel(timer.timer_id);
  }
  clearTransferState(engine, offer);
  if (refunded.ok) {
    engine.state.transfers.delete(offer.transfer_id);
    if (refunded.dropped.length > 0) {
      const droppedItem = refunded.dropped[0] ?? null;
      emitTransferEscrowLost(engine, offer, 'inventory_overflow_on_refund', droppedItem);
      engine.reportError(`refundEscrow で sender のインベントリが満杯のため一部 escrow を返却できませんでした（transfer_id=${offer.transfer_id}, dropped=${JSON.stringify(refunded.dropped)}）`);
    }
    return true;
  }
  try {
    transitionTransferStatus(engine, offer.transfer_id, 'settling_refund', 'refund_failed');
  } catch (transitionError) {
    engine.reportError(`refund_failed への CAS が失敗しました（transfer_id=${offer.transfer_id}）。原因: ${transitionError instanceof Error ? transitionError.message : String(transitionError)}`);
  }
  emitTransferEscrowLost(engine, offer, 'registration_writeback_failed');
  engine.reportError(`refundEscrow に失敗しました（transfer_id=${offer.transfer_id}, reason=registration_writeback_failed）。admin の force-refund 復旧を待機中です。`);
  return false;
}

export function rejectTransfer(
  engine: WorldEngine,
  transferId: string,
  byAgentId: string,
  reason: TransferRejectReason,
  source: 'direct' | 'conversation' = 'direct',
): { transfer_id: string; refund_failed: boolean } {
  const current = engine.state.transfers.get(transferId);
  if (!current) {
    throw new WorldError(409, 'state_conflict', 'Transfer is no longer available.');
  }
  if (current.to_agent_id !== byAgentId) {
    throw new WorldError(403, 'not_target', 'Only the receiver can reject this transfer.');
  }
  if (current.status === 'refund_failed') {
    throw new WorldError(409, 'transfer_refund_failed', 'Transfer escrow refund failed; admin recovery required.');
  }
  if (current.mode === 'in_conversation') {
    const receiver = requireLoggedInAgent(engine, byAgentId);
    if (receiver.state !== 'in_conversation' || receiver.current_conversation_id !== current.conversation_id) {
      throw new WorldError(409, 'state_conflict', 'Receiver is not in the expected conversation.');
    }
    if (source !== 'conversation') {
      throw new WorldError(409, 'state_conflict', 'In-conversation transfers must be settled from a conversation response.');
    }
  }
  const offer = transitionToSettlingRefund(engine, transferId);
  if (!offer) {
    throw new WorldError(409, 'transfer_already_settled', 'Transfer is already being settled.');
  }
  const refunded = refundEscrow(engine, offer);
  const refundOk = finalizeRefund(engine, offer, refunded);
  engine.emitEvent({
    type: 'transfer_rejected',
    transfer_id: offer.transfer_id,
    from_agent_id: offer.from_agent_id,
    from_agent_name: engine.getAgentById(offer.from_agent_id)?.agent_name ?? offer.from_agent_id,
    to_agent_id: offer.to_agent_id,
    to_agent_name: engine.getAgentById(offer.to_agent_id)?.agent_name ?? offer.to_agent_id,
    item: cloneItem(offer.item),
    money: offer.money,
    mode: offer.mode,
    reason,
    ...(offer.mode === 'in_conversation' ? { conversation_id: offer.conversation_id } : {}),
  });
  if (offer.mode === 'standalone') {
    engine.state.clearExcludedInfoCommands(byAgentId);
  }
  return { transfer_id: offer.transfer_id, refund_failed: !refundOk };
}

export function cancelTransfer(engine: WorldEngine, transferId: string, reason: TransferCancelReason): { transfer_id: string; refund_failed: boolean; already_settling?: boolean } {
  const current = engine.state.transfers.get(transferId);
  if (!current) {
    throw new WorldError(409, 'state_conflict', 'Transfer is no longer available.');
  }
  if (current.status === 'refund_failed') {
    clearTransferState(engine, current);
    return { transfer_id: current.transfer_id, refund_failed: true };
  }
  const offer = transitionToSettlingRefund(engine, transferId);
  if (!offer) {
    return { transfer_id: current.transfer_id, refund_failed: false, already_settling: true };
  }
  const refunded = refundEscrow(engine, offer);
  const refundOk = finalizeRefund(engine, offer, refunded);
  engine.emitEvent({
    type: 'transfer_cancelled',
    transfer_id: offer.transfer_id,
    from_agent_id: offer.from_agent_id,
    from_agent_name: engine.getAgentById(offer.from_agent_id)?.agent_name ?? offer.from_agent_id,
    to_agent_id: offer.to_agent_id,
    to_agent_name: engine.getAgentById(offer.to_agent_id)?.agent_name ?? offer.to_agent_id,
    item: cloneItem(offer.item),
    money: offer.money,
    mode: offer.mode,
    reason,
    ...(offer.mode === 'in_conversation' ? { conversation_id: offer.conversation_id } : {}),
  });
  return { transfer_id: offer.transfer_id, refund_failed: !refundOk };
}

export function acceptTransfer(
  engine: WorldEngine,
  transferId: string,
  byAgentId: string,
  source: 'direct' | 'conversation' = 'direct',
):
  | { outcome: 'completed'; transfer_id: string }
  | { outcome: 'rejected'; transfer_id: string }
  | { outcome: 'failed'; failure_reason: 'persist_failed' | 'overflow_money' | 'overflow_inventory_full' } {
  const current = engine.state.transfers.get(transferId);
  const receiver = requireLoggedInAgent(engine, byAgentId);
  if (!current || current.status !== 'open' || current.to_agent_id !== byAgentId || receiver.pending_transfer_id !== transferId) {
    throw new WorldError(409, 'state_conflict', 'Transfer is no longer available.');
  }
  if (current.mode === 'in_conversation') {
    if (receiver.state !== 'in_conversation' || receiver.current_conversation_id !== current.conversation_id) {
      throw new WorldError(409, 'state_conflict', 'Receiver is not in the expected conversation.');
    }
    if (source !== 'conversation') {
      throw new WorldError(409, 'state_conflict', 'In-conversation transfers must be settled from a conversation response.');
    }
  }
  const offer = transitionTransferStatus(engine, transferId, 'open', 'settling_accept');
  if (offer.mode === 'standalone' && receiver.state !== 'in_transfer') {
    cancelTransfer(engine, transferId, 'error');
    throw new WorldError(409, 'state_conflict', 'Receiver is not ready to accept this transfer.');
  }
  if (offer.mode === 'in_conversation' && receiver.state !== 'in_conversation') {
    cancelTransfer(engine, transferId, 'error');
    throw new WorldError(409, 'state_conflict', 'Receiver is not in the expected conversation.');
  }
  if (receiver.money + offer.money > Number.MAX_SAFE_INTEGER) {
    cancelTransfer(engine, transferId, 'error');
    return { outcome: 'failed', failure_reason: 'overflow_money' };
  }
  const result = grantToReceiver(engine, offer);
  if (result.dropped.length > 0) {
    const droppedItem = result.dropped[0] ?? null;
    rejectTransfer(engine, transferId, byAgentId, { kind: 'inventory_full', dropped_item: droppedItem }, source);
    return { outcome: 'failed', failure_reason: 'overflow_inventory_full' };
  }

  const prevItems = receiver.items.map((entry) => ({ ...entry }));
  const prevMoney = receiver.money;
  try {
    engine.state.addMoney(byAgentId, offer.money);
    engine.state.setItems(byAgentId, result.items);
    engine.persistLoggedInAgentState(byAgentId);
  } catch (error) {
    engine.reportError(
      `acceptTransfer の receiver persist に失敗しました（transfer_id=${transferId}, agent_id=${byAgentId}）。原因: ${error instanceof Error ? error.message : String(error)}`,
    );
    try {
      engine.state.setItems(byAgentId, prevItems);
      engine.state.setMoney(byAgentId, prevMoney);
    } catch (rollbackError) {
      engine.reportError(
        `acceptTransfer の receiver memory rollback に失敗しました（transfer_id=${transferId}, agent_id=${byAgentId}）。原因: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    cancelTransfer(engine, transferId, 'error');
    return { outcome: 'failed', failure_reason: 'persist_failed' };
  }

  const timer = findTransferTimer(engine, transferId);
  if (timer) {
    engine.timerManager.cancel(timer.timer_id);
  }
  clearTransferState(engine, offer);
  engine.state.transfers.delete(transferId);
  const sender = engine.state.getLoggedIn(offer.from_agent_id);
  const updatedReceiver = requireLoggedInAgent(engine, byAgentId);
  const itemGranted = result.granted[0] ?? null;
  engine.emitEvent({
    type: 'transfer_accepted',
    transfer_id: offer.transfer_id,
    from_agent_id: offer.from_agent_id,
    from_agent_name: engine.getAgentById(offer.from_agent_id)?.agent_name ?? offer.from_agent_id,
    to_agent_id: offer.to_agent_id,
    to_agent_name: engine.getAgentById(offer.to_agent_id)?.agent_name ?? offer.to_agent_id,
    item: cloneItem(offer.item),
    money: offer.money,
    mode: offer.mode,
    item_granted: itemGranted ? { ...itemGranted } : null,
    item_dropped: null,
    money_received: offer.money,
    from_money_balance: sender?.money,
    to_money_balance: updatedReceiver.money,
    ...(offer.mode === 'in_conversation' ? { conversation_id: offer.conversation_id } : {}),
  });
  if (offer.mode === 'standalone') {
    engine.state.clearExcludedInfoCommands(byAgentId);
  }
  return { outcome: 'completed', transfer_id: offer.transfer_id };
}

export function handleTransferTimeout(engine: WorldEngine, timer: TransferTimer): void {
  const current = engine.state.transfers.get(timer.transfer_id);
  if (!current) {
    return;
  }
  if (current.status !== 'open') {
    // accept / reject / cancel が timer cancel 直前に割り込んだケース。escrow は別経路で処理済みなので
    // info レベルで記録するに留める（reportError に流すと benign race が毎回 Sentry alert になる）。
    console.info(
      `[transfer] handleTransferTimeout fired on non-open offer (transfer_id=${timer.transfer_id}, status=${current.status}); already handled by another path.`,
    );
    return;
  }
  const offer = transitionTransferStatus(engine, timer.transfer_id, 'open', 'settling_refund');
  const refunded = refundEscrow(engine, offer);
  const refundOk = finalizeRefund(engine, offer, refunded);
  engine.emitEvent({
    type: 'transfer_timeout',
    transfer_id: offer.transfer_id,
    from_agent_id: offer.from_agent_id,
    from_agent_name: engine.getAgentById(offer.from_agent_id)?.agent_name ?? offer.from_agent_id,
    to_agent_id: offer.to_agent_id,
    to_agent_name: engine.getAgentById(offer.to_agent_id)?.agent_name ?? offer.to_agent_id,
    item: cloneItem(offer.item),
    money: offer.money,
    mode: offer.mode,
    ...(refundOk ? {} : { refund_failed: true }),
    ...(offer.mode === 'in_conversation' ? { conversation_id: offer.conversation_id } : {}),
  });
}

export function cancelPendingTransfersForAgent(
  engine: WorldEngine,
  agentId: string,
  reasonByRole: { sender: TransferCancelReason; receiver: TransferCancelReason },
): void {
  const offers = [...engine.state.transfers.listByAgent(agentId)];
  for (const offer of offers) {
    if (offer.status === 'refund_failed') {
      clearTransferState(engine, offer);
      continue;
    }
    if (offer.from_agent_id === agentId) {
      cancelTransfer(engine, offer.transfer_id, reasonByRole.sender);
    } else if (offer.to_agent_id === agentId) {
      cancelTransfer(engine, offer.transfer_id, reasonByRole.receiver);
    }
  }
}

export function recoverRefundFailedTransfersForAgent(engine: WorldEngine, agentId: string): void {
  const offers = [...engine.state.transfers.listByAgent(agentId)].filter(
    (offer) => offer.status === 'refund_failed' && offer.from_agent_id === agentId,
  );
  for (const offer of offers) {
    try {
      engine.mergePersistedAgentInventory(
        offer.from_agent_id,
        offerItemRequirements(offer),
        offer.money,
      );
      clearTransferState(engine, offer);
      engine.state.transfers.delete(offer.transfer_id);
      // 復旧成功は info レベル。reportError 経由だと正常系イベントが Sentry に流れて誤検知の温床になる。
      console.info(`[transfer] recovered refund_failed transfer ${offer.transfer_id} into registration on logout.`);
    } catch (error) {
      engine.reportError(
        `refund_failed transfer ${offer.transfer_id} の registration 復旧に失敗しました（agent_id=${agentId}）。原因: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        emitTransferEscrowLost(engine, offer, 'registration_writeback_failed');
      } catch (emitError) {
        engine.reportError(
          `refund_failed transfer ${offer.transfer_id} の transfer_escrow_lost 再 emit に失敗しました。原因: ${emitError instanceof Error ? emitError.message : String(emitError)}`,
        );
      }
    }
  }
}
