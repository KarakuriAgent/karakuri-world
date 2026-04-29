import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acceptTransfer,
  acquireTransferRolesPair,
  cancelPendingTransfersForAgent,
  cancelTransfer,
  consumeMoneyExact,
  isInTransfer,
  recoverRefundFailedTransfersForAgent,
  refundEscrow,
  rejectTransfer,
  startTransfer,
  transitionTransferStatus,
  validateTransfer,
  type TransferPayload,
} from '../../../src/domain/transfer.js';
import { WorldError } from '../../../src/types/api.js';
import type { TransferOffer } from '../../../src/types/transfer.js';
import { createTestWorld } from '../../helpers/test-world.js';

const itemPayload = (item_id: string, quantity = 1): TransferPayload => ({ kind: 'item', item: { item_id, quantity } });
const moneyPayload = (money: number): TransferPayload => ({ kind: 'money', money });

async function setupTwoLoggedInAgents() {
  const { engine } = createTestWorld({
    config: {
      items: [
        { item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food', stackable: true },
        { item_id: 'bread', name: 'パン', description: 'パン', type: 'food', stackable: true },
      ],
    },
  });
  const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
  const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
  await engine.loginAgent(alice.agent_id);
  await engine.loginAgent(bob.agent_id);
  engine.state.setNode(alice.agent_id, '1-1');
  engine.state.setNode(bob.agent_id, '1-2');
  engine.state.setMoney(alice.agent_id, 500);
  engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 3 }]);
  return { engine, aliceId: alice.agent_id, bobId: bob.agent_id };
}

describe('transfer/isInTransfer', () => {
  it('returns true if active_transfer_id is set', () => {
    expect(isInTransfer({ active_transfer_id: 'transfer-1', pending_transfer_id: null })).toBe(true);
  });
  it('returns true if pending_transfer_id is set', () => {
    expect(isInTransfer({ active_transfer_id: null, pending_transfer_id: 'transfer-1' })).toBe(true);
  });
  it('returns false when both are null', () => {
    expect(isInTransfer({ active_transfer_id: null, pending_transfer_id: null })).toBe(false);
  });
});

describe('transfer/consumeMoneyExact', () => {
  it('throws when amount exceeds balance', async () => {
    const { engine, aliceId } = await setupTwoLoggedInAgents();
    expect(() => consumeMoneyExact(engine, aliceId, 999_999)).toThrow(WorldError);
  });
  it('subtracts exact amount on success', async () => {
    const { engine, aliceId } = await setupTwoLoggedInAgents();
    consumeMoneyExact(engine, aliceId, 200);
    expect(engine.state.getLoggedIn(aliceId)?.money).toBe(300);
  });
});

describe('transfer/transitionTransferStatus', () => {
  it('transitions open → settling_accept on CAS match', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    const result = startTransfer(engine, aliceId, bobId, itemPayload('apple', 1), 'standalone');
    const offer = transitionTransferStatus(engine, result.transfer_id, 'open', 'settling_accept');
    expect(offer.status).toBe('settling_accept');
  });

  it('throws when current status is not the expected from-status', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    const result = startTransfer(engine, aliceId, bobId, itemPayload('apple', 1), 'standalone');
    transitionTransferStatus(engine, result.transfer_id, 'open', 'settling_accept');
    expect(() => transitionTransferStatus(engine, result.transfer_id, 'open', 'settling_refund')).toThrow(WorldError);
  });

  it('throws for unknown transfer_id', async () => {
    const { engine } = await setupTwoLoggedInAgents();
    expect(() => transitionTransferStatus(engine, 'transfer-unknown', 'open', 'settling_accept')).toThrow(WorldError);
  });
});

describe('transfer/validateTransfer', () => {
  it('rejects transfer to self', async () => {
    const { engine, aliceId } = await setupTwoLoggedInAgents();
    expect(() => validateTransfer(engine, aliceId, aliceId, itemPayload('apple', 1), 'standalone'))
      .toThrow(WorldError);
  });

  it('rejects when sender is not logged in', async () => {
    const { engine, bobId } = await setupTwoLoggedInAgents();
    let captured: WorldError | null = null;
    try {
      validateTransfer(engine, 'bot-ghost', bobId, itemPayload('apple', 1), 'standalone');
    } catch (error) {
      captured = error as WorldError;
    }
    expect(captured?.code).toBe('not_logged_in');
  });

  it('rejects when target is too far', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    engine.state.setNode(bobId, '5-5');
    let captured: WorldError | null = null;
    try {
      validateTransfer(engine, aliceId, bobId, itemPayload('apple', 1), 'standalone');
    } catch (error) {
      captured = error as WorldError;
    }
    expect(captured?.code).toBe('out_of_range');
  });

  it('rejects when item quantity is non-positive', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    expect(() => validateTransfer(engine, aliceId, bobId, itemPayload('apple', 0), 'standalone'))
      .toThrow(/positive/);
  });

  it('rejects when money is non-positive', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    expect(() => validateTransfer(engine, aliceId, bobId, moneyPayload(0), 'standalone'))
      .toThrow(/positive/);
  });

  it('rejects unknown item_id', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    expect(() => validateTransfer(engine, aliceId, bobId, itemPayload('unknown', 1), 'standalone'))
      .toThrow(/Unknown item_id/);
  });

  it('rejects when sender has insufficient money', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    expect(() => validateTransfer(engine, aliceId, bobId, moneyPayload(99_999), 'standalone')).toThrow(/所持金/);
  });

  it('rejects when receiver money would overflow', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    engine.state.setMoney(bobId, Number.MAX_SAFE_INTEGER);
    engine.state.setMoney(aliceId, Number.MAX_SAFE_INTEGER);
    expect(() => validateTransfer(engine, aliceId, bobId, moneyPayload(100), 'standalone')).toThrow(/overflow/);
  });
});

describe('transfer/acquireTransferRolesPair', () => {
  it('throws transfer_role_conflict with conflict_reason when sender already in transfer', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    engine.state.setActiveTransfer(aliceId, 'transfer-other');
    let captured: WorldError | null = null;
    try {
      acquireTransferRolesPair(engine, aliceId, bobId, 'transfer-new', 'standalone');
    } catch (error) {
      captured = error as WorldError;
    }
    expect(captured).toBeInstanceOf(WorldError);
    expect(captured?.code).toBe('transfer_role_conflict');
    expect(captured?.details).toMatchObject({ conflict_reason: 'sender_active_transfer_id_set' });
    expect(engine.state.getLoggedIn(aliceId)?.active_transfer_id).toBe('transfer-other');
    expect(engine.state.getLoggedIn(bobId)?.pending_transfer_id).toBeNull();
  });

  it('reports receiver_pending_transfer_id_set when receiver already has pending', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    engine.state.setPendingTransfer(bobId, 'transfer-other');
    try {
      acquireTransferRolesPair(engine, aliceId, bobId, 'transfer-new', 'standalone');
      expect.fail('should throw');
    } catch (error) {
      expect((error as WorldError).details).toMatchObject({ conflict_reason: 'receiver_pending_transfer_id_set' });
    }
  });
});

describe('transfer/startTransfer rollback on persist failure', () => {
  it('reverts memory state and removes the offer when persist fails', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    const persistSpy = vi.spyOn(engine, 'persistLoggedInAgentState');
    persistSpy.mockImplementationOnce(() => {
      throw new Error('persist fail');
    });
    expect(() => startTransfer(engine, aliceId, bobId, itemPayload('apple', 1), 'standalone'))
      .toThrow(/persist fail/);
    expect(engine.state.getLoggedIn(aliceId)?.money).toBe(500);
    expect(engine.state.getLoggedIn(aliceId)?.items).toEqual([{ item_id: 'apple', quantity: 3 }]);
    expect(engine.state.getLoggedIn(aliceId)?.active_transfer_id).toBeNull();
    expect(engine.state.getLoggedIn(bobId)?.pending_transfer_id).toBeNull();
    expect(engine.state.transfers.list().length).toBe(0);
    persistSpy.mockRestore();
  });
});

describe('transfer/refundEscrow', () => {
  it('uses grantItems-style logic so max_inventory_slots is honored (B1)', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food', stackable: false, max_stack: 1 }],
        economy: { max_inventory_slots: 2 },
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 1 }]);
    const offer: TransferOffer = {
      transfer_id: 'transfer-test',
      from_agent_id: alice.agent_id,
      to_agent_id: bob.agent_id,
      item: { item_id: 'apple', quantity: 1 },
      money: 0,
      status: 'settling_refund',
      started_at: 0,
      expires_at: 1_000_000,
      mode: 'standalone',
    };
    // 2 slot 上限のところに 2 個の apple を積んだ後、1 個追加 refund → max_inventory_slots 超過で 1 個 dropped 確定
    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 2 }]);
    const result = refundEscrow(engine, offer);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dropped).toEqual([{ item_id: 'apple', quantity: 1 }]);
    }
  });

  it('rolls back in-memory state on persist failure (B2)', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    const offer: TransferOffer = {
      transfer_id: 'transfer-test',
      from_agent_id: aliceId,
      to_agent_id: bobId,
      item: { item_id: 'apple', quantity: 1 },
      money: 100,
      status: 'settling_refund',
      started_at: 0,
      expires_at: 1_000_000,
      mode: 'standalone',
    };
    const persistSpy = vi.spyOn(engine, 'persistLoggedInAgentState').mockImplementationOnce(() => {
      throw new Error('persist fail');
    });
    const before = engine.state.getLoggedIn(aliceId);
    const result = refundEscrow(engine, offer);
    expect(result.ok).toBe(false);
    expect(engine.state.getLoggedIn(aliceId)?.money).toBe(before?.money);
    expect(engine.state.getLoggedIn(aliceId)?.items).toEqual(before?.items);
    persistSpy.mockRestore();
  });
});

describe('transfer/acceptTransfer overflow auto-reject', () => {
  it('switches to inventory_full reject when receiver inventory overflows', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food', stackable: false, max_stack: 1 }],
        economy: { max_inventory_slots: 1 },
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 1 }]);
    engine.state.setItems(bob.agent_id, [{ item_id: 'apple', quantity: 1 }]);

    const start = startTransfer(engine, alice.agent_id, bob.agent_id, itemPayload('apple', 1), 'standalone');
    const result = acceptTransfer(engine, start.transfer_id, bob.agent_id);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure_reason).toBe('overflow_inventory_full');
    }
    const aliceItems = engine.state.getLoggedIn(alice.agent_id)?.items;
    expect(aliceItems?.find((item) => item.item_id === 'apple')?.quantity ?? 0).toBeGreaterThan(0);
  });
});

describe('transfer/in_action からの開始', () => {
  it('wait 中の sender でも validateTransfer を通過する', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    engine.executeWait(aliceId, { duration: 1 });
    expect(engine.state.getLoggedIn(aliceId)?.state).toBe('in_action');
    expect(() => validateTransfer(engine, aliceId, bobId, itemPayload('apple', 1), 'standalone'))
      .not.toThrow();
  });

  it('wait 中の receiver でも validateTransfer を通過する', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    engine.executeWait(bobId, { duration: 1 });
    expect(engine.state.getLoggedIn(bobId)?.state).toBe('in_action');
    expect(() => validateTransfer(engine, aliceId, bobId, itemPayload('apple', 1), 'standalone'))
      .not.toThrow();
  });

  it('pending_conversation_id を持つ sender は引き続き拒否される', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    engine.state.setPendingConversation(aliceId, 'conversation-x');
    let captured: WorldError | null = null;
    try {
      validateTransfer(engine, aliceId, bobId, itemPayload('apple', 1), 'standalone');
    } catch (error) {
      captured = error as WorldError;
    }
    expect(captured?.code).toBe('state_conflict');
  });

  it('moving 中の sender は拒否される', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    engine.state.setState(aliceId, 'moving');
    let captured: WorldError | null = null;
    try {
      validateTransfer(engine, aliceId, bobId, itemPayload('apple', 1), 'standalone');
    } catch (error) {
      captured = error as WorldError;
    }
    expect(captured?.code).toBe('state_conflict');
  });

  it('startTransfer は sender の wait timer をキャンセルし state を in_transfer にする', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    engine.executeWait(aliceId, { duration: 1 });
    expect(engine.timerManager.find((timer) => timer.type === 'wait' && timer.agent_id === aliceId)).toBeDefined();
    startTransfer(engine, aliceId, bobId, itemPayload('apple', 1), 'standalone');
    expect(engine.state.getLoggedIn(aliceId)?.state).toBe('in_transfer');
    expect(engine.timerManager.find((timer) => timer.type === 'wait' && timer.agent_id === aliceId)).toBeUndefined();
  });

  it('startTransfer は receiver の wait timer をキャンセルし state を in_transfer にする', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    engine.executeWait(bobId, { duration: 1 });
    expect(engine.timerManager.find((timer) => timer.type === 'wait' && timer.agent_id === bobId)).toBeDefined();
    startTransfer(engine, aliceId, bobId, itemPayload('apple', 1), 'standalone');
    expect(engine.state.getLoggedIn(bobId)?.state).toBe('in_transfer');
    expect(engine.timerManager.find((timer) => timer.type === 'wait' && timer.agent_id === bobId)).toBeUndefined();
  });

  it('startTransfer は sender / receiver の use-item timer もキャンセルする', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    engine.state.setItems(bobId, [{ item_id: 'bread', quantity: 1 }]);
    engine.useItem(aliceId, { item_id: 'apple' });
    engine.useItem(bobId, { item_id: 'bread' });
    expect(engine.timerManager.find((timer) => timer.type === 'item_use' && timer.agent_id === aliceId)).toBeDefined();
    expect(engine.timerManager.find((timer) => timer.type === 'item_use' && timer.agent_id === bobId)).toBeDefined();
    startTransfer(engine, aliceId, bobId, itemPayload('apple', 1), 'standalone');
    expect(engine.timerManager.find((timer) => timer.type === 'item_use' && timer.agent_id === aliceId)).toBeUndefined();
    expect(engine.timerManager.find((timer) => timer.type === 'item_use' && timer.agent_id === bobId)).toBeUndefined();
  });

  it('reject 後は sender / receiver が idle に戻り wait は再開しない', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    engine.executeWait(aliceId, { duration: 1 });
    engine.executeWait(bobId, { duration: 1 });
    const start = startTransfer(engine, aliceId, bobId, itemPayload('apple', 1), 'standalone');
    rejectTransfer(engine, start.transfer_id, bobId, { kind: 'rejected_by_receiver' });
    expect(engine.state.getLoggedIn(aliceId)?.state).toBe('idle');
    expect(engine.state.getLoggedIn(bobId)?.state).toBe('idle');
    expect(engine.timerManager.find((timer) => timer.type === 'wait' && timer.agent_id === aliceId)).toBeUndefined();
    expect(engine.timerManager.find((timer) => timer.type === 'wait' && timer.agent_id === bobId)).toBeUndefined();
  });
});

describe('transfer/cancelPendingTransfersForAgent', () => {
  it('cancels open offers for sender on logout (sender_logged_out reason)', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    const start = startTransfer(engine, aliceId, bobId, moneyPayload(100), 'standalone');
    cancelPendingTransfersForAgent(engine, aliceId, { sender: 'sender_logged_out', receiver: 'receiver_logged_out' });
    expect(engine.state.transfers.has(start.transfer_id)).toBe(false);
    expect(engine.state.getLoggedIn(aliceId)?.money).toBe(500);
    expect(engine.state.getLoggedIn(aliceId)?.items).toEqual([{ item_id: 'apple', quantity: 3 }]);
  });

  it('keeps refund_failed offers in store but clears agent state (B5 supports recovery)', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    const start = startTransfer(engine, aliceId, bobId, moneyPayload(100), 'standalone');
    const persistSpy = vi.spyOn(engine, 'persistLoggedInAgentState').mockImplementation(() => {
      throw new Error('persist fail');
    });
    cancelTransfer(engine, start.transfer_id, 'error');
    persistSpy.mockRestore();
    const offer = engine.state.transfers.get(start.transfer_id);
    expect(offer?.status).toBe('refund_failed');
    expect(engine.state.getLoggedIn(aliceId)?.active_transfer_id).toBeNull();
    expect(engine.state.getLoggedIn(bobId)?.pending_transfer_id).toBeNull();
  });
});

describe('transfer/recoverRefundFailedTransfersForAgent', () => {
  it('removes refund_failed offers after successful registration writeback', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    const start = startTransfer(engine, aliceId, bobId, moneyPayload(100), 'standalone');
    const persistSpy = vi.spyOn(engine, 'persistLoggedInAgentState').mockImplementation(() => {
      throw new Error('persist fail');
    });
    cancelTransfer(engine, start.transfer_id, 'error');
    persistSpy.mockRestore();
    expect(engine.state.transfers.get(start.transfer_id)?.status).toBe('refund_failed');
    recoverRefundFailedTransfersForAgent(engine, aliceId);
    expect(engine.state.transfers.has(start.transfer_id)).toBe(false);
  });
});

describe('transfer/rejectTransfer guards refund_failed', () => {
  it('throws transfer_refund_failed when offer is in refund_failed state', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    const start = startTransfer(engine, aliceId, bobId, moneyPayload(100), 'standalone');
    const persistSpy = vi.spyOn(engine, 'persistLoggedInAgentState').mockImplementation(() => {
      throw new Error('persist fail');
    });
    cancelTransfer(engine, start.transfer_id, 'error');
    persistSpy.mockRestore();
    let captured: WorldError | null = null;
    try {
      rejectTransfer(engine, start.transfer_id, bobId, { kind: 'rejected_by_receiver' });
    } catch (error) {
      captured = error as WorldError;
    }
    expect(captured?.code).toBe('transfer_refund_failed');
  });
});

describe('transfer/cancelTransfer is idempotent on refund_failed', () => {
  it('returns no-op for refund_failed offers without throw', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    const start = startTransfer(engine, aliceId, bobId, moneyPayload(100), 'standalone');
    const persistSpy = vi.spyOn(engine, 'persistLoggedInAgentState').mockImplementation(() => {
      throw new Error('persist fail');
    });
    cancelTransfer(engine, start.transfer_id, 'error');
    persistSpy.mockRestore();
    const result = cancelTransfer(engine, start.transfer_id, 'error');
    expect(result.refund_failed).toBe(true);
  });
});

describe('transfer/transfer_escrow_lost emission', () => {
  it('emits transfer_escrow_lost with reason=registration_writeback_failed when refund persist fails', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    const events: Array<{ type: string }> = [];
    engine.eventBus.onAny((event) => events.push(event));

    const start = startTransfer(engine, aliceId, bobId, moneyPayload(100), 'standalone');
    const persistSpy = vi.spyOn(engine, 'persistLoggedInAgentState').mockImplementation(() => {
      throw new Error('persist fail');
    });
    cancelTransfer(engine, start.transfer_id, 'error');
    persistSpy.mockRestore();

    const escrowLost = events.find((event) => event.type === 'transfer_escrow_lost') as
      | { type: string; reason: string; transfer_id: string }
      | undefined;
    expect(escrowLost).toBeDefined();
    expect(escrowLost?.reason).toBe('registration_writeback_failed');
    expect(escrowLost?.transfer_id).toBe(start.transfer_id);
  });

  it('emits transfer_escrow_lost with reason=inventory_overflow_on_refund and dropped_item when sender inventory overflows', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food', stackable: false, max_stack: 1 }],
        economy: { max_inventory_slots: 2 },
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 1 }]);

    const start = startTransfer(engine, alice.agent_id, bob.agent_id, itemPayload('apple', 1), 'standalone');
    // sender 側を満杯にしてから refund をトリガーする
    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 2 }]);

    const events: Array<{ type: string }> = [];
    engine.eventBus.onAny((event) => events.push(event));
    cancelTransfer(engine, start.transfer_id, 'error');

    const escrowLost = events.find((event) => event.type === 'transfer_escrow_lost') as
      | { type: string; reason: string; dropped_item?: { item_id: string; quantity: number } | null }
      | undefined;
    expect(escrowLost).toBeDefined();
    expect(escrowLost?.reason).toBe('inventory_overflow_on_refund');
    expect(escrowLost?.dropped_item).toEqual({ item_id: 'apple', quantity: 1 });
  });

  it('re-emits transfer_escrow_lost when recoverRefundFailedTransfersForAgent fails again', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    const start = startTransfer(engine, aliceId, bobId, moneyPayload(100), 'standalone');
    const persistSpy = vi.spyOn(engine, 'persistLoggedInAgentState').mockImplementation(() => {
      throw new Error('persist fail');
    });
    cancelTransfer(engine, start.transfer_id, 'error');
    persistSpy.mockRestore();

    const events: Array<{ type: string }> = [];
    engine.eventBus.onAny((event) => events.push(event));
    const mergeSpy = vi.spyOn(engine, 'mergePersistedAgentInventory').mockImplementation(() => {
      throw new Error('merge fail');
    });
    recoverRefundFailedTransfersForAgent(engine, aliceId);
    mergeSpy.mockRestore();

    const escrowLost = events.find((event) => event.type === 'transfer_escrow_lost') as
      | { type: string; reason: string }
      | undefined;
    expect(escrowLost).toBeDefined();
    expect(escrowLost?.reason).toBe('registration_writeback_failed');
    // recovery 失敗時は offer は store に残る
    expect(engine.state.transfers.has(start.transfer_id)).toBe(true);
  });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
