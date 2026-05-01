import { describe, expect, it } from 'vitest';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { authenticateMcpRequest } from '../../../src/mcp/server.js';
import { createMcpToolDefinitions } from '../../../src/mcp/tools.js';
import { WorldError } from '../../../src/types/api.js';
import { createTestWorld } from '../../helpers/test-world.js';

function parseToolText(result: CallToolResult): unknown {
  const textContent = result.content.find(
    (content): content is Extract<(typeof result.content)[number], { type: 'text' }> => content.type === 'text',
  );
  if (!textContent) {
    throw new Error('Expected text content.');
  }

  return JSON.parse(textContent.text);
}

describe('MCP tools', () => {
  it('exposes the documented tool set', async () => {
    const { engine } = createTestWorld();
    const agent = await engine.registerAgent({ discord_bot_id: 'bot-alice', });

    const definitions = createMcpToolDefinitions(engine, agent.agent_id);

    expect(definitions.map((definition) => definition.name)).toEqual([
      'move',
      'action',
      'use_item',
      'wait',
      'transfer',
      'accept_transfer',
      'reject_transfer',
      'conversation_start',
      'conversation_accept',
      'conversation_join',
      'conversation_stay',
      'conversation_leave',
      'conversation_reject',
      'conversation_speak',
      'end_conversation',
      'get_available_actions',
      'get_perception',
      'get_map',
      'get_world_agents',
      'get_status',
      'get_nearby_agents',
      'get_active_conversations',
      'get_event',
    ]);
  });

  it('returns tool errors for not_logged_in and successful JSON payloads after engine login', async () => {
    const { engine } = createTestWorld();
    const agent = await engine.registerAgent({ discord_bot_id: 'bot-alice', });
    const definitions = createMcpToolDefinitions(engine, agent.agent_id);
    const getPerception = definitions.find((definition) => definition.name === 'get_perception');

    expect(getPerception).toBeDefined();

    const notLoggedIn = await getPerception!.execute({});
    expect(notLoggedIn.isError).toBe(true);
    expect(parseToolText(notLoggedIn)).toEqual(
      expect.objectContaining({
        error: 'not_logged_in',
        message: expect.stringContaining('Agent is not logged in'),
      }),
    );

    const loginResponse = await engine.loginAgent(agent.agent_id);
    expect(loginResponse).toEqual(
      expect.objectContaining({
        channel_id: 'channel-alice',
        node_id: expect.stringMatching(/3-[12]/),
      }),
    );

    let requestedEventType: string | null = null;
    const unsubscribe = engine.eventBus.onAny((event) => {
      requestedEventType = event.type;
    });
    const perception = await getPerception!.execute({});
    unsubscribe();

    expect(parseToolText(perception)).toEqual({
      ok: true,
      message: '正常に受け付けました。結果が通知されるまで待機してください。',
    });
    expect(requestedEventType).toBe('perception_requested');
  });

  it.each([
    ['get_available_actions', 'available_actions_requested'],
    ['get_perception', 'perception_requested'],
    ['get_map', 'map_info_requested'],
    ['get_world_agents', 'world_agents_info_requested'],
    ['get_status', 'status_info_requested'],
    ['get_nearby_agents', 'nearby_agents_info_requested'],
    ['get_active_conversations', 'active_conversations_info_requested'],
  ] as const)('emits %s -> %s event', async (toolName, expectedEventType) => {
    const { engine } = createTestWorld();
    const agent = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(agent.agent_id);
    const tool = createMcpToolDefinitions(engine, agent.agent_id).find((definition) => definition.name === toolName);
    expect(tool).toBeDefined();

    let requestedEventType: string | null = null;
    const unsubscribe = engine.eventBus.onAny((event) => {
      requestedEventType = event.type;
    });
    await tool!.execute({});
    unsubscribe();

    expect(requestedEventType).toBe(expectedEventType);
  });

  it('returns 409 errors for state-conflicting or already-consumed info tools', async () => {
    const { engine } = createTestWorld();
    const agent = await engine.registerAgent({ discord_bot_id: 'bot-alice', });
    await engine.loginAgent(agent.agent_id);
    const definitions = createMcpToolDefinitions(engine, agent.agent_id);

    for (const name of [
      'get_available_actions',
      'get_perception',
      'get_map',
      'get_world_agents',
      'get_status',
      'get_nearby_agents',
      'get_active_conversations',
      'get_event',
    ]) {
      const tool = definitions.find((definition) => definition.name === name);
      expect(tool).toBeDefined();

      engine.state.setState(agent.agent_id, 'moving');
      const blocked = await tool!.execute({});
      expect(blocked.isError).toBe(true);
      expect(parseToolText(blocked)).toEqual(expect.objectContaining({ error: 'state_conflict' }));

      engine.state.setState(agent.agent_id, 'idle');
      const accepted = await tool!.execute({});
      expect(accepted.isError).not.toBe(true);

      const consumed = await tool!.execute({});
      expect(consumed.isError).toBe(true);
      expect(parseToolText(consumed)).toEqual(expect.objectContaining({ error: 'info_already_consumed' }));

      engine.state.clearExcludedInfoCommands(agent.agent_id);
    }
  });

  it('accepts target_node_id for move and returns movement responses', async () => {
    const { engine } = createTestWorld({
      config: {
        spawn: { nodes: ['3-1'] },
      },
    });
    const agent = await engine.registerAgent({ discord_bot_id: 'bot-alice', });
    const definitions = createMcpToolDefinitions(engine, agent.agent_id);
    const move = definitions.find((definition) => definition.name === 'move');

    expect(move).toBeDefined();
    expect(move!.inputSchema.safeParse({ target_node_id: '3-4' }).success).toBe(true);
    expect(move!.inputSchema.safeParse({ direction: 'east' }).success).toBe(false);

    await engine.loginAgent(agent.agent_id);
    const moved = await move!.execute({ target_node_id: '3-4' });

    expect(moved.isError).not.toBe(true);
    expect(parseToolText(moved)).toEqual(
      expect.objectContaining({
        from_node_id: '3-1',
        to_node_id: '3-4',
        arrives_at: expect.any(Number),
      }),
    );
  });

  it('returns tool errors for invalid move inputs', async () => {
    const { engine } = createTestWorld();
    const agent = await engine.registerAgent({ discord_bot_id: 'bot-alice', });
    const definitions = createMcpToolDefinitions(engine, agent.agent_id);
    const move = definitions.find((definition) => definition.name === 'move');

    expect(move).toBeDefined();

    const invalid = await move!.execute({ target_node_id: 'east' });
    expect(invalid.isError).toBe(true);
    expect(parseToolText(invalid)).toEqual(
      expect.objectContaining({
        error: 'invalid_request',
      }),
    );
  });

  it('accepts duration_minutes for action tool input', async () => {
    const { engine } = createTestWorld();
    const agent = await engine.registerAgent({ discord_bot_id: 'bot-alice', });
    const definitions = createMcpToolDefinitions(engine, agent.agent_id);
    const action = definitions.find((definition) => definition.name === 'action');

    expect(action).toBeDefined();
    expect(action!.inputSchema.safeParse({ action_id: 'long-nap', duration_minutes: 3 }).success).toBe(true);
    expect(action!.inputSchema.safeParse({ action_id: 'long-nap', duration_minutes: 0 }).success).toBe(false);
  });

  it('documents that actions missing money or items can still appear in choices', async () => {
    const { engine } = createTestWorld();
    const agent = await engine.registerAgent({ discord_bot_id: 'bot-alice', });
    const definitions = createMcpToolDefinitions(engine, agent.agent_id);
    const action = definitions.find((definition) => definition.name === 'action');

    expect(action).toBeDefined();
    expect(action!.description).toContain('所持金や必要アイテムが不足していても選択肢に表示されるが');
  });

  it('rejects transfer payloads that mix item and money via the MCP schema', async () => {
    const { engine } = createTestWorld();
    const agent = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const definitions = createMcpToolDefinitions(engine, agent.agent_id);
    const transfer = definitions.find((definition) => definition.name === 'transfer');
    expect(transfer).toBeDefined();
    expect(transfer!.inputSchema.safeParse({ target_agent_id: 'bot-bob', item: { item_id: 'apple', quantity: 1 } }).success).toBe(true);
    expect(transfer!.inputSchema.safeParse({ target_agent_id: 'bot-bob', money: 100 }).success).toBe(true);
    expect(transfer!.inputSchema.safeParse({ target_agent_id: 'bot-bob', item: { item_id: 'apple', quantity: 1 }, money: 100 }).success).toBe(false);
    expect(transfer!.inputSchema.safeParse({ target_agent_id: 'bot-bob' }).success).toBe(false);
  });

  it('executes transfer / accept_transfer / reject_transfer end-to-end through MCP tools', async () => {
    const { engine } = createTestWorld({
      config: {
        items: [{ item_id: 'apple', name: 'りんご', description: 'りんご', type: 'food', stackable: true }],
      },
    });
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    const bob = await engine.registerAgent({ discord_bot_id: 'bot-bob' });
    await engine.loginAgent(alice.agent_id);
    await engine.loginAgent(bob.agent_id);
    engine.state.setNode(alice.agent_id, '1-1');
    engine.state.setNode(bob.agent_id, '1-2');
    engine.state.setItems(alice.agent_id, [{ item_id: 'apple', quantity: 2 }]);

    const aliceDefs = createMcpToolDefinitions(engine, alice.agent_id);
    const bobDefs = createMcpToolDefinitions(engine, bob.agent_id);
    const transferTool = aliceDefs.find((definition) => definition.name === 'transfer')!;
    const acceptTransferTool = bobDefs.find((definition) => definition.name === 'accept_transfer')!;
    const rejectTransferTool = bobDefs.find((definition) => definition.name === 'reject_transfer')!;

    // 1) transfer 開始 (item 譲渡)
    const startResult = await transferTool.execute({ target_agent_id: bob.agent_id, item: { item_id: 'apple', quantity: 1 } });
    expect(startResult.isError).not.toBe(true);
    const startData = parseToolText(startResult) as { transfer_status: string; transfer_id: string };
    expect(startData.transfer_status).toBe('pending');
    expect(typeof startData.transfer_id).toBe('string');

    // 2) accept (receiver = Bob)
    const acceptResult = await acceptTransferTool.execute({});
    expect(acceptResult.isError).not.toBe(true);
    const acceptData = parseToolText(acceptResult) as { transfer_status: string };
    expect(acceptData.transfer_status).toBe('completed');
    expect(engine.state.getLoggedIn(bob.agent_id)?.items).toEqual([{ item_id: 'apple', quantity: 1 }]);

    // 3) もう一度 transfer 開始 → reject (receiver = Bob)
    await transferTool.execute({ target_agent_id: bob.agent_id, item: { item_id: 'apple', quantity: 1 } });
    const rejectResult = await rejectTransferTool.execute({});
    expect(rejectResult.isError).not.toBe(true);
    const rejectData = parseToolText(rejectResult) as { transfer_status: string };
    expect(rejectData.transfer_status).toBe('rejected');
    // sender に escrow が返却されている (apple x 1 が alice に戻る)
    expect(engine.state.getLoggedIn(alice.agent_id)?.items).toEqual([{ item_id: 'apple', quantity: 1 }]);
  });

  it('authenticates bearer tokens for MCP requests', async () => {
    const { engine } = createTestWorld();
    const agent = await engine.registerAgent({ discord_bot_id: 'bot-alice', });

    expect(authenticateMcpRequest(engine, `Bearer ${agent.api_key}`)).toMatchObject({
      agent_id: agent.agent_id,
    });
    expect(() => authenticateMcpRequest(engine, 'Bearer invalid-token')).toThrow(WorldError);
  });
});
