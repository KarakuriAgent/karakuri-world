import { describe, expect, it } from 'vitest';

import { buildChoicesText } from '../../../src/domain/choices.js';
import { createTestWorld } from '../../helpers/test-world.js';

describe('choices domain', () => {
  it('builds action, movement, conversation, and info choices', async () => {
    const { engine } = createTestWorld();
    const alice = engine.registerAgent({ agent_name: 'alice', agent_label: 'Alice', discord_bot_id: 'bot-alice' });
    const bob = engine.registerAgent({ agent_name: 'bob', agent_label: 'Bob', discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);

    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).toContain('選択肢:');
    expect(text).toContain('- action: Greet the gatekeeper (action_id: greet-gatekeeper, 1秒) - Gatekeeper');
    expect(text).toContain('- move: ノードIDを指定して移動する (target_node_id: ノードID)');
    expect(text).toContain('- wait: その場で待機する (duration: 1〜6、10分単位)');
    expect(text).toContain(`- conversation_start: bob に話しかける (target_agent_id: ${bob.agent_id}, message: 最初のメッセージ)`);
    expect(text).not.toContain('get_perception');
    expect(text).not.toContain('get_available_actions');
    expect(text).toContain('- get_map: マップ全体の情報を取得する');
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
    const alice = engine.registerAgent({ agent_name: 'alice', agent_label: 'Alice', discord_bot_id: 'bot-alice' });
    const bob = engine.registerAgent({ agent_name: 'bob', agent_label: 'Bob', discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);

    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setPendingConversation(bob.agent_id, 'conversation-xyz');

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).not.toContain('conversation_start: bob');
  });

  it('omits unavailable conversation targets', async () => {
    const { engine } = createTestWorld();
    const alice = engine.registerAgent({ agent_name: 'alice', agent_label: 'Alice', discord_bot_id: 'bot-alice' });
    const bob = engine.registerAgent({ agent_name: 'bob', agent_label: 'Bob', discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);

    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '3-4');

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).not.toContain('conversation_start: bob');
  });

  it('omits state-conflicting commands while moving', async () => {
    const { engine } = createTestWorld();
    const alice = engine.registerAgent({ agent_name: 'alice', agent_label: 'Alice', discord_bot_id: 'bot-alice' });
    const bob = engine.registerAgent({ agent_name: 'bob', agent_label: 'Bob', discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);

    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setState(alice.agent_id, 'moving');

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).not.toContain('- action:');
    expect(text).not.toContain('- move:');
    expect(text).not.toContain('- wait:');
    expect(text).not.toContain('conversation_start: bob');
    expect(text).toContain('- get_map: マップ全体の情報を取得する');
    expect(text).toContain('- get_world_agents: 全エージェントの位置と状態を取得する');
  });

  it('omits state-conflicting commands while a conversation is pending', async () => {
    const { engine } = createTestWorld();
    const alice = engine.registerAgent({ agent_name: 'alice', agent_label: 'Alice', discord_bot_id: 'bot-alice' });
    const bob = engine.registerAgent({ agent_name: 'bob', agent_label: 'Bob', discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);

    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setPendingConversation(alice.agent_id, 'conversation-123');

    const text = buildChoicesText(engine, alice.agent_id);

    expect(text).not.toContain('- action:');
    expect(text).not.toContain('- move:');
    expect(text).not.toContain('- wait:');
    expect(text).not.toContain('conversation_start: bob');
    expect(text).toContain('- get_map: マップ全体の情報を取得する');
    expect(text).toContain('- get_world_agents: 全エージェントの位置と状態を取得する');
  });
});
