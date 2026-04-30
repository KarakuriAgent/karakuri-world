import { describe, expect, it } from 'vitest';

import { createTestWorld } from '../../helpers/test-world.js';

describe('execute paths clear last_used_item_id', () => {
  const ITEM_CONFIG = [
    { item_id: 'ticket', name: 'チケット', description: 'チケット', type: 'venue' as const, stackable: false },
    { item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food' as const, stackable: true },
  ];

  async function setupAlice() {
    const { engine } = createTestWorld({ config: { items: ITEM_CONFIG } });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setItems(alice.agent_id, [
      { item_id: 'ticket', quantity: 1 },
      { item_id: 'apple', quantity: 1 },
    ]);
    engine.state.setLastUsedItem(alice.agent_id, 'ticket');
    return { engine, alice };
  }

  it('clears last_used_item_id when move starts', async () => {
    const { engine, alice } = await setupAlice();

    engine.move(alice.agent_id, { target_node_id: '2-1' });

    expect(engine.state.getLoggedIn(alice.agent_id)?.last_used_item_id).toBeNull();
  });

  it('clears last_used_item_id when wait starts', async () => {
    const { engine, alice } = await setupAlice();

    engine.executeWait(alice.agent_id, { duration: 1 });

    expect(engine.state.getLoggedIn(alice.agent_id)?.last_used_item_id).toBeNull();
  });

  it('clears last_used_item_id when action starts', async () => {
    const { engine, alice } = await setupAlice();
    engine.state.setNode(alice.agent_id, '1-1');

    engine.executeAction(alice.agent_id, { action_id: 'greet-gatekeeper' });

    expect(engine.state.getLoggedIn(alice.agent_id)?.last_used_item_id).toBeNull();
  });

  it('clears last_used_item_id when a non-venue use-item starts', async () => {
    const { engine, alice } = await setupAlice();

    engine.useItem(alice.agent_id, { item_id: 'apple' });

    expect(engine.state.getLoggedIn(alice.agent_id)?.last_used_item_id).toBeNull();
  });

  it('clears last_used_item_id when a conversation starts', async () => {
    const { engine, alice } = await setupAlice();
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(bob.agent_id, '1-2');

    engine.startConversation(alice.agent_id, { target_agent_id: bob.agent_id, message: 'hello' });

    expect(engine.state.getLoggedIn(alice.agent_id)?.last_used_item_id).toBeNull();
  });

  it('clears last_used_item_id when a standalone transfer starts', async () => {
    const { engine, alice } = await setupAlice();
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(bob.agent_id, '1-2');

    engine.startTransfer(alice.agent_id, {
      target_agent_id: bob.agent_id,
      item: { item_id: 'apple', quantity: 1 },
    });

    expect(engine.state.getLoggedIn(alice.agent_id)?.last_used_item_id).toBeNull();
  });
});
