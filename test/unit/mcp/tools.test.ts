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
  it('exposes the documented tool set', () => {
    const { engine } = createTestWorld();
    const agent = engine.registerAgent({ agent_name: 'Alice', agent_label: 'Alice', discord_bot_id: 'bot-alice', });

    const definitions = createMcpToolDefinitions(engine, agent.agent_id);

    expect(definitions.map((definition) => definition.name)).toEqual([
      'move',
      'action',
      'wait',
      'conversation_start',
      'conversation_accept',
      'conversation_reject',
      'conversation_speak',
      'end_conversation',
      'server_event_select',
      'get_available_actions',
      'get_perception',
      'get_map',
      'get_world_agents',
    ]);
  });

  it('returns tool errors for not_logged_in and successful JSON payloads after engine login', async () => {
    const { engine } = createTestWorld();
    const agent = engine.registerAgent({ agent_name: 'Alice', agent_label: 'Alice', discord_bot_id: 'bot-alice', });
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
        channel_id: 'channel-Alice',
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

  it('accepts target_node_id for move and returns movement responses', async () => {
    const { engine } = createTestWorld({
      config: {
        spawn: { nodes: ['3-1'] },
      },
    });
    const agent = engine.registerAgent({ agent_name: 'Alice', agent_label: 'Alice', discord_bot_id: 'bot-alice', });
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
    const agent = engine.registerAgent({ agent_name: 'Alice', agent_label: 'Alice', discord_bot_id: 'bot-alice', });
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

  it('authenticates bearer tokens for MCP requests', () => {
    const { engine } = createTestWorld();
    const agent = engine.registerAgent({ agent_name: 'Alice', agent_label: 'Alice', discord_bot_id: 'bot-alice', });

    expect(authenticateMcpRequest(engine, `Bearer ${agent.api_key}`)).toMatchObject({
      agent_id: agent.agent_id,
    });
    expect(() => authenticateMcpRequest(engine, 'Bearer invalid-token')).toThrow(WorldError);
  });
});
