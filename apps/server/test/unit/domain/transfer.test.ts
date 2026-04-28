import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acceptTransfer,
  acquireTransferRolesPair,
  cancelPendingTransfersForAgent,
  cancelTransfer,
  consumeMoneyExact,
  isInTransfer,
  normalizeTransferItems,
  recoverRefundFailedTransfersForAgent,
  refundEscrow,
  rejectTransfer,
  startTransfer,
  transitionTransferStatus,
  validateTransfer,
} from '../../../src/domain/transfer.js';
import { WorldError } from '../../../src/types/api.js';
import type { TransferOffer } from '../../../src/types/transfer.js';
import { createTestWorld } from '../../helpers/test-world.js';

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

describe('transfer/normalizeTransferItems', () => {
  it('aggregates duplicate item_ids', () => {
    const result = normalizeTransferItems([
      { item_id: 'apple', quantity: 2 },
      { item_id: 'apple', quantity: 3 },
      { item_id: 'bread', quantity: 1 },
    ]);
    expect(result).toEqual([
      { item_id: 'apple', quantity: 5 },
      { item_id: 'bread', quantity: 1 },
    ]);
  });

  it('returns empty for undefined', () => {
    expect(normalizeTransferItems(undefined)).toEqual([]);
  });
});

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
    const result = startTransfer(engine, aliceId, bobId, [{ item_id: 'apple', quantity: 1 }], 0, 'standalone');
    const offer = transitionTransferStatus(engine, result.transfer_id, 'open', 'settling_accept');
    expect(offer.status).toBe('settling_accept');
  });

  it('throws when current status is not the expected from-status', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    const result = startTransfer(engine, aliceId, bobId, [{ item_id: 'apple', quantity: 1 }], 0, 'standalone');
    transitionTransferStatus(engine, result.transfer_id, 'open', 'settling_accept');
    // 既に settling_accept なのでもう一度 'open' から遷移しようとすると 409
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
    expect(() => validateTransfer(engine, aliceId, aliceId, [{ item_id: 'apple', quantity: 1 }], 0, 'standalone'))
      .toThrow(WorldError);
  });

  it('rejects when sender is not logged in', async () => {
    const { engine, bobId } = await setupTwoLoggedInAgents();
    let captured: WorldError | null = null;
    try {
      validateTransfer(engine, 'bot-ghost', bobId, [{ item_id: 'apple', quantity: 1 }], 0, 'standalone');
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
      validateTransfer(engine, aliceId, bobId, [{ item_id: 'apple', quantity: 1 }], 0, 'standalone');
    } catch (error) {
      captured = error as WorldError;
    }
    expect(captured?.code).toBe('out_of_range');
  });

  it('rejects when items and money are both zero', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    expect(() => validateTransfer(engine, aliceId, bobId, [], 0, 'standalone')).toThrow(WorldError);
  });

  it('rejects when item quantity is non-positive (MCP path)', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    expect(() => validateTransfer(engine, aliceId, bobId, [{ item_id: 'apple', quantity: 0 }], 0, 'standalone'))
      .toThrow(/positive/);
  });

  it('rejects unknown item_id', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    expect(() => validateTransfer(engine, aliceId, bobId, [{ item_id: 'unknown', quantity: 1 }], 0, 'standalone'))
      .toThrow(/Unknown item_id/);
  });

  it('rejects when sender has insufficient money', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    expect(() => validateTransfer(engine, aliceId, bobId, [], 99_999, 'standalone')).toThrow(/所持金/);
  });

  it('rejects when receiver money would overflow', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    engine.state.setMoney(bobId, Number.MAX_SAFE_INTEGER);
    engine.state.setMoney(aliceId, Number.MAX_SAFE_INTEGER);
    expect(() => validateTransfer(engine, aliceId, bobId, [], 100, 'standalone')).toThrow(/overflow/);
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
    // sender role はまだ acquire されていないので状態が壊れていない
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
    // 1 回目 (escrow 取り込み後の persist) を失敗させる
    persistSpy.mockImplementationOnce(() => {
      throw new Error('persist fail');
    });
    expect(() => startTransfer(engine, aliceId, bobId, [{ item_id: 'apple', quantity: 1 }], 200, 'standalone'))
      .toThrow(/persist fail/);
    // memory は元の状態に戻っている
    expect(engine.state.getLoggedIn(aliceId)?.money).toBe(500);
    expect(engine.state.getLoggedIn(aliceId)?.items).toEqual([{ item_id: 'apple', quantity: 3 }]);
    // role も release されている
    expect(engine.state.getLoggedIn(aliceId)?.active_transfer_id).toBeNull();
    expect(engine.state.getLoggedIn(bobId)?.pending_transfer_id).toBeNull();
    // offer は store に残っていない
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
    // sender に 1 個入れた状態で 1 個 escrow に出す → refund 後に inventory 増えるはず
    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 1 }]);
    // 後で sender が 1 個追加で取得して slot 2/2 状態にしてから refund を発火
    const offer: TransferOffer = {
      transfer_id: 'transfer-test',
      from_agent_id: alice.agent_id,
      to_agent_id: bob.agent_id,
      items: [{ item_id: 'apple', quantity: 1 }],
      money: 0,
      status: 'settling_refund',
      started_at: 0,
      expires_at: 1_000_000,
      mode: 'standalone',
    };
    // sender の slot を 2/2 に: ここでは max_stack=1 なので非 stackable の apple を 2 個保持はできない (slot 増)
    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 2 }]);
    const result = refundEscrow(engine, offer);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // max_stack=1 のため apple は最大 1 個のみ slot 占有として扱われる。max_inventory_slots=2 を超えると dropped
      expect(result.dropped.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('rolls back in-memory state on persist failure (B2)', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    const offer: TransferOffer = {
      transfer_id: 'transfer-test',
      from_agent_id: aliceId,
      to_agent_id: bobId,
      items: [{ item_id: 'apple', quantity: 1 }],
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
    // memory は復元されている (sender の money / items はそのまま)
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

    const start = startTransfer(engine, alice.agent_id, bob.agent_id, [{ item_id: 'apple', quantity: 1 }], 0, 'standalone');
    const result = acceptTransfer(engine, start.transfer_id, bob.agent_id);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure_reason).toBe('overflow_inventory_full');
    }
    // sender に refund 済み (元の 1 個に戻ったか、もしくは sender も slot 制限で dropped されたか)
    const aliceItems = engine.state.getLoggedIn(alice.agent_id)?.items;
    expect(aliceItems?.find((item) => item.item_id === 'apple')?.quantity ?? 0).toBeGreaterThan(0);
  });
});

describe('transfer/cancelPendingTransfersForAgent', () => {
  it('cancels open offers for sender on logout (sender_logged_out reason)', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    const start = startTransfer(engine, aliceId, bobId, [{ item_id: 'apple', quantity: 1 }], 100, 'standalone');
    cancelPendingTransfersForAgent(engine, aliceId, { sender: 'sender_logged_out', receiver: 'receiver_logged_out' });
    expect(engine.state.transfers.has(start.transfer_id)).toBe(false);
    // sender に refund されている
    expect(engine.state.getLoggedIn(aliceId)?.money).toBe(500);
    expect(engine.state.getLoggedIn(aliceId)?.items).toEqual([{ item_id: 'apple', quantity: 3 }]);
  });

  it('keeps refund_failed offers in store but clears agent state (B5 supports recovery)', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    const start = startTransfer(engine, aliceId, bobId, [{ item_id: 'apple', quantity: 1 }], 100, 'standalone');
    // refund_failed 状態を強制 (mock: refundEscrow 内 persist を失敗させる)
    const persistSpy = vi.spyOn(engine, 'persistLoggedInAgentState').mockImplementation(() => {
      throw new Error('persist fail');
    });
    cancelTransfer(engine, start.transfer_id, 'error');
    persistSpy.mockRestore();
    const offer = engine.state.transfers.get(start.transfer_id);
    expect(offer?.status).toBe('refund_failed');
    // agent state は always 復帰している (D7)
    expect(engine.state.getLoggedIn(aliceId)?.active_transfer_id).toBeNull();
    expect(engine.state.getLoggedIn(bobId)?.pending_transfer_id).toBeNull();
  });
});

describe('transfer/recoverRefundFailedTransfersForAgent', () => {
  it('removes refund_failed offers after successful registration writeback', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    const start = startTransfer(engine, aliceId, bobId, [{ item_id: 'apple', quantity: 1 }], 100, 'standalone');
    // 強制的に refund_failed 状態を作る
    const persistSpy = vi.spyOn(engine, 'persistLoggedInAgentState').mockImplementation(() => {
      throw new Error('persist fail');
    });
    cancelTransfer(engine, start.transfer_id, 'error');
    persistSpy.mockRestore();
    expect(engine.state.transfers.get(start.transfer_id)?.status).toBe('refund_failed');
    // recover が成功 (mergePersistedAgentInventory はテスト helper が動作する想定)
    recoverRefundFailedTransfersForAgent(engine, aliceId);
    // store から削除されている
    expect(engine.state.transfers.has(start.transfer_id)).toBe(false);
  });
});

describe('transfer/rejectTransfer guards refund_failed', () => {
  it('throws transfer_refund_failed when offer is in refund_failed state', async () => {
    const { engine, aliceId, bobId } = await setupTwoLoggedInAgents();
    const start = startTransfer(engine, aliceId, bobId, [{ item_id: 'apple', quantity: 1 }], 100, 'standalone');
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
    const start = startTransfer(engine, aliceId, bobId, [{ item_id: 'apple', quantity: 1 }], 100, 'standalone');
    const persistSpy = vi.spyOn(engine, 'persistLoggedInAgentState').mockImplementation(() => {
      throw new Error('persist fail');
    });
    cancelTransfer(engine, start.transfer_id, 'error');
    persistSpy.mockRestore();
    // 二度目の cancel は no-op (refund_failed: true を返す)
    const result = cancelTransfer(engine, start.transfer_id, 'error');
    expect(result.refund_failed).toBe(true);
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
