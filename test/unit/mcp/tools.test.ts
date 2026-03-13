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
    const agent = engine.registerAgent({ agent_name: 'Alice', discord_bot_id: 'bot-alice' });

    const definitions = createMcpToolDefinitions(engine, agent.agent_id);

    expect(definitions.map((definition) => definition.name)).toEqual([
      'join',
      'leave',
      'move',
      'action',
      'wait',
      'conversation_start',
      'conversation_accept',
      'conversation_reject',
      'conversation_speak',
      'server_event_select',
      'get_available_actions',
      'get_perception',
      'get_map',
      'get_world_agents',
    ]);
  });

  it('returns tool errors for not_joined and successful JSON payloads after join', async () => {
    const { engine } = createTestWorld();
    const agent = engine.registerAgent({ agent_name: 'Alice', discord_bot_id: 'bot-alice' });
    const definitions = createMcpToolDefinitions(engine, agent.agent_id);
    const getPerception = definitions.find((definition) => definition.name === 'get_perception');
    const join = definitions.find((definition) => definition.name === 'join');

    expect(getPerception).toBeDefined();
    expect(join).toBeDefined();

    const notJoined = await getPerception!.execute({});
    expect(notJoined.isError).toBe(true);
    expect(parseToolText(notJoined)).toEqual(
      expect.objectContaining({
        error: 'not_joined',
        message: expect.stringContaining('Agent is not joined'),
      }),
    );

    const joined = await join!.execute({});
    const joinPayload = parseToolText(joined) as { channel_id: string; node_id: string };
    expect(joinPayload).toEqual(
      expect.objectContaining({
        channel_id: 'channel-Alice',
        node_id: expect.stringMatching(/3-[12]/),
      }),
    );

    const perception = await getPerception!.execute({});
    expect(parseToolText(perception)).toEqual(
      expect.objectContaining({
        current_node: expect.objectContaining({
          node_id: joinPayload.node_id,
        }),
      }),
    );
  });

  it('accepts target_node_id for move and returns movement responses', async () => {
    const { engine } = createTestWorld({
      config: {
        spawn: { nodes: ['3-1'] },
      },
    });
    const agent = engine.registerAgent({ agent_name: 'Alice', discord_bot_id: 'bot-alice' });
    const definitions = createMcpToolDefinitions(engine, agent.agent_id);
    const join = definitions.find((definition) => definition.name === 'join');
    const move = definitions.find((definition) => definition.name === 'move');

    expect(join).toBeDefined();
    expect(move).toBeDefined();
    expect(move!.inputSchema.safeParse({ target_node_id: '3-4' }).success).toBe(true);
    expect(move!.inputSchema.safeParse({ direction: 'east' }).success).toBe(false);

    await join!.execute({});
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
    const agent = engine.registerAgent({ agent_name: 'Alice', discord_bot_id: 'bot-alice' });
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
    const agent = engine.registerAgent({ agent_name: 'Alice', discord_bot_id: 'bot-alice' });

    expect(authenticateMcpRequest(engine, `Bearer ${agent.api_key}`)).toMatchObject({
      agent_id: agent.agent_id,
    });
    expect(() => authenticateMcpRequest(engine, 'Bearer invalid-token')).toThrow(WorldError);
  });
});
