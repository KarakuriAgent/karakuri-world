import { randomUUID } from 'node:crypto';

import type { WorldEngine } from '../engine/world-engine.js';
import type { LoggedInAgent } from '../types/agent.js';
import { WorldError, type TransferRoleConflictReason } from '../types/api.js';
import type { ItemRequirement } from '../types/data-model.js';
import type { TransferTimer } from '../types/timer.js';
import type { TransferCancelReason, TransferMode, TransferOffer, TransferOfferStatus, TransferRejectReason } from '../types/transfer.js';
import { cancelIdleReminder, startIdleReminder } from './idle-reminder.js';
import { consumeItems, grantItems, hasRequiredItems } from './inventory.js';
import { manhattanDistance } from './map-utils.js';
import { getAgentCurrentNode } from './movement.js';

function requireLoggedInAgent(engine: WorldEngine, agentId: string): LoggedInAgent {
  const agent = engine.state.getLoggedIn(agentId);
  if (!agent) {
    throw new WorldError(403, 'not_logged_in', `Agent is not logged in: ${agentId}`);
  }
  return agent;
}

function toRequirements(items: ReadonlyArray<{ item_id: string; quantity: number }>): ItemRequirement[] {
  return items.map((item) => ({ item_id: item.item_id, quantity: item.quantity }));
}

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

export function isInTransfer(agent: Pick<LoggedInAgent, 'active_transfer_id' | 'pending_transfer_id'>): boolean {
  return agent.active_transfer_id !== null || agent.pending_transfer_id !== null;
}

export function normalizeTransferItems(items: ReadonlyArray<{ item_id: string; quantity: number }> | undefined): ItemRequirement[] {
  const quantities = new Map<string, number>();
  for (const item of items ?? []) {
    quantities.set(item.item_id, (quantities.get(item.item_id) ?? 0) + item.quantity);
  }
  return [...quantities.entries()].map(([item_id, quantity]) => ({ item_id, quantity })).sort((a, b) => a.item_id.localeCompare(b.item_id));
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
    if (agent.state !== 'idle' || agent.pending_conversation_id !== null) {
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
  itemsInput: ReadonlyArray<{ item_id: string; quantity: number }> | undefined,
  moneyInput: number | undefined,
  mode: TransferMode,
  conversationId?: string,
): { from: LoggedInAgent; to: LoggedInAgent; items: ItemRequirement[]; money: number } {
  const from = requireLoggedInAgent(engine, fromId);
  ensureTransferParticipantsAvailable(from, 'start a transfer');
  validateTransferState(engine, from, mode, conversationId);

    for (const rawItem of itemsInput ?? []) {
      if (!Number.isFinite(rawItem.quantity) || rawItem.quantity <= 0) {
        throw new WorldError(400, 'invalid_request', `Item quantity must be positive: ${rawItem.item_id}`);
      }
    }
    const items = normalizeTransferItems(itemsInput);
    const money = moneyInput ?? 0;
    if (!Number.isFinite(money) || money < 0) {
      throw new WorldError(400, 'invalid_request', 'Money must be a non-negative integer.');
    }
    if (items.length === 0 && money === 0) {
      throw new WorldError(400, 'invalid_request', 'Transfer must include at least one item or positive money.');
    }
    const itemConfigs = new Set((engine.config.items ?? []).map((item) => item.item_id));
    for (const item of items) {
      if (!itemConfigs.has(item.item_id)) {
        throw new WorldError(400, 'invalid_request', `Unknown item_id: ${item.item_id}`);
      }
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
    if (from.money < money) {
      throw new WorldError(409, 'state_conflict', '所持金が足りません。');
    }
    if (!hasRequiredItems(from.items, items)) {
      throw new WorldError(409, 'state_conflict', '必要なアイテムが足りません。');
    }
    if (to.money + money > Number.MAX_SAFE_INTEGER) {
      throw new WorldError(409, 'state_conflict', 'Target money would overflow.');
    }

  return { from, to, items, money };
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
    try {
      engine.state.setState(fromId, 'in_transfer');
      engine.state.setState(toId, 'in_transfer');
      cancelIdleReminder(engine, fromId);
      cancelIdleReminder(engine, toId);
    } catch (error) {
      // setState 系で何らかの失敗があれば role を release してから throw
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
  // J7: switch (offer.mode) で網羅型チェック (assertNever で将来 mode 追加時にビルドエラー化)
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
      // 会話モードは state を 'in_conversation' のまま維持し、transfer id のみ clear
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

export function startTransfer(
  engine: WorldEngine,
  fromId: string,
  toId: string,
  itemsInput: ReadonlyArray<{ item_id: string; quantity: number }> | undefined,
  moneyInput: number | undefined,
  mode: TransferMode,
  conversationId?: string,
): { transfer_id: string } {
  const { from, to, items, money } = validateTransfer(engine, fromId, toId, itemsInput, moneyInput, mode, conversationId);
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
        items: items.map((item) => ({ ...item })),
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
        items: items.map((item) => ({ ...item })),
        money,
        status: 'open',
        started_at: Date.now(),
        expires_at,
        mode,
      };
  engine.state.transfers.set(offer);

  const prevItems = from.items.map((item) => ({ ...item }));
  const prevMoney = from.money;
  let senderPersisted = false;
  try {
    engine.state.setItems(from.agent_id, consumeItems(from.items, items));
    consumeMoneyExact(engine, from.agent_id, money);
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
    // B4: rollback 各操作を try/catch で保護して二段例外を握りつぶさない
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
    items: items.map((item) => ({ ...item })),
    money,
    mode,
    expires_at,
  });
  if (mode === 'standalone') {
    engine.state.clearExcludedInfoCommands(from.agent_id);
  }
  return { transfer_id };
}

export function grantToReceiver(engine: WorldEngine, offer: TransferOffer) {
  return grantItems(
    requireLoggedInAgent(engine, offer.to_agent_id).items,
    toRequirements(offer.items),
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
    const prevItems = sender.items.map((item) => ({ ...item }));
    const prevMoney = sender.money;
    // grantItems を流用して max_inventory_slots / max_stack を尊重 (B1 対応)
    const grant = grantItems(
      sender.items,
      toRequirements(offer.items),
      engine.config.items ?? [],
      engine.config.economy?.max_inventory_slots,
    );
    engine.state.addMoney(sender.agent_id, offer.money);
    engine.state.setItems(sender.agent_id, grant.items);
    try {
      engine.persistLoggedInAgentState(sender.agent_id);
      return { ok: true, dropped: grant.dropped };
    } catch (error) {
      // B2: persist 失敗時は in-memory を確実に巻き戻す。R7: 元 error の情報を保存
      engine.state.setItems(sender.agent_id, prevItems);
      engine.state.setMoney(sender.agent_id, prevMoney);
      engine.reportError(`refundEscrow persist 失敗（transfer_id=${offer.transfer_id}, agent_id=${sender.agent_id}）。原因: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, reason: 'registration_writeback_failed' };
    }
  }

  try {
    engine.mergePersistedAgentInventory(offer.from_agent_id, offer.items.map((item) => ({ ...item })), offer.money);
    return { ok: true, dropped: [] };
  } catch (error) {
    // R7: ログアウト済み sender の registration writeback 失敗を観測ログに残す
    engine.reportError(`refundEscrow registration writeback 失敗（transfer_id=${offer.transfer_id}, logged_out_sender=${offer.from_agent_id}）。原因: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, reason: 'registration_writeback_failed' };
  }
}

function transitionToSettlingRefund(engine: WorldEngine, transferId: string): TransferOffer | null {
  const current = engine.state.transfers.get(transferId);
  if (!current) return null;
  if (current.status === 'refund_failed') return null;
  // R2: 既に settling_refund に他経路が遷移済みなら no-op (二度目の refundEscrow を防ぐ)。
  // 呼び出し元は null を「他経路が settling 中」として扱い、何もせず exit する
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
  dropped?: ReadonlyArray<{ item_id: string; quantity: number }>,
): void {
  engine.emitEvent({
    type: 'transfer_escrow_lost',
    transfer_id: offer.transfer_id,
    from_agent_id: offer.from_agent_id,
    from_agent_name: engine.getAgentById(offer.from_agent_id)?.agent_name ?? offer.from_agent_id,
    to_agent_id: offer.to_agent_id,
    to_agent_name: engine.getAgentById(offer.to_agent_id)?.agent_name ?? offer.to_agent_id,
    items: offer.items.map((item) => ({ ...item })),
    money: offer.money,
    mode: offer.mode,
    reason,
    ...(dropped && dropped.length > 0 ? { dropped: dropped.map((item) => ({ ...item })) } : {}),
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
      // B1: max_inventory_slots 超過分は escrow を完全には戻せていないので警告イベントを必ず emit
      emitTransferEscrowLost(engine, offer, 'inventory_overflow_on_refund', refunded.dropped);
      engine.reportError(`refundEscrow で sender のインベントリが満杯のため一部 escrow を返却できませんでした（transfer_id=${offer.transfer_id}, dropped=${JSON.stringify(refunded.dropped)}）`);
    }
    return true;
  }
  // refund 失敗時: status='refund_failed' を CAS で書き、agent state は always 復帰済み (D7)
  // R1: CAS 失敗 (他経路が同 offer を触っている等) でも emit / reportError を必ず実行する
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
    items: offer.items.map((item) => ({ ...item })),
    money: offer.money,
    mode: offer.mode,
    reason,
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
    // R9: agent role が残っている可能性があるので clearTransferState を必ず呼ぶ (idempotent)。
    // server-event 経由などで refund_failed offer に遭遇するケースを救う
    clearTransferState(engine, current);
    return { transfer_id: current.transfer_id, refund_failed: true };
  }
  const offer = transitionToSettlingRefund(engine, transferId);
  if (!offer) {
    // R2: 既に他経路が settling 中なら no-op (二度目の refundEscrow / 二重 emit を防ぐ)
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
    items: offer.items.map((item) => ({ ...item })),
    money: offer.money,
    mode: offer.mode,
    reason,
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
  // 以降の state mismatch は CAS 後なので状態巻き戻し前に必ず cancelTransfer(error) で escrow を戻す
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
    rejectTransfer(engine, transferId, byAgentId, { kind: 'inventory_full', dropped: result.dropped }, source);
    return { outcome: 'failed', failure_reason: 'overflow_inventory_full' };
  }

  const prevItems = receiver.items.map((item) => ({ ...item }));
  const prevMoney = receiver.money;
  try {
    engine.state.addMoney(byAgentId, offer.money);
    engine.state.setItems(byAgentId, result.items);
    engine.persistLoggedInAgentState(byAgentId);
  } catch {
    // A2: receiver memory rollback してから cancelTransfer(error) に委譲、escrow を確実に sender に戻す
    engine.state.setItems(byAgentId, prevItems);
    engine.state.setMoney(byAgentId, prevMoney);
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
  engine.emitEvent({
    type: 'transfer_accepted',
    transfer_id: offer.transfer_id,
    from_agent_id: offer.from_agent_id,
    from_agent_name: engine.getAgentById(offer.from_agent_id)?.agent_name ?? offer.from_agent_id,
    to_agent_id: offer.to_agent_id,
    to_agent_name: engine.getAgentById(offer.to_agent_id)?.agent_name ?? offer.to_agent_id,
    items: offer.items.map((item) => ({ ...item })),
    money: offer.money,
    mode: offer.mode,
    items_granted: result.granted,
    items_dropped: [],
    money_received: offer.money,
    from_money_balance: sender?.money,
    to_money_balance: updatedReceiver.money,
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
    // status='settling_*' か 'refund_failed' の場合は別経路で処理中/処理済み (silent return ではなく観測ログ)
    engine.reportError(`handleTransferTimeout が status=${current.status} の transfer に発火しました（transfer_id=${timer.transfer_id}）。別経路で処理されている可能性があります。`);
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
    items: offer.items.map((item) => ({ ...item })),
    money: offer.money,
    mode: offer.mode,
    // R8: refund 失敗時に transfer_timeout 観測者が完了と誤認しないようフラグを立てる
    ...(refundOk ? {} : { refund_failed: true }),
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

/**
 * B5 / R5: logout 時に refund_failed 状態の offer を registration writeback で再試行し、
 * 成功すれば transfers store から削除する。失敗時は offer をそのまま残し、
 * admin の force-refund 復旧経路に委ねる。dangling offer が transfers map に
 * 永続滞留するのを防ぐ。
 *
 * 各 offer のループは catch を持って完了を保証する (途中失敗で残り offer を
 * 取りこぼさない)。失敗時は transfer_escrow_lost を emit して
 * 観測経路を確保する。
 */
export function recoverRefundFailedTransfersForAgent(engine: WorldEngine, agentId: string): void {
  const offers = [...engine.state.transfers.listByAgent(agentId)].filter(
    (offer) => offer.status === 'refund_failed' && offer.from_agent_id === agentId,
  );
  for (const offer of offers) {
    try {
      engine.mergePersistedAgentInventory(
        offer.from_agent_id,
        offer.items.map((item) => ({ ...item })),
        offer.money,
      );
      // R5 / 問題2: store 削除前に clearTransferState を呼んで agent role を解放 (idempotent)
      clearTransferState(engine, offer);
      engine.state.transfers.delete(offer.transfer_id);
      engine.reportError(`refund_failed transfer ${offer.transfer_id} を logout 時に registration へ復旧しました。`);
    } catch (error) {
      // R5 / R7: 個別 offer の復旧失敗は continue して残り offer を取りこぼさない。
      // 観測経路として transfer_escrow_lost を emit し直し、Sentry にも詳細を残す
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
