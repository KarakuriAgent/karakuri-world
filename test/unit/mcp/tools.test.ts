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
    const { engine } = createTestWorld({ withDiscord: false });
    const agent = engine.registerAgent({ agent_name: 'Alice' });

    const definitions = createMcpToolDefinitions(engine, agent.agent_id);

    expect(definitions.map((definition) => definition.name)).toEqual([
      'join',
      'leave',
      'move',
      'action',
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
    const { engine } = createTestWorld({ withDiscord: false });
    const agent = engine.registerAgent({ agent_name: 'Alice' });
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
        channel_id: '',
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

  it('authenticates bearer tokens for MCP requests', () => {
    const { engine } = createTestWorld({ withDiscord: false });
    const agent = engine.registerAgent({ agent_name: 'Alice' });

    expect(authenticateMcpRequest(engine, `Bearer ${agent.api_key}`)).toMatchObject({
      agent_id: agent.agent_id,
    });
    expect(() => authenticateMcpRequest(engine, 'Bearer invalid-token')).toThrow(WorldError);
  });
});
