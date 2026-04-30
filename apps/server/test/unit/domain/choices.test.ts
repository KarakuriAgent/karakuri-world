import { describe, expect, it, vi } from 'vitest';

import { buildChoicesText } from '../../../src/domain/choices.js';
import { createTestWorld } from '../../helpers/test-world.js';

describe('choices domain', () => {
  it('builds action, movement, conversation, and info choices', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);

    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    // 両 transfer 系の選択肢を確認するため、alice に所持アイテムと所持金を持たせる。
    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 1 }]);
    engine.state.setMoney(alice.agent_id, 100);

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).toContain('選択肢:');
    expect(text).toContain('- action: Greet the gatekeeper (action_id: greet-gatekeeper, 1秒) - Gatekeeper');
    expect(text).toContain('- move: ノードIDを指定して移動する (target_node_id: ノードID)');
    expect(text).toContain('- wait: その場で待機する (duration: 1〜6、10分単位)');
    expect(text).toContain('- conversation_start: 隣接エージェントに話しかける (target_agent_id: ID, message: 最初のメッセージ)');
    expect(text).toContain('- transfer: 近くのエージェントにアイテム/お金を譲渡する (target_agent_id: ID, item: { item_id: ID, quantity: N } または money: 金額)');
    expect(text).toContain('- get_perception: 周囲の情報を取得する');
    expect(text).toContain('- get_available_actions: 現在位置で実行可能なアクションを取得する');
    expect(text).toContain('- get_map: マップ全体の情報を取得する');
    expect(text).toContain('- get_world_agents: 全エージェントの位置と状態を取得する');
    expect(text).toContain('- get_status: 自分の所持金・所持品・現在地を取得する');
    expect(text).toContain('- get_nearby_agents: 隣接エージェントの一覧を取得する');
    expect(text).toContain('- get_active_conversations: 参加可能な進行中の会話一覧を取得する');
  });

  it('can exclude only the requested info command from choices', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);

    const mapExcluded = buildChoicesText(engine, alice.agent_id, { excludeInfoCommands: ['get_map'] });
    expect(mapExcluded).not.toContain('- get_map: マップ全体の情報を取得する');
    expect(mapExcluded).toContain('- get_perception: 周囲の情報を取得する');
    expect(mapExcluded).toContain('- get_available_actions: 現在位置で実行可能なアクションを取得する');
    expect(mapExcluded).toContain('- get_world_agents: 全エージェントの位置と状態を取得する');

    const agentsExcluded = buildChoicesText(engine, alice.agent_id, { excludeInfoCommands: ['get_world_agents'] });
    expect(agentsExcluded).toContain('- get_perception: 周囲の情報を取得する');
    expect(agentsExcluded).toContain('- get_available_actions: 現在位置で実行可能なアクションを取得する');
    expect(agentsExcluded).toContain('- get_map: マップ全体の情報を取得する');
    expect(agentsExcluded).not.toContain('- get_world_agents: 全エージェントの位置と状態を取得する');
  });

  it('applies info-command exclusion together with forced action choices', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setState(alice.agent_id, 'in_action');

    const text = buildChoicesText(engine, alice.agent_id, {
      forceShowActions: true,
      excludeInfoCommands: ['get_map'],
    });

    expect(text).toContain('- action:');
    expect(text).toContain('- get_perception: 周囲の情報を取得する');
    expect(text).toContain('- get_available_actions: 現在位置で実行可能なアクションを取得する');
    expect(text).not.toContain('- get_map: マップ全体の情報を取得する');
    expect(text).toContain('- get_world_agents: 全エージェントの位置と状態を取得する');
  });

  it('merges stored info exclusions with explicit exclusions', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    engine.state.addExcludedInfoCommand(alice.agent_id, 'get_perception');

    const text = buildChoicesText(engine, alice.agent_id, { excludeInfoCommands: ['get_map'] });

    expect(text).not.toContain('- get_perception: 周囲の情報を取得する');
    expect(text).not.toContain('- get_map: マップ全体の情報を取得する');
    expect(text).toContain('- get_available_actions: 現在位置で実行可能なアクションを取得する');
    expect(text).toContain('- get_world_agents: 全エージェントの位置と状態を取得する');
  });

  it('throws not_logged_in for unknown agent', async () => {
    const { engine } = createTestWorld();

    expect(() => buildChoicesText(engine, 'non-existent')).toThrow(
      expect.objectContaining({ code: 'not_logged_in' }),
    );
  });

  it('excludes candidates with pending conversations', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);

    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setPendingConversation(bob.agent_id, 'conversation-xyz');

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).not.toContain('- conversation_start:');
  });

  it('omits unavailable conversation targets', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);

    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '3-4');

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).not.toContain('- conversation_start:');
  });

  it('omits state-conflicting commands while moving', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);

    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setState(alice.agent_id, 'moving');

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).not.toContain('- action:');
    expect(text).not.toContain('- move:');
    expect(text).not.toContain('- wait:');
    expect(text).not.toContain('- conversation_start:');
    expect(text).toBe('選択肢:\n');
  });

  it('omits state-conflicting commands while a conversation is pending', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);

    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setPendingConversation(alice.agent_id, 'conversation-123');

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).not.toContain('- action:');
    expect(text).not.toContain('- move:');
    expect(text).not.toContain('- wait:');
    expect(text).not.toContain('- conversation_start:');
    expect(text).toBe('選択肢:\n');
  });

  it.each(['in_action', 'in_conversation'] as const)(
    'suppresses conversation_start in forced choices while %s',
    async (state) => {
      const { engine } = createTestWorld();
      const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
      const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
      await engine.loginAgent(alice.agent_id);
      await engine.loginAgent(bob.agent_id);

      engine.state.setNode(alice.agent_id, '1-1');
      engine.state.setNode(bob.agent_id, '1-2');
      engine.state.setState(alice.agent_id, state);

      const text = buildChoicesText(engine, alice.agent_id, { forceShowActions: true });

      expect(text).toContain('- action:');
      expect(text).toContain('- move: ノードIDを指定して移動する (target_node_id: ノードID)');
      expect(text).toContain('- wait: その場で待機する (duration: 1〜6、10分単位)');
      expect(text).not.toContain('- conversation_start:');
      expect(text).toContain('- get_perception: 周囲の情報を取得する');
      expect(text).toContain('- get_available_actions: 現在位置で実行可能なアクションを取得する');
      expect(text).toContain('- get_map: マップ全体の情報を取得する');
      expect(text).toContain('- get_world_agents: 全エージェントの位置と状態を取得する');
    },
  );

  it('includes conversation_join in forced choices while in_action', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    const carol = await engine.registerAgent({ discord_bot_id: 'bot-carol' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await engine.loginAgent(carol.agent_id);

    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setNode(carol.agent_id, '1-2');
    engine.startConversation(alice.agent_id, {
      target_agent_id: bob.agent_id,
      message: 'Hello Bob',
    });
    engine.acceptConversation(bob.agent_id, { message: 'Hello Alice' });
    engine.state.setState(carol.agent_id, 'in_action');

    const text = buildChoicesText(engine, carol.agent_id, { forceShowActions: true });

    expect(text).toContain('- conversation_join: 進行中の会話に参加する (conversation_id: ID)');
  });

  it('keeps money- and item-gated actions visible in choices', async () => {
    const { engine } = createTestWorld({
      config: {
        economy: { initial_money: 100 },
        items: [{ item_id: 'flower', name: '花束', description: '花', type: 'general' as const, stackable: true }],
        map: {
          ...createTestWorld().config.map,
          npcs: [
            {
              npc_id: 'npc-gatekeeper',
              name: 'Gatekeeper',
              description: 'Watches the town gate.',
              node_id: '1-2',
              actions: [
                {
                  action_id: 'expensive-greeting',
                  name: 'Expensive greeting',
                  description: 'Offer a costly greeting.',
                  duration_ms: 1200,
                  cost_money: 500,
                },
                {
                  action_id: 'offer-flower',
                  name: 'Offer a flower',
                  description: 'Give flowers.',
                  duration_ms: 600,
                  required_items: [{ item_id: 'flower', quantity: 1 }],
                },
              ],
            },
          ],
        },
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).toContain('expensive-greeting');
    expect(text).toContain('offer-flower');
  });

  it('omits the last attempted action from choices', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setLastAction(alice.agent_id, 'greet-gatekeeper');

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).not.toContain('greet-gatekeeper');
  });

  it('does not consume rejected-action suppression while building choices text', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setLastRejectedAction(alice.agent_id, 'greet-gatekeeper');

    const firstText = buildChoicesText(engine, alice.agent_id);
    const secondText = buildChoicesText(engine, alice.agent_id);

    expect(firstText).not.toContain('greet-gatekeeper');
    expect(secondText).not.toContain('greet-gatekeeper');
    expect(engine.state.getLoggedIn(alice.agent_id)?.last_rejected_action_id).toBe('greet-gatekeeper');
  });

  it('keeps the single use-item row visible even when only the last used item remains', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'ticket', name: 'チケット', description: 'チケット', type: 'venue' as const, stackable: false }],
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    engine.state.setItems(alice.agent_id, [{ item_id: 'ticket', quantity: 1 }]);
    engine.state.setLastUsedItem(alice.agent_id, 'ticket');

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).toContain('- use-item: アイテムを使用する (item_id: 使用するアイテムのID)');
  });

  it('shows accept/reject choices for a pending transfer', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food' as const, stackable: true }],
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 1 }]);

    engine.startTransfer(alice.agent_id, {
      target_agent_id: bob.agent_id,
      item: { item_id: 'apple', quantity: 1 },
    });

    const text = buildChoicesText(engine, bob.agent_id);

    expect(text).toContain('- accept_transfer: alice からの譲渡を受け取る');
    expect(text).toContain('- reject_transfer: alice からの譲渡を断る');
  });

  it('omits info commands for an in_transfer agent even in forced choices', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food' as const, stackable: true }],
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 1 }]);

    engine.startTransfer(alice.agent_id, {
      target_agent_id: bob.agent_id,
      item: { item_id: 'apple', quantity: 1 },
    });

    const text = buildChoicesText(engine, bob.agent_id, { forceShowActions: true });

    expect(text).toContain('- accept_transfer: alice からの譲渡を受け取る');
    expect(text).not.toContain('- get_status:');
    expect(text).not.toContain('- get_perception:');
  });

  it('hides standalone transfer accept/reject choices during an active server-event window', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food' as const, stackable: true }],
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 1 }]);

    engine.startTransfer(alice.agent_id, {
      target_agent_id: bob.agent_id,
      item: { item_id: 'apple', quantity: 1 },
    });
    engine.state.setActiveServerEvent(bob.agent_id, 'server-event-1');

    const text = buildChoicesText(engine, bob.agent_id);

    expect(text).not.toContain('- accept_transfer:');
    expect(text).not.toContain('- reject_transfer:');
  });

  it('advertises standalone transfer to in_action sender during a server-event interrupt window (in_action allows transfer natively)', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 1 }]);
    engine.state.setMoney(alice.agent_id, 100);
    engine.state.setState(alice.agent_id, 'in_action');
    engine.state.setActiveServerEvent(alice.agent_id, 'server-event-1');

    const text = buildChoicesText(engine, alice.agent_id);

    // server-event window 関係なく in_action は transfer を発信できる仕様。
    expect(text).toContain('- transfer: 近くのエージェントにアイテム/お金を譲渡する (target_agent_id: ID, item: { item_id: ID, quantity: N } または money: 金額)');
    expect(text).toContain('- move: ノードIDを指定して移動する');
  });

  it('advertises standalone transfer to in_action sender without a server-event interrupt window', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 1 }]);
    engine.state.setMoney(alice.agent_id, 100);
    engine.state.setState(alice.agent_id, 'in_action');

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).toContain('- transfer: 近くのエージェントにアイテム/お金を譲渡する (target_agent_id: ID, item: { item_id: ID, quantity: N } または money: 金額)');
    expect(text).not.toContain('- move: ノードIDを指定して移動する');
    expect(text).not.toContain('- wait: その場で待機する');
    expect(text).not.toContain('- get_perception: 周囲の情報を取得する');
  });

  it('omits transfer choices entirely when sender has neither items nor money', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    // alice は所持アイテムなし・所持金 0 → 譲渡選択肢は一切出ない。
    expect(engine.state.getLoggedIn(alice.agent_id)?.items).toEqual([]);
    expect(engine.state.getLoggedIn(alice.agent_id)?.money).toBe(0);

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).not.toContain('- transfer:');
  });

  it('shows only money transfer when sender has money but no items', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setMoney(alice.agent_id, 100);

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).toContain('- transfer: 近くのエージェントにアイテム/お金を譲渡する (target_agent_id: ID, item: { item_id: ID, quantity: N } または money: 金額)');
  });

  it('shows only item part of transfer hint when sender has items but no money', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 1 }]);

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).toContain('- transfer: 近くのエージェントにアイテム/お金を譲渡する (target_agent_id: ID, item: { item_id: ID, quantity: N } または money: 金額)');
  });

  it('does not inline transferable item_ids in the transfer hint', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [
          { item_id: 'popcorn', name: 'ポップコーン', description: '映画館の定番', type: 'food' as const, stackable: true },
          { item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food' as const, stackable: true },
        ],
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setItems(alice.agent_id, [
      { item_id: 'popcorn', quantity: 3 },
      { item_id: 'apple', quantity: 2 },
    ]);

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).toContain('- transfer: 近くのエージェントにアイテム/お金を譲渡する (target_agent_id: ID, item: { item_id: ID, quantity: N } または money: 金額)');
    expect(text).not.toContain('apple or popcorn');
  });

  it('shows conversation transfer response guidance instead of standalone accept/reject choices', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const { engine } = createTestWorld({
        config: {
          items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food' as const, stackable: true }],
        },
      });
      const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
      const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
      await engine.loginAgent(alice.agent_id);
      await engine.loginAgent(bob.agent_id);
      engine.state.setNode(alice.agent_id, '1-1');
      engine.state.setNode(bob.agent_id, '1-2');
      engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 1 }]);

      engine.startConversation(alice.agent_id, {
        target_agent_id: bob.agent_id,
        message: 'hello',
      });
      engine.acceptConversation(bob.agent_id, { message: 'hi' });
      vi.advanceTimersByTime(500);
      engine.speak(alice.agent_id, {
        message: 'take this',
        next_speaker_agent_id: bob.agent_id,
        transfer: { item: { item_id: 'apple', quantity: 1 } },
      });

      const text = buildChoicesText(engine, bob.agent_id);

      expect(text).toContain('transfer_response: accept または reject');
      expect(text).not.toContain('- accept_transfer:');
      expect(text).not.toContain('- reject_transfer:');
    } finally {
      vi.useRealTimers();
    }
  });

  it('omits transfer when nearby candidate is in_transfer (other transfer in progress)', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food' as const, stackable: true }],
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    const carol = await engine.registerAgent({ discord_bot_id: 'bot-carol' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    await engine.loginAgent(carol.agent_id);

    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setNode(carol.agent_id, '1-2');
    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 1 }]);
    engine.state.setItems(bob.agent_id, [{ item_id: 'apple', quantity: 1 }]);

    engine.startTransfer(bob.agent_id, {
      target_agent_id: carol.agent_id,
      item: { item_id: 'apple', quantity: 1 },
    });

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).not.toContain('- transfer:');
    expect(text).not.toContain('- conversation_start:');
  });

  it('keeps conversation_start when target has pending transfer offer (in_transfer state via offer side-effect)', async () => {
    // pending_transfer を持つ in_action 候補は、conversation_start 候補に残るが transfer_candidates から落ちる仕様。
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food' as const, stackable: true }],
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);

    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 1 }]);
    // in_action + pending_transfer_id の組み合わせは startTransfer では作れないため直接 setter で組み立てる
    engine.state.setState(bob.agent_id, 'in_action');
    engine.state.setPendingTransfer(bob.agent_id, 'transfer-pending-1');

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).toContain('- conversation_start: 隣接エージェントに話しかける (target_agent_id: ID, message: 最初のメッセージ)');
    expect(text).not.toContain('- transfer:');
  });

  it('excludes transfer candidates that have a pending conversation', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food' as const, stackable: true }],
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);

    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 1 }]);
    engine.state.setPendingConversation(bob.agent_id, 'conversation-xyz');

    const text = buildChoicesText(engine, alice.agent_id);

    // pending_conversation_id を持つ候補は conversation_start / transfer 双方から落ちる
    expect(text).not.toContain('- conversation_start:');
    expect(text).not.toContain('- transfer:');
  });

  it('keeps use-item visible when another usable item remains', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [
          { item_id: 'ticket', name: 'チケット', description: 'チケット', type: 'venue' as const, stackable: false },
          { item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food' as const, stackable: true },
        ],
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    engine.state.setItems(alice.agent_id, [
      { item_id: 'ticket', quantity: 1 },
      { item_id: 'apple', quantity: 1 },
    ]);
    engine.state.setLastUsedItem(alice.agent_id, 'ticket');

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).toContain('- use-item: アイテムを使用する (item_id: 使用するアイテムのID)');
    expect(text).not.toContain('(item_id: ticket)');
  });
});
